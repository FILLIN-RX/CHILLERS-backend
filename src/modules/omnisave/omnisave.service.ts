import axios from 'axios';
import crypto from 'crypto';

const API_BASE_URL = 'https://h5-api.aoneroom.com';
const SITE_DOMAIN = 'videodownloader.site';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface OmniSaveItem {
  subjectId: string;
  subjectType: number; // 1 = Movie, 2 = Series/Anime
  title: string;
  description: string;
  releaseDate: string;
  genre: string;
  coverUrl: string;
  imdbRating: string;
  subtitles: string;
  hasResource: boolean;
  detailPath: string;
  corner?: string;
  season?: number;
}

export interface OmniSaveDownloadLink {
  id: string;
  format: string;
  url: string;
  resolution: number;
  size: number;
  duration: number;
  codecName: string;
  vipLocked: boolean;
}

export interface OmniSaveCaption {
  language: string;
  url: string;
  label: string;
}

export interface OmniSaveEpisodeResult {
  downloads: OmniSaveDownloadLink[];
  captions: OmniSaveCaption[];
  hasResource: boolean;
  vipLocked: boolean;
}

/**
 * Génère le token d'authentification dynamique requis par l'API
 */
export function generateClientToken(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const reversed = String(timestamp).split('').reverse().join('');
  const md5Hash = crypto.createHash('md5').update(reversed).digest('hex');
  return `${timestamp},${md5Hash}`;
}

/**
 * En-têtes standards pour dialoguer avec l'API
 */
export function getApiHeaders(lang = 'en') {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Client-Token': generateClientToken(),
    'X-Site-Domain': SITE_DOMAIN,
    'X-Source': 'downloader',
    'X-Request-Lang': lang,
    'X-Client-Info': JSON.stringify({ timezone: 'UTC' }),
    'X-Caller-Source': 'node-frontend',
    'User-Agent': USER_AGENT,
    'Origin': `https://${SITE_DOMAIN}`,
    'Referer': `https://${SITE_DOMAIN}/`
  };
}

/**
 * Recherche un média (film, série, animé) par mot-clé
 */
export async function searchOmniSave(
  keyword: string,
  page = 1,
  perPage = 10,
  lang = 'en'
): Promise<{ items: OmniSaveItem[]; totalCount: number; hasMore: boolean }> {
  try {
    const response = await axios.post(
      `${API_BASE_URL}/wefeed-h5api-bff/subject/search`,
      {
        keyword: keyword.trim(),
        page,
        perPage
      },
      {
        headers: getApiHeaders(lang),
        timeout: 12000
      }
    );

    if (response.data?.code !== 0 || !response.data?.data) {
      return { items: [], totalCount: 0, hasMore: false };
    }

    const { items = [], pager } = response.data.data;
    const formattedItems: OmniSaveItem[] = items.map((item: any) => ({
      subjectId: item.subjectId,
      subjectType: item.subjectType,
      title: item.title,
      description: item.description || '',
      releaseDate: item.releaseDate || '',
      genre: item.genre || '',
      coverUrl: item.cover?.url || '',
      imdbRating: item.imdbRatingValue || '',
      subtitles: item.subtitles || '',
      hasResource: !!item.hasResource,
      detailPath: item.detailPath || '',
      corner: item.corner || '',
      season: item.season || 0
    }));

    return {
      items: formattedItems,
      totalCount: Number(pager?.totalCount || items.length),
      hasMore: !!pager?.hasMore
    };
  } catch (error: any) {
    console.error(`[OmniSave] Erreur recherche "${keyword}":`, error.message);
    return { items: [], totalCount: 0, hasMore: false };
  }
}

/**
 * Récupère les détails et épisodes disponibles d'un média
 */
export async function getOmniSaveDetail(subjectId: string, detailPath: string, lang = 'en'): Promise<any> {
  try {
    const response = await axios.get(
      `${API_BASE_URL}/wefeed-h5api-bff/detail`,
      {
        params: { subjectId, detailPath },
        headers: getApiHeaders(lang),
        timeout: 12000
      }
    );

    if (response.data?.code !== 0 || !response.data?.data) {
      return null;
    }

    return response.data.data;
  } catch (error: any) {
    console.error(`[OmniSave] Erreur détails (${subjectId}):`, error.message);
    return null;
  }
}

/**
 * Récupère les liens directs MP4 et sous-titres pour une saison et un épisode donnés
 */
export async function getOmniSaveDownloads(
  subjectId: string,
  detailPath: string,
  season = 1,
  episode = 1,
  lang = 'en'
): Promise<OmniSaveEpisodeResult> {
  try {
    const response = await axios.get(
      `${API_BASE_URL}/wefeed-h5api-bff/subject/download`,
      {
        params: {
          subjectId,
          detailPath,
          se: season,
          ep: episode
        },
        headers: getApiHeaders(lang),
        timeout: 12000
      }
    );

    if (response.data?.code !== 0 || !response.data?.data) {
      return { downloads: [], captions: [], hasResource: false, vipLocked: false };
    }

    const data = response.data.data;
    const downloads: OmniSaveDownloadLink[] = (data.downloads || []).map((dl: any) => ({
      id: dl.id,
      format: dl.format || 'MP4',
      url: dl.url,
      resolution: Number(dl.resolution || 0),
      size: Number(dl.size || 0),
      duration: Number(dl.duration || 0),
      codecName: dl.codecName || 'h264',
      vipLocked: !!(dl.vipLocked || dl.vip_locked)
    }));

    const captions: OmniSaveCaption[] = (data.captions || []).map((cap: any) => ({
      language: cap.language || cap.lang,
      url: cap.url,
      label: cap.label || cap.language
    }));

    return {
      downloads,
      captions,
      hasResource: !!data.hasResource,
      vipLocked: !!data.vipLocked
    };
  } catch (error: any) {
    console.error(`[OmniSave] Erreur downloads (${subjectId} S${season}E${episode}):`, error.message);
    return { downloads: [], captions: [], hasResource: false, vipLocked: false };
  }
}
