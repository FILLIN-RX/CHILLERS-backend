import doodClient from './doodstream.client';

export const getAccountInfo = async () => {
  const { data } = await doodClient.get('/account/info');
  return data.result;
};

export const getAccountStats = async (last?: number, from?: string, to?: string) => {
  const params: Record<string, any> = {};
  if (last) params.last = last;
  if (from) params.from_date = from;
  if (to) params.to_date = to;
  const { data } = await doodClient.get('/account/stats', { params });
  return data.result;
};

export const getUploadServer = async () => {
  const { data } = await doodClient.get('/upload/server');
  return data.result;
};

export const remoteUploadAdd = async (url: string, fldId?: string, newTitle?: string) => {
  const params: Record<string, any> = { url };
  if (fldId) params.fld_id = fldId;
  if (newTitle) params.new_title = newTitle;
  const { data } = await doodClient.get('/upload/url', { params });
  return { fileCode: data.result.filecode, totalSlots: data.total_slots, usedSlots: data.used_slots };
};

export const remoteUploadList = async () => {
  const { data } = await doodClient.get('/urlupload/list');
  return data.result;
};

export const remoteUploadStatus = async (fileCode: string) => {
  const { data } = await doodClient.get('/urlupload/status', { params: { file_code: fileCode } });
  return data.result;
};

export const remoteUploadSlots = async () => {
  const { data } = await doodClient.get('/urlupload/slots');
  return { totalSlots: data.total_slots, usedSlots: data.used_slots };
};

export const remoteUploadActions = async (opts: {
  restartErrors?: boolean;
  clearErrors?: boolean;
  clearAll?: boolean;
  deleteCode?: string;
}) => {
  const params: Record<string, any> = {};
  if (opts.restartErrors) params.restart_errors = 1;
  if (opts.clearErrors) params.clear_errors = 1;
  if (opts.clearAll) params.clear_all = 1;
  if (opts.deleteCode) params.delete_code = opts.deleteCode;
  const { data } = await doodClient.get('/urlupload/actions', { params });
  return data.msg;
};

export const createFolder = async (name: string, parentId?: string) => {
  const params: Record<string, any> = { name };
  if (parentId) params.parent_id = parentId;
  const { data } = await doodClient.get('/folder/create', { params });
  return data.result;
};

export const renameFolder = async (fldId: string, name: string) => {
  const { data } = await doodClient.get('/folder/rename', { params: { fld_id: fldId, name } });
  return data.result;
};

export const listFolders = async (fldId: string = '0', onlyFolders?: boolean) => {
  const params: Record<string, any> = { fld_id: fldId };
  if (onlyFolders) params.only_folders = 1;
  const { data } = await doodClient.get('/folder/list', { params });
  return data.result;
};

export const listFiles = async (opts: {
  page?: number;
  perPage?: number;
  fldId?: string;
  created?: string;
} = {}) => {
  const params: Record<string, any> = {};
  if (opts.page) params.page = opts.page;
  if (opts.perPage) params.per_page = opts.perPage;
  if (opts.fldId) params.fld_id = opts.fldId;
  if (opts.created) params.created = opts.created;
  const { data } = await doodClient.get('/file/list', { params });
  return data.result;
};

export const getFileInfo = async (fileCode: string) => {
  const { data } = await doodClient.get('/file/info', { params: { file_code: fileCode } });
  return data.result;
};

export const checkFileStatus = async (fileCode: string) => {
  const { data } = await doodClient.get('/file/check', { params: { file_code: fileCode } });
  return data.result;
};

export const getFileImage = async (fileCode: string) => {
  const { data } = await doodClient.get('/file/image', { params: { file_code: fileCode } });
  return data.result;
};

export const getDirectDownloadUrl = async (fileCode: string) => {
  const { data } = await doodClient.get('/file/dl', { params: { file_code: fileCode } });
  return data.result as string;
};

export const getFileDownloadUrl = async (fileCode: string): Promise<string | null> => {
  // Tier 1: /file/info → protected_dl
  try {
    const { data } = await doodClient.get('/file/info', { params: { file_code: fileCode } });
    const info = data.result?.[0];
    if (info?.protected_dl) {
      return `https://doodstream.com${info.protected_dl}`;
    }
  } catch {
    // fall through
  }

  // Tier 2: /file/clone → download_url
  try {
    const { data } = await doodClient.get('/file/clone', { params: { file_code: fileCode } });
    if (data.result?.download_url) return data.result.download_url;
    if (data.result?.protected_download) return data.result.protected_download;
  } catch {
    // fall through
  }

  return null;
};

export const renameFile = async (fileCode: string, title: string) => {
  const { data } = await doodClient.get('/file/rename', { params: { file_code: fileCode, title } });
  return data.result;
};

export const moveFile = async (fileCode: string, fldId: string) => {
  const { data } = await doodClient.get('/file/move', { params: { file_code: fileCode, fld_id: fldId } });
  return data.result;
};

export const searchFiles = async (term: string) => {
  const { data } = await doodClient.get('/search/videos', { params: { search_term: term } });
  return data.result;
};

export const cloneFile = async (fileCode: string, fldId?: string) => {
  const params: Record<string, any> = { file_code: fileCode };
  if (fldId) params.fld_id = fldId;
  const { data } = await doodClient.get('/file/clone', { params });
  return data.result;
};

export const getDmcaList = async (page?: number, perPage?: number) => {
  const params: Record<string, any> = {};
  if (page) params.page = page;
  if (perPage) params.per_page = perPage;
  const { data } = await doodClient.get('/dmca/list', { params });
  return data.result;
};
