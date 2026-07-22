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
  file_created: string;
  file_public: string;
  file_adult: string;
  canplay: number;
  status: number;
  player_img: string;
  tags?: string;
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
