/**
 * opensubtitles.service.ts — client API OpenSubtitles v2 (REST).
 *
 * - Login (token mis en cache, rafraîchi automatiquement sur 401)
 * - Recherche par titre (+ année / saison-épisode)
 * - Téléchargement d'un fichier .srt (cache mémoire 2h)
 *
 * Note P2P : le hash OpenSubtitles correspond au hash SHA1 du fichier vidéo
 * complet, inutilisable pour du streaming torrent → recherche par titre.
 */

import axios from 'axios';
import { OPENSUBTITLES_USER, OPENSUBTITLES_PASS, isOpenSubtitlesConfigured } from './opensubtitles.config';

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Chillers/1.0 (https://github.com/Chillers)';

const TOKEN_TTL_MS = 8 * 60 * 1000; // jetons valides ~10 min côté API
const SEARCH_TTL_MS = 30 * 60 * 1000;
const FILE_TTL_MS = 2 * 60 * 60 * 1000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let tokenPromise: Promise<string> | null = null;

const searchCache = new Map<string, { at: number; data: SubtitleSearchResult[] }>();
const fileCache = new Map<string, { at: number; format: string; buffer: Buffer }>();

export interface SubtitleSearchResult {
  fileId: number;
  lang: string;
  langName: string;
  name: string;
  format: string;
}

export interface SubtitleFile {
  format: string;
  buffer: Buffer;
}

const api = axios.create({ baseURL: API_BASE, headers: { 'User-Agent': USER_AGENT }, timeout: 20_000 });

async function login(): Promise<string> {
  const { data } = await api.post<{ token: string }>('/login', {
    username: OPENSUBTITLES_USER,
    password: OPENSUBTITLES_PASS,
  });
  return data.token;
}

/** Retourne un token valide (cache + renouvellement unique + refresh sur 401). */
export async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!tokenPromise) {
    tokenPromise = login()
      .then((token) => {
        cachedToken = token;
        tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
        return token;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

function searchCacheKey(params: Record<string, unknown>): string {
  return JSON.stringify(params);
}

export async function searchSubtitles(params: {
  title: string;
  year?: number;
  type: 'movie' | 'episode';
  season?: number;
  episode?: number;
  langs: string[];
}): Promise<SubtitleSearchResult[]> {
  if (!isOpenSubtitlesConfigured()) return [];

  const query = {
    query: params.title,
    year: params.year && params.year > 0 ? params.year : undefined,
    type: params.type,
    season_number: params.type === 'episode' ? params.season : undefined,
    episode_number: params.type === 'episode' ? params.episode : undefined,
    languages: params.langs.join(','),
  };
  const key = searchCacheKey(query);

  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.data;

  const token = await getToken();
  const { data } = await api.get<{ data?: any[] }>('/subtitles', { params: query, headers: { Authorization: `Bearer ${token}` } });

  const results: SubtitleSearchResult[] = (data.data || []).slice(0, 40).flatMap((sub) => {
    const attrs = sub?.attributes;
    const files = Array.isArray(attrs?.files) ? attrs.files : [];
    const fileId = files[0]?.file_id ?? attrs?.subtitle_id ?? sub?.id;
    if (!fileId) return [];
    return {
      fileId,
      lang: (attrs?.language || 'und').toLowerCase(),
      langName: attrs?.language_name || attrs?.language || 'Unknown',
      name: attrs?.release_name || attrs?.title || 'Subtitle',
      format: (attrs?.sub_format || 'srt').toLowerCase(),
    };
  });

  searchCache.set(key, { at: Date.now(), data: results });
  return results;
}

export async function downloadSubtitle(fileId: number): Promise<SubtitleFile | null> {
  const cacheKey = String(fileId);
  const hit = fileCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FILE_TTL_MS) return { format: hit.format, buffer: hit.buffer };

  const token = await getToken();
  const dl = await api.post<{ link?: string; file_name?: string }>(
    '/download',
    { file_id: fileId, sub_format: 'srt' },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!dl.data?.link) return null;

  const fileRes = await axios.get<Buffer>(dl.data.link, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': USER_AGENT },
    timeout: 30_000,
  });

  const result = { format: 'srt' as string, buffer: Buffer.from(fileRes.data) };
  fileCache.set(cacheKey, { at: Date.now(), ...result });
  return result;
}

/** Invalide le token (401) puis le renouvelle une fois. */
export async function refreshToken(): Promise<string> {
  cachedToken = null;
  tokenExpiresAt = 0;
  return getToken();
}
