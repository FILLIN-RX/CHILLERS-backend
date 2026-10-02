export interface UqloadAccountInfo {
  files_total: string;
  storage_left: number;
  login: string;
  email: string;
  premium_expire: string;
  balance: string;
  premium: number;
  storage_used: string;
}

export interface UqloadFileInfo {
  file_code: string;
  file_title: string;
  file_length: string;
  file_views: string;
  file_views_full?: string;
  file_created: string;
  file_last_download?: string;
  file_public: string;
  file_adult: string;
  file_premium_only?: string;
  canplay: number;
  status: number;
  player_img: string;
  cat_id?: string;
  tags?: string;
}

export interface UqloadFileListItem {
  thumbnail: string;
  link: string;
  file_code: string;
  canplay: number;
  length: string;
  views: string;
  uploaded: string;
  public: string;
  fld_id: string;
  title: string;
}

export interface UqloadFileListResult {
  files: UqloadFileListItem[];
  results_total: number;
  pages: number;
  results: number;
}

export interface UqloadQuality {
  url: string;
  name: string;
  size: string;
}

export interface UqloadDirectLinkResult {
  versions: UqloadQuality[];
  file_length: string;
  player_img: string;
  hls_direct?: string;
}

export interface BatchResult {
  total: number;
  success: number;
  failed: number;
  errors: string[];
  duration: number;
  remaining: number;
}
