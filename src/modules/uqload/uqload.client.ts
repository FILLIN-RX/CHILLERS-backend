import axios from 'axios';
import { UqloadAccountInfo, UqloadFileInfo, UqloadDirectLinkResult } from './uqload.types';

type UqloadApiResponse<T> = {
  msg: string;
  server_time: string;
  status: number;
  result: T;
};

const API_BASE = 'https://uqload.is/api';

export class UqloadClient {
  private apiKey: string;
  private static lastCallTime = 0;
  private static readonly MIN_INTERVAL_MS = 650; // Garantit max ~90 req/min

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - UqloadClient.lastCallTime;
    if (elapsed < UqloadClient.MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, UqloadClient.MIN_INTERVAL_MS - elapsed));
    }
    UqloadClient.lastCallTime = Date.now();
  }

  private async get<T>(endpoint: string, params: Record<string, any> = {}, retryCount = 0): Promise<UqloadApiResponse<T>> {
    await this.throttle();
    try {
      const { data } = await axios.get(`${API_BASE}${endpoint}`, {
        params: { key: this.apiKey, ...params },
        timeout: 30000,
      });

      if (data?.msg && typeof data.msg === 'string' && data.msg.toLowerCase().includes('limit reached')) {
        if (retryCount < 3) {
          console.log(`[UqloadClient] ⏳ Limite de 100 req/min Uqload atteinte. Pause de 22s avant nouvel essai (${retryCount + 1}/3)...`);
          await new Promise(r => setTimeout(r, 22000));
          return this.get<T>(endpoint, params, retryCount + 1);
        }
      }

      return data;
    } catch (err: any) {
      if ((err?.response?.status === 429 || err?.message?.includes('429')) && retryCount < 3) {
        console.log(`[UqloadClient] ⏳ HTTP 429 Rate limit Uqload. Pause de 22s avant nouvel essai (${retryCount + 1}/3)...`);
        await new Promise(r => setTimeout(r, 22000));
        return this.get<T>(endpoint, params, retryCount + 1);
      }
      throw err;
    }
  }

  async getAccountInfo() {
    return this.get<UqloadAccountInfo>('/account/info');
  }

  async uploadByUrl(videoUrl: string, title?: string): Promise<string> {
    const params: Record<string, any> = { url: videoUrl };
    if (title) params.file_title = title;
    const res = await this.get<{ filecode: string }>('/upload/url', params);
    if (!res.result) {
      throw new Error(`Uqload upload failed: ${res.msg} (status=${res.status})`);
    }
    return res.result.filecode;
  }

  async getDirectLink(fileCode: string, hls?: boolean): Promise<UqloadApiResponse<UqloadDirectLinkResult>> {
    const params: Record<string, any> = { file_code: fileCode };
    if (hls) params.hls = 1;
    return this.get<UqloadDirectLinkResult>('/file/direct_link', params);
  }

  async getFileInfo(fileCode: string) {
    return this.get<UqloadFileInfo[]>('/file/info', { file_code: fileCode });
  }

  async editFile(fileCode: string, title?: string) {
    const params: Record<string, any> = { file_code: fileCode };
    if (title) params.file_title = title;
    return this.get('/file/edit', params);
  }

  async waitForFileReady(fileCode: string, maxRetries = 30, interval = 3000): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const info = await this.getFileInfo(fileCode);
        if (info.result && info.result.length > 0 && info.result[0].status === 200) {
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }
    return false;
  }

  async uploadByUrlAndGetLink(videoUrl: string, title?: string): Promise<{ fileCode: string; directLink: UqloadDirectLinkResult | null }> {
    const fileCode = await this.uploadByUrl(videoUrl, title);
    const ready = await this.waitForFileReady(fileCode);
    if (!ready) {
      console.log(`[Uqload] Fichier pas prêt après 90s: ${fileCode}`);
      return { fileCode, directLink: null };
    }
    const dlResult = await this.getDirectLink(fileCode);
    return { fileCode, directLink: dlResult.result };
  }

  async uploadByUrlAsync(videoUrl: string, title?: string): Promise<string> {
    return this.uploadByUrl(videoUrl, title);
  }
}
