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

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async get<T>(endpoint: string, params: Record<string, any> = {}): Promise<UqloadApiResponse<T>> {
    const { data } = await axios.get(`${API_BASE}${endpoint}`, {
      params: { key: this.apiKey, ...params },
      timeout: 30000,
    });
    return data;
  }

  async getAccountInfo() {
    return this.get<UqloadAccountInfo>('/account/info');
  }

  async uploadByUrl(videoUrl: string, title?: string): Promise<string> {
    const params: Record<string, any> = { url: videoUrl };
    if (title) params.file_title = title;
    const res = await this.get<{ filecode: string }>('/upload/url', params);
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
