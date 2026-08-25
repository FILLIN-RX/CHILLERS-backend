// @ts-nocheck
import axios_1 from "axios";
import * as opensubtitles_config_1 from "./opensubtitles.config";
const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Chillers/1.0 (https://github.com/Chillers)';
const TOKEN_TTL_MS = 8 * 60 * 1000; // jetons valides ~10 min côté API
const SEARCH_TTL_MS = 30 * 60 * 1000;
const FILE_TTL_MS = 2 * 60 * 60 * 1000;
let cachedToken = null;
let tokenExpiresAt = 0;
let tokenPromise = null;
const searchCache = new Map();
const fileCache = new Map();
const api = axios_1.create({ baseURL: API_BASE, headers: { 'User-Agent': USER_AGENT }, timeout: 20000 });
async function login() {
    const { data } = await api.post('/login', {
        username: opensubtitles_config_1.OPENSUBTITLES_USER,
        password: opensubtitles_config_1.OPENSUBTITLES_PASS,
    });
    return data.token;
}
/** Retourne un token valide (cache + renouvellement unique + refresh sur 401). */
export async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt)
        return cachedToken;
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
function searchCacheKey(params) {
    return JSON.stringify(params);
}
export async function searchSubtitles(params) {
    if (!(0, opensubtitles_config_1.isOpenSubtitlesConfigured)())
        return [];
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
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS)
        return hit.data;
    const token = await getToken();
    const { data } = await api.get('/subtitles', { params: query, headers: { Authorization: `Bearer ${token}` } });
    const results = (data.data || []).slice(0, 40).flatMap((sub) => {
        const attrs = sub?.attributes;
        const files = Array.isArray(attrs?.files) ? attrs.files : [];
        const fileId = files[0]?.file_id ?? attrs?.subtitle_id ?? sub?.id;
        if (!fileId)
            return [];
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
export async function downloadSubtitle(fileId) {
    const cacheKey = String(fileId);
    const hit = fileCache.get(cacheKey);
    if (hit && Date.now() - hit.at < FILE_TTL_MS)
        return { format: hit.format, buffer: hit.buffer };
    const token = await getToken();
    const dl = await api.post('/download', { file_id: fileId, sub_format: 'srt' }, { headers: { Authorization: `Bearer ${token}` } });
    if (!dl.data?.link)
        return null;
    const fileRes = await axios_1.get(dl.data.link, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 30000,
    });
    const result = { format: 'srt', buffer: Buffer.from(fileRes.data) };
    fileCache.set(cacheKey, { at: Date.now(), ...result });
    return result;
}
/** Invalide le token (401) puis le renouvelle une fois. */
export async function refreshToken() {
    cachedToken = null;
    tokenExpiresAt = 0;
    return getToken();
}
