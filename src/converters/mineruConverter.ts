import { App, Notice, TFile, requestUrl, RequestUrlParam } from 'obsidian';
import { MarkerSettings } from '../settings';
import { BaseConverter, ConversionResult } from '../converter';
import { checkForExistingFiles, deleteOriginalFile } from '../utils/fileUtils';
import { ConverterSettingDefinition } from '../utils/converterSettingsUtils';
import JSZip from 'jszip';

const BASE_URL = 'https://mineru.net';

interface BatchUrlResponse {
  code: number;
  msg: string;
  data: {
    batch_id: string;
    file_urls: string[];
  };
}

interface ExtractResult {
  file_name: string;
  state: string;
  err_msg: string;
  full_zip_url?: string;
  extract_progress?: {
    extracted_pages: number;
    total_pages: number;
    start_time: string;
  };
}

interface BatchResultResponse {
  code: number;
  msg: string;
  data: {
    batch_id: string;
    extract_result: ExtractResult[];
  };
}

export class MinerUConverter extends BaseConverter {
  async convert(
    app: App,
    settings: MarkerSettings,
    file: TFile
  ): Promise<boolean> {
    const folderPath = await this.prepareConversion(settings, file);
    if (!folderPath) return false;

    if (
      (settings.extractContent === 'images' ||
        settings.extractContent === 'all') &&
      !(await checkForExistingFiles(app, folderPath))
    ) {
      return true;
    }

    if (!settings.mineruApiKey) {
      new Notice('Error: MinerU API key is not configured');
      return false;
    }

    new Notice('Uploading file to MinerU...', 3000);

    try {
      const fileContent = await app.vault.readBinary(file);

      // Step 1: Request an upload URL
      const batchData = await this.requestUploadUrl(
        settings,
        file.name
      );

      // Step 2: Upload file to the signed URL
      new Notice('Processing with MinerU API...', 5000);
      await this.uploadFile(batchData.file_urls[0], fileContent);

      // Step 3: Poll for results
      const extractResult = await this.pollBatchResult(
        settings,
        batchData.batch_id
      );

      if (!extractResult || extractResult.state !== 'done') {
        new Notice(
          `MinerU conversion failed: ${extractResult?.err_msg || 'Unknown error'}`
        );
        return false;
      }

      // Step 4: Download and extract the ZIP
      new Notice('Downloading results...', 3000);
      const conversionResult = await this.downloadAndExtractZip(
        extractResult.full_zip_url!,
        settings.extractContent
      );

      if (!conversionResult.success) {
        new Notice(`Failed to extract results: ${conversionResult.error}`);
        return false;
      }

      // Step 5: Write files to vault
      await this.processConversionResult(
        app,
        settings,
        conversionResult,
        folderPath,
        file
      );

      if (settings.deleteOriginal) {
        await deleteOriginalFile(app, file);
      }

      new Notice('MinerU conversion completed successfully');
      return true;
    } catch (error: any) {
      console.error('MinerU conversion error:', error.message, error.stack);
      new Notice(
        `MinerU conversion failed: ${error.message || 'Network or server error'}`
      );
      return false;
    }
  }

  private async requestUploadUrl(
    settings: MarkerSettings,
    fileName: string
  ): Promise<BatchUrlResponse['data']> {
    const data = {
      files: [{ name: fileName }],
      model_version: settings.mineruModel || 'vlm',
      is_ocr: settings.mineruEnableOCR ?? false,
      enable_formula: settings.mineruEnableFormula ?? true,
      enable_table: settings.mineruEnableTable ?? true,
      language: settings.mineruLanguage || 'en',
    };

    const response = await requestUrl({
      url: `${BASE_URL}/api/v4/file-urls/batch`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.mineruApiKey}`,
      },
      body: JSON.stringify(data),
      throw: false,
    });

    const result: BatchUrlResponse = response.json;

    if (result.code !== 0 || !result.data?.file_urls?.length) {
      throw new Error(
        `Failed to get upload URL: ${result.msg || 'Unknown error'}`
      );
    }

    return result.data;
  }

  private async uploadFile(
    url: string,
    fileContent: ArrayBuffer
  ): Promise<void> {
    const response = await requestUrl({
      url,
      method: 'PUT',
      body: fileContent,
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(
        `Failed to upload file: HTTP ${response.status}`
      );
    }
  }

  private async pollBatchResult(
    settings: MarkerSettings,
    batchId: string
  ): Promise<ExtractResult | null> {
    const maxRetries = 300;
    let notifiedProgress = false;

    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const response = await requestUrl({
        url: `${BASE_URL}/api/v4/extract-results/batch/${batchId}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${settings.mineruApiKey}`,
        },
        throw: false,
      });

      if (response.status !== 200) continue;

      const result: BatchResultResponse = response.json;
      if (result.code !== 0 || !result.data?.extract_result?.length) continue;

      const extractResult = result.data.extract_result[0];

      if (extractResult.state === 'done') {
        return extractResult;
      }

      if (extractResult.state === 'failed') {
        return extractResult;
      }

      // Show progress every 10 polls
      if (i % 10 === 0 && extractResult.extract_progress) {
        notifiedProgress = true;
        new Notice(
          `MinerU: ${extractResult.extract_progress.extracted_pages}/${extractResult.extract_progress.total_pages} pages`
        );
      }
    }

    throw new Error('MinerU conversion timed out');
  }

  private async downloadAndExtractZip(
    zipUrl: string,
    extractContent: string
  ): Promise<ConversionResult> {
    const response = await requestUrl({
      url: zipUrl,
      method: 'GET',
      throw: false,
    });

    if (response.status !== 200) {
      return {
        success: false,
        error: `Failed to download result ZIP: HTTP ${response.status}`,
      };
    }

    const zip = await JSZip.loadAsync(response.arrayBuffer);

    // Find and read full.md
    const mdFile = zip.file('full.md');
    if (!mdFile) {
      return {
        success: false,
        error: 'ZIP archive missing full.md',
      };
    }

    let markdown = extractContent !== 'images'
      ? await mdFile.async('string')
      : '';

    // Extract images from the ZIP
    const images: { [key: string]: string } = {};
    if (extractContent !== 'text') {
      const imageFiles = Object.keys(zip.files).filter((name) =>
        /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
      );

      for (const imgPath of imageFiles) {
        const imgFile = zip.file(imgPath);
        if (!imgFile) continue;

        const base64 = await imgFile.async('base64');
        // Flatten: strip directory prefix, keep only filename
        const flatName = imgPath.split('/').pop() || imgPath;
        images[flatName] = base64;

        // Rewrite markdown references from subdir path to flat path
        if (imgPath !== flatName && markdown) {
          const escaped = imgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          markdown = markdown.replace(new RegExp(escaped, 'g'), flatName);
        }
      }
    }

    return {
      success: true,
      markdown,
      images,
      metadata: { processor: 'mineru-v4' },
    };
  }

  async testConnection(
    settings: MarkerSettings,
    silent?: boolean
  ): Promise<boolean> {
    if (!settings.mineruApiKey) {
      if (!silent) new Notice('Error: MinerU API key is not configured');
      return false;
    }

    try {
      // Use the batch URL request as a connection test (with 0 files just to validate auth)
      const response = await requestUrl({
        url: `${BASE_URL}/api/v4/file-urls/batch`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.mineruApiKey}`,
        },
        body: JSON.stringify({
          files: [{ name: '_connection_test_.pdf' }],
        }),
        throw: false,
      });

      const result = response.json as BatchUrlResponse;
      // code 0 means auth succeeded (even if no file uploaded)
      if (result.code === 0) {
        if (!silent) new Notice('MinerU connection successful!');
        return true;
      }

      if (!silent) {
        new Notice(`MinerU connection failed: ${result.msg || 'Unknown error'}`);
      }
      return false;
    } catch (error: any) {
      if (!silent) {
        new Notice(`MinerU connection failed: ${error.message}`);
      }
      console.error('MinerU connection error:', error);
      return false;
    }
  }

  getConverterSettings(): ConverterSettingDefinition[] {
    return [
      {
        id: 'mineruApiKey',
        name: 'API Token',
        description:
          'Apply at https://mineru.net/apiManage/docs and paste your API token',
        type: 'text',
        placeholder: 'API Token',
        defaultValue: '',
        buttonText: 'Test connection',
        buttonAction: async (app, settings) => {
          await this.testConnection(settings, false);
        },
      },
      {
        id: 'mineruModel',
        name: 'Model version',
        description:
          'vlm (recommended): vision language model. pipeline: traditional pipeline. MinerU-HTML: for HTML files.',
        type: 'dropdown',
        defaultValue: 'vlm',
        options: [
          { value: 'vlm', label: 'vlm (recommended)' },
          { value: 'pipeline', label: 'pipeline' },
          { value: 'MinerU-HTML', label: 'MinerU-HTML' },
        ],
      },
      {
        id: 'mineruLanguage',
        name: 'Document language',
        description:
          'Specify the document language for better OCR accuracy',
        type: 'dropdown',
        defaultValue: 'en',
        options: [
          { value: 'en', label: 'English' },
          { value: 'ch', label: 'Chinese' },
          { value: 'ja', label: 'Japanese' },
          { value: 'ko', label: 'Korean' },
          { value: 'fr', label: 'French' },
          { value: 'de', label: 'German' },
          { value: 'es', label: 'Spanish' },
        ],
      },
      {
        id: 'mineruEnableOCR',
        name: 'Enable OCR',
        description: 'Enable OCR for scanned PDFs (pipeline/vlm only)',
        type: 'toggle',
        defaultValue: false,
      },
      {
        id: 'mineruEnableFormula',
        name: 'Enable formula detection',
        description: 'Extract mathematical formulas (pipeline/vlm only)',
        type: 'toggle',
        defaultValue: true,
      },
      {
        id: 'mineruEnableTable',
        name: 'Enable table detection',
        description: 'Extract table structures (pipeline/vlm only)',
        type: 'toggle',
        defaultValue: true,
      },
    ];
  }
}