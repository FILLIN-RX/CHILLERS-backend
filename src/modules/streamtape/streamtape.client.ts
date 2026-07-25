import axios from 'axios';

const BASE_URL = 'https://api.streamtape.com';

export class StreamtapeClient {
  private login: string;
  private key: string;

  constructor(login: string, key: string) {
    this.login = login;
    this.key = key;
  }

  private async request<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    const response = await axios.get(`${BASE_URL}${endpoint}`, {
      params: {
        login: this.login,
        key: this.key,
        ...params,
      },
    });

    if (response.data.status !== 200) {
      throw new Error(`Streamtape API Error: ${response.data.msg}`);
    }

    return response.data.result;
  }

  async getAccountInfo() {
    return this.request('/account/info');
  }

  async getDownloadTicket(fileId: string) {
    return this.request('/file/dlticket', { file: fileId });
  }

  async getDownloadLink(fileId: string, ticket: string) {
    // Note: This endpoint doesn't require login/key based on docs
    const response = await axios.get(`${BASE_URL}/file/dl`, {
      params: { file: fileId, ticket },
    });
    if (response.data.status !== 200) {
      throw new Error(`Streamtape API Error: ${response.data.msg}`);
    }
    return response.data.result;
  }

  async getFileInfo(fileIds: string[]) {
    return this.request('/file/info', { file: fileIds.join(',') });
  }

  async addRemoteUpload(url: string, folderId?: string, name?: string) {
    return this.request('/remotedl/add', { url, folder: folderId, name });
  }

  async getRemoteUploadStatus(id: string) {
    return this.request('/remotedl/status', { id });
  }

  async listFolder(folderId?: string) {
    return this.request('/file/listfolder', { folder: folderId });
  }
}
