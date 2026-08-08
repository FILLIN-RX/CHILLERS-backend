import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { listFiles } from './doodstream.service';
import tmdbClient from '../../config/tmdb';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import { UPLOADED_PATH, SERIES_OUTPUT_PATH } from '../../config/data-paths';

async function isLinkAlive(url: string): Promise<boolean> {
  if (!url || url === '#') return false;
  try {
    const res = await axios.head(url, {
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    try {
      const res = await axios.get(url, {
        timeout: 3000,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      res.data.destroy();
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }
}

const SE_PATTERN = /[Ss](\d+)[Ee](\d+)/;

function parseSeasonEpisode(filename: string): { season: number; episode: number } | null {
  const match = filename.match(SE_PATTERN);
  if (match) {
    return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  }
  return null;
}

/**
 * Extrait le fileCode DoodStream d'une URL embed/download (/e/ ou /d/).
 * Permet de retomber sur une page /d/ téléchargeable quand seule une URL
 * embed est stockée en base (sans champ fileCode explicite).
 */
function extractDoodFileCode(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\/([a-zA-Z0-9]+)/i);
  return m ? m[1] : null;
}

/**
 * Vrai si l'URL est un fichier vidéo direct (.mp4) servi par un CDN qui
 * bloque l'IP du serveur (Uqload, vidzy…) mais pas celle du navigateur.
 * Le serveur ne peut pas vérifier la vivacité de ces liens (403), on les
 * renvoie donc tels quels : c'est le navigateur qui les ouvre directement.
 */
function isDirectMp4CdnUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return /\.mp4(\?|$)/i.test(url);
}

/**
 * HLS Uqload : les liens MP4 directs renvoyés par l'API (`direct_link`)
 * renvoient un 403 côté CDN (anti-leech). Le player, lui, diffuse un flux
 * HLS (master.m3u8) qui répond 200 → on le scrape (API `hls=1` puis
 * extraction P.A.C.K.E.R. de la page embed en secours) et on le pipe via
 * le proxy FFmpeg (/api/download/stream) pour produire un vrai MP4
 * téléchargeable.
 *
 * Résultat mis en cache (le lien HLS signé reste valide ~12h).
 */
const hlsCache = new Map<string, { url: string; at: number }>();
const HLS_CACHE_TTL = 15 * 60 * 1000;

const mp4Cache = new Map<string, { url: string; at: number }>();
const MP4_CACHE_TTL = 5 * 60 * 1000; // 5 min (tokens MP4 durent ~10 min)

const UQLOAD_API_KEY_DL = process.env.UQLOAD_API_KEY || '';

/**
 * Scrape la page embed Uqload (PACKER) pour extraire le flux HLS valide.
 * L'API direct_link d'Uqload renvoie une URL MP4 avec un paramètre `v=` vide,
 * ce qui fait renvoyer une erreur 403 HTML (146 octets) par le CDN.
 * En revanche, le P.A.C.K.E.R. de la page embed contient l'URL HLS signée avec
 * le view ID `v` rempli, qui fonctionne à 100% via le proxy FFmpeg.
 */
async function getFreshUqloadHls(fileCode: string): Promise<{ url: string; type: 'hls' | 'mp4' } | null> {
  const cached = hlsCache.get(fileCode);
  if (cached && Date.now() - cached.at < HLS_CACHE_TTL) {
    console.log(`[Download] Uqload HLS cache hit for code=${fileCode}`);
    return { url: cached.url, type: 'hls' };
  }
  try {
    const { scrapeUqloadEmbedDirect } = await import('../../streaming/providers/direct-scraper');
    const scraped = await scrapeUqloadEmbedDirect(fileCode);
    if (!scraped) {
      console.log(`[Download] Uqload embed scrape returned null for code=${fileCode}`);
      return null;
    }
    const isHls = scraped.type === 'hls' || /\.m3u8(\?|$)/i.test(scraped.directUrl);
    if (isHls) {
      hlsCache.set(fileCode, { url: scraped.directUrl, at: Date.now() });
      console.log(`[Download] Uqload HLS scraped OK for code=${fileCode}: ${scraped.directUrl.slice(0, 100)}`);
      return { url: scraped.directUrl, type: 'hls' };
    }
    console.log(`[Download] Uqload embed retourné MP4 brut pour code=${fileCode}, ignoré`);
    return null;
  } catch (err: any) {
    console.log(`[Download] Uqload HLS scrape failed for code=${fileCode}: ${err.message}`);
    return null;
  }
}

function buildHlsDownloadUrl(m3u8: string, filename: string): string {
  return `/api/download/stream?m3u8=${encodeURIComponent(m3u8)}&filename=${encodeURIComponent(filename)}`;
}

let cachedUploadedFiles: Record<string, any> | null = null;
let lastCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

function getUploadedFiles(): Record<string, any> {
  const now = Date.now();
  if (cachedUploadedFiles && (now - lastCacheTime < CACHE_TTL)) {
    return cachedUploadedFiles;
  }
  const all: Record<string, any> = {};
  if (fs.existsSync(UPLOADED_PATH)) {
    try {
      Object.assign(all, JSON.parse(fs.readFileSync(UPLOADED_PATH, 'utf-8')));
    } catch (e) {
      console.error('Error reading UPLOADED_PATH:', e);
    }
  }
  if (fs.existsSync(SERIES_OUTPUT_PATH)) {
    try {
      Object.assign(all, JSON.parse(fs.readFileSync(SERIES_OUTPUT_PATH, 'utf-8')));
    } catch (e) {
      console.error('Error reading SERIES_OUTPUT_PATH:', e);
    }
  }
  cachedUploadedFiles = all;
  lastCacheTime = now;
  return all;
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function findByTmdbId(tmdbId: number, season?: number, episode?: number): { fileCode: string; info: any } | null {
  const uploaded = getUploadedFiles();
  let seriesFallback: { fileCode: string; info: any } | null = null;
  for (const key of Object.keys(uploaded)) {
    const file = uploaded[key];
    if (file.tmdbId && Number(file.tmdbId) === tmdbId) {
      if (season !== undefined && episode !== undefined) {
        if (file.season === season && file.episode === episode) {
          return { fileCode: file.fileCode, info: file };
        }
        continue;
      }
      if (!file.season && !file.episode) {
        return { fileCode: file.fileCode, info: file };
      }
      if (!seriesFallback) {
        seriesFallback = { fileCode: file.fileCode, info: file };
      }
    }
  }
  return seriesFallback;
}

function findByTitle(title: string, season?: number, episode?: number): { fileCode: string; info: any } | null {
  const uploaded = getUploadedFiles();
  const search = normalize(title);

  for (const key of Object.keys(uploaded)) {
    const file = uploaded[key];
    const fileTitle = normalize(file.titre || '');
    if (fileTitle === search || fileTitle.includes(search) || search.includes(fileTitle)) {
      if (season !== undefined && episode !== undefined) {
        if (file.season === season && file.episode === episode) return { fileCode: file.fileCode, info: file };
        continue;
      }
      if (!file.season && !file.episode) return { fileCode: file.fileCode, info: file };
    }
  }

  for (const key of Object.keys(uploaded)) {
    const file = uploaded[key];
    const fileTitle = normalize(file.titre || '');
    if (fileTitle.includes(search.slice(0, 10)) || search.includes(fileTitle.slice(0, 10))) {
      if (season !== undefined && episode !== undefined) {
        if (file.season === season && file.episode === episode) return { fileCode: file.fileCode, info: file };
        continue;
      }
      if (!file.season && !file.episode) return { fileCode: file.fileCode, info: file };
    }
  }

  // Third pass: no S/E filter → accept any match (series entries too)
  if (season === undefined && episode === undefined) {
    const search10 = search.slice(0, 10);
    for (const key of Object.keys(uploaded)) {
      const file = uploaded[key];
      const fileTitle = normalize(file.titre || '');
      if (fileTitle === search || fileTitle.includes(search) || search.includes(fileTitle) ||
          fileTitle.includes(search10) || search10.includes(fileTitle.slice(0, 10))) {
        return { fileCode: file.fileCode, info: file };
      }
    }
  }

  return null;
}

async function findByFolderFallback(tmdbId: number, season: number, episode: number): Promise<{ fileCode: string; info: any } | null> {
  const uploaded = getUploadedFiles();
  let fldId: string | null = null;

  for (const key of Object.keys(uploaded)) {
    const file = uploaded[key];
    if (file.tmdbId && Number(file.tmdbId) === tmdbId && file.fldId) {
      fldId = file.fldId;
      break;
    }
  }

  if (!fldId) return null;

  try {
    const result = await listFiles({ fldId, perPage: 100 });
    const files = result.files || result;
    if (!Array.isArray(files)) return null;

    for (const doodFile of files) {
      const parsed = parseSeasonEpisode(doodFile.title || doodFile.name || '');
      if (parsed && parsed.season === season && parsed.episode === episode) {
        return {
          fileCode: doodFile.filecode,
          info: { lien: doodFile.download_url || doodFile.protected_embed || doodFile.filecode, titre: doodFile.title },
        };
      }
    }
  } catch {
    // DoodStream API unavailable
  }

  return null;
}

async function findByMongoDB(title?: string, tmdbId?: number, season?: number, episode?: number): Promise<{ fileCode: string; info: any } | null> {
  try {
    if (!tmdbId && !title) return null;

    if (!season && !episode) {
      // Priority 1: tmdbId exact, Priority 2: title regex
      let movie = tmdbId ? await Movie.findOne({ tmdbId }).exec() : null;
      if (!movie && title) {
        const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        movie = await Movie.findOne({ titre: { $regex: new RegExp(escaped, 'i') } }).exec();
      }
      if (movie) {
        const lien = movie.uqloadLink || movie.lien;
        let fileCode = movie.fileCode || '';
        if (!fileCode) {
          const jsonMatch = title
            ? findByTitle(title, season, episode)
            : tmdbId
              ? findByTmdbId(tmdbId, season, episode)
              : null;
          if (jsonMatch?.fileCode) fileCode = jsonMatch.fileCode;
        }
        if (!fileCode) fileCode = extractDoodFileCode(movie.lien) || extractDoodFileCode(movie.uqloadLink) || '';
        if (lien || fileCode) {
          return {
            fileCode,
            info: { lien, titre: movie.titre, uqloadLink: movie.uqloadLink, uqloadCode: movie.uqloadCode, lienFallback: movie.lien !== lien ? movie.lien : undefined },
          };
        }
      }
    }

    if (season !== undefined && episode !== undefined) {
      // Priority 1: tmdbId exact, Priority 2: title regex
      let series: any = null;
      if (tmdbId) {
        const byId = await Serie.find({ tmdbId }).exec();
        if (byId.length) {
          series = byId.find((s: any) => s.episodes?.some(
            (e: any) => Number(e.season) === Number(season)
          )) || byId[0];
        }
      }
      if (!series && title) {
        const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const byTitle = await Serie.find({ titre: { $regex: new RegExp(escaped, 'i') } }).exec();
        if (byTitle.length) {
          series = byTitle.find((s: any) => s.episodes?.some(
            (e: any) => Number(e.season) === Number(season)
          )) || byTitle[0];
        }
      }

      if (series) {
        const epLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        const found = series.episodes.find(
          (ep: any) =>
            (Number(ep.season) === Number(season) && Number(ep.episodeNumber) === Number(episode)) ||
            ep.episode?.toUpperCase() === epLabel
        );
        if (found) {
          const lien = found.uqloadLink || found.lien;
          let fileCode = found.fileCode || '';
          if (!fileCode) {
            const jsonMatch = title
              ? findByTitle(title, season, episode)
              : tmdbId
                ? findByTmdbId(tmdbId, season, episode)
                : null;
            if (jsonMatch?.fileCode) fileCode = jsonMatch.fileCode;
          }
          if (!fileCode) fileCode = extractDoodFileCode(found.lien) || extractDoodFileCode(found.uqloadLink) || '';
          if (lien || fileCode) {
            return {
              fileCode,
              info: { lien, titre: `${series.titre} ${epLabel}`, uqloadLink: found.uqloadLink, uqloadCode: found.uqloadCode, lienFallback: found.lien !== lien ? found.lien : undefined },
            };
          }
        }
      }
    }
  } catch (err) {
    console.error('[DoodStream Download] MongoDB query error:', err);
  }
  return null;
}

export const getDownloadByTitle = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, tmdb_id, file_code, season, episode } = req.query as Record<string, string>;
    const seasonNum = season ? parseInt(season, 10) : undefined;
    const episodeNum = episode ? parseInt(episode, 10) : undefined;

    if (!title && !file_code && !tmdb_id) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Missing ?title=, ?tmdb_id=, or ?file_code= param',
      });
    }

    let match: { fileCode: string; info: any } | null = null;

    // Priority 1: MongoDB (la plus récente / fiable)
    match = await findByMongoDB(title, tmdb_id ? Number(tmdb_id) : undefined, seasonNum, episodeNum);

    // Priority 2: JSON cache by tmdb_id
    if (!match && tmdb_id) {
      match = findByTmdbId(Number(tmdb_id), seasonNum, episodeNum);
    }

    // Priority 3: JSON cache by title
    if (!match && title) {
      match = findByTitle(title, seasonNum, episodeNum);
    }

    // Priority 4: DoodStream folder listing API
    if (!match && tmdb_id && seasonNum !== undefined && episodeNum !== undefined) {
      match = await findByFolderFallback(Number(tmdb_id), seasonNum, episodeNum);
    }

    // Priority 5: direct file_code
    if (!match && file_code) {
      match = { fileCode: file_code, info: {} };
    }

    if (!match) {
      return res.json({
        success: false,
        data: null,
        message: 'No DoodStream file found',
      });
    }

    // ── Résolution de l'URL de téléchargement ────────────────────────────
    //
    // Priorité pour les fichiers Uqload :
    //   1. API direct_link → URL MP4 fraîche → proxy backend (MÊME IP → 200)
    //   2. Scraping PACKER → flux HLS → FFmpeg proxy (si API indisponible)
    //   3. DoodStream /d/ en dernier recours
    //
    // ⚠ On ne renvoie JAMAIS une URL .mp4 directe au navigateur :
    //   les tokens Uqload sont liés à l'IP serveur → le browser (IP
    //   différente) reçoit un 403. Le proxy backend évite ce problème.
    // ─────────────────────────────────────────────────────────────────────
    let downloadUrl: string | null = null;

    const uqloadCode = match.info.uqloadCode ||
      (await (async () => {
        try {
          if (!tmdb_id) return null;
          const Movie = (await import('../../models/Movie')).default;
          const Serie = (await import('../../models/Serie')).default;
          if (seasonNum !== undefined && episodeNum !== undefined) {
            const byId = await Serie.find({ tmdbId: Number(tmdb_id) }).exec();
            if (!byId.length) return null;
            const s = byId.find((doc: any) => doc.episodes?.some(
              (e: any) => Number(e.season) === Number(seasonNum)
            )) || byId[0];
            const ep = s.episodes.find((e: any) => Number(e.season) === Number(seasonNum) && Number(e.episodeNumber) === Number(episodeNum));
            return ep?.uqloadCode || null;
          }
          const m = await Movie.findOne({ tmdbId: Number(tmdb_id) }).exec();
          return m?.uqloadCode || null;
        } catch { return null; }
      })());

    const filename = `${match.info.titre || title || 'video'}.mp4`;

    if (uqloadCode) {
      // ── Priorité 1 : Scraping PACKER → HLS master playlist (avec view ID v) → FFmpeg proxy
      // L'URL HLS extraite du PACKER contient le paramètre view ID (ex: v=1988399),
      // ce qui permet à FFmpeg de télécharger et assembler la vidéo MP4 complète.
      const fresh = await getFreshUqloadHls(uqloadCode);
      if (fresh?.type === 'hls') {
        downloadUrl = buildHlsDownloadUrl(fresh.url, filename);
        console.log(`[Download] ✅ Uqload PACKER HLS → FFmpeg pour code=${uqloadCode}`);
      }
    }

    // ── Fallback : liens stockés en base non-DoodStream ────────────────
    if (!downloadUrl) {
      const linksToTry = [
        match.info.uqloadLink !== match.info.lien ? match.info.uqloadLink : undefined,
        match.info.lien,
        match.info.lienFallback,
      ].filter(Boolean) as string[];

      for (const url of [...new Set(linksToTry)]) {
        if (!url || /doodstream\.com\/(e|d)\//i.test(url)) continue;
        const alive = await isLinkAlive(url);
        if (alive) {
          downloadUrl = url;
          break;
        }
      }
    }

    // 3) DoodStream /d/ page as last resort
    if (!downloadUrl) {
      const doodCode =
        match.fileCode ||
        extractDoodFileCode(match.info.lien) ||
        extractDoodFileCode(match.info.uqloadLink) ||
        extractDoodFileCode(match.info.lienFallback);
      if (doodCode) {
        downloadUrl = `https://doodstream.com/d/${doodCode}`;
      }
    }

    if (!downloadUrl) {
      return res.json({
        success: false,
        data: null,
        message: 'No downloadable URL found for this episode',
      });
    }

    return res.json({
      success: true,
      data: {
        fileCode: match.fileCode,
        directUrl: downloadUrl,
        downloadUrl,
        title: match.info.titre || title || '',
        year: match.info.year || null,
        season: match.info.season || null,
        episode: match.info.episode || null,
      },
      message: null,
    });
  } catch (error) {
    next(error);
  }
};

export const proxyDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, filename } = req.query as Record<string, string>;

    if (!url) {
      return res.status(400).json({ success: false, message: 'Missing ?url= param' });
    }

    // DoodStream /d/ page → redirect plutôt que proxy (c'est une page HTML)
    if (/doodstream\.com\/d\//i.test(url)) {
      return res.redirect(302, url);
    }

    const downloadName = filename || 'video.mp4';

    // ── Étape 1 : Tenter le MP4 direct ──────────────────────────────────
    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 300000,
        maxContentLength: Infinity,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://uqload.is/',
        },
        'decompress': false,
        validateStatus: (s) => s < 400,
      });

      const rawContentType = response.headers['content-type'];
      const upstreamType = (typeof rawContentType === 'string' ? rawContentType : '').toLowerCase();
      const isHtml = upstreamType.includes('text/html') || upstreamType.includes('application/xhtml');

      if (!isHtml) {
        const contentLength = response.headers['content-length'] as string | undefined;
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        response.data.pipe(res);
        return;
      }
      response.data.destroy();
      console.log(`[PROXY] MP4 direct bloqué (HTML), fallback HLS pour ${url}`);
    } catch {
      console.log(`[PROXY] MP4 direct 403/erreur, fallback HLS pour ${url}`);
    }

    // ── Étape 2 : Fallback HLS ──────────────────────────────────────────
    // Extraire le file_code, cloner, et récupérer le HLS
    const uqloadMatch = url.match(/uqload\.is\/v\/[^/]+\/[^/]+\/([a-z0-9]+)_/i);
    const fileCode = uqloadMatch?.[1] || url.match(/([a-z0-9]{12})/i)?.[1];
    if (!fileCode) {
      return res.status(502).json({ success: false, message: 'No fallback available' });
    }

    const API_KEY = process.env.UQLOAD_API_KEY || '';
    if (!API_KEY) {
      return res.status(502).json({ success: false, message: 'No API key for HLS fallback' });
    }

    // Cloner pour un nouveau filecode + direct_link HLS
    const cloneRes = await axios.get(`https://uqload.is/api/file/clone?key=${API_KEY}&file_code=${fileCode}`, { timeout: 10000 });
    const cloneCode = cloneRes.data?.result?.filecode;
    if (!cloneCode) {
      return res.status(502).json({ success: false, message: 'Clone failed for HLS fallback' });
    }

    const hlsRes = await axios.get(`https://uqload.is/api/file/direct_link?key=${API_KEY}&file_code=${cloneCode}&hls=1`, { timeout: 10000 });
    const hlsUrl = hlsRes.data?.result?.hls_direct;
    if (!hlsUrl) {
      return res.status(502).json({ success: false, message: 'HLS direct_link failed' });
    }

    // Proxy l'HLS → le rediriger vers le proxy FFmpeg (qui convertit en MP4)
    const downloadUrl = `/api/download/stream?m3u8=${encodeURIComponent(hlsUrl)}&filename=${encodeURIComponent(downloadName)}`;
    console.log(`[PROXY] Fallback HLS download: ${downloadUrl.slice(0, 100)}`);
    res.redirect(302, downloadUrl);
  } catch (error: any) {
    console.error('[PROXY] Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Download failed' });
    }
  }
};

export const proxyStream = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, referer } = req.query as Record<string, string>;

    if (!url) {
      return res.status(400).json({ success: false, message: 'Missing ?url= param' });
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': referer || 'https://vidzy.cc/',
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range as string;
    }

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 600000,
      maxRedirects: 5,
      headers,
    });

    const contentType = (response.headers['content-type'] as string || '').toLowerCase();
    const isHls = contentType.includes('mpegurl') || url.endsWith('.m3u8');

    if (isHls) {
      const contentLength = response.headers['content-length'] as string | undefined;
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const body = await axios.get(url, {
        timeout: 30000,
        headers,
        responseType: 'text',
      });

      const baseUrl = new URL(url);
      const origin = baseUrl.origin;
      const baseDir = url.substring(0, url.lastIndexOf('/') + 1);

      const rewritten = (body.data as string).split('\n').map((line: string) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;

        let absoluteUrl = trimmed;
        if (trimmed.startsWith('//')) {
          absoluteUrl = 'https:' + trimmed;
        } else if (trimmed.startsWith('/')) {
          absoluteUrl = origin + trimmed;
        } else if (!trimmed.startsWith('http')) {
          absoluteUrl = baseDir + trimmed;
        }

        const encodedUrl = encodeURIComponent(absoluteUrl);
        return `/api/doodstream/stream?url=${encodedUrl}&referer=${encodeURIComponent(referer || 'https://uqload.is/')}`;
      }).join('\n');

      res.send(rewritten);
      return;
    }

    const contentLength = response.headers['content-length'] as string | undefined;
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const contentRange = response.headers['content-range'] as string | undefined;
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    const acceptRanges = response.headers['accept-ranges'] as string | undefined;
    if (acceptRanges) {
      res.setHeader('Accept-Ranges', acceptRanges);
    }

    res.setHeader('Content-Type', response.headers['content-type'] as string || 'video/mp4');
    if (req.headers.range) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    res.status(response.status);
    response.data.pipe(res);
  } catch (error: any) {
    console.error('[STREAM] Proxy error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: 'Stream unavailable' });
    }
  }
};

export const getSeriesDownloadCheck = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tmdb_id } = req.query as Record<string, string>;

    if (!tmdb_id) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Missing ?tmdb_id= param',
      });
    }

    const tmdbIdNum = Number(tmdb_id);
    if (isNaN(tmdbIdNum)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid tmdb_id',
      });
    }

    // 1. Fetch TV series details from TMDB to get all seasons and episode counts
    const language = req.query.language as string | undefined;
    const { toTMDBLanguage } = await import('../../config/language');
    const tmdbRes = await tmdbClient.get(`/tv/${tmdbIdNum}`, {
      params: { language: toTMDBLanguage(language) },
    });
    const seriesData = tmdbRes.data;

    if (!seriesData || !seriesData.seasons) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Series not found on TMDB',
      });
    }

    // 2. Build the list of expected episodes (skip season 0 = specials)
    const expectedEpisodes: { season: number; episode: number }[] = [];
    for (const season of seriesData.seasons) {
      const seasonNum = season.season_number;
      if (seasonNum === 0 || !season.episode_count) continue;

      for (let epNum = 1; epNum <= season.episode_count; epNum++) {
        expectedEpisodes.push({ season: seasonNum, episode: epNum });
      }
    }

    // 3. Check each episode: MongoDB d'abord (liens Uqload/vidzy en priorité),
    //    cache d'upload disque ensuite (fichiers DoodStream), et DoodStream
    //    /d/ en dernier recours uniquement.
    const uploaded = getUploadedFiles();
    const missing: { season: number; episode: number }[] = [];
    const found: { season: number; episode: number; fileCode: string; downloadUrl: string | null }[] = [];

    // Beaucoup de documents en base n'ont pas de tmdbId (≈36 %) : on matche
    // aussi par titre TMDB, exactement comme findByMongoDB le fait pour le
    // téléchargement simple.
    const serie = await (async () => {
      const byId = await Serie.find({ tmdbId: tmdbIdNum }).exec();
      if (byId.length) {
        // Préférer la série dont les épisodes couvrent le plus de saisons
        // attendues (les doublons tmdbId existent : séries homonymes).
        let best = byId[0];
        let bestScore = -1;
        for (const s of byId) {
          const score = s.episodes?.filter(
            (e: any) => expectedEpisodes.some(ep => Number(e.season) === ep.season)
          ).length || 0;
          if (score > bestScore) { bestScore = score; best = s; }
        }
        return best;
      }
      if (seriesData.name) {
        const escaped = seriesData.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return Serie.findOne({ titre: { $regex: new RegExp(escaped, 'i') } }).exec();
      }
      return null;
    })();

    for (const ep of expectedEpisodes) {
      let match: { fileCode: string; info: any } | null = null;

      // Source 1: MongoDB (shape identique à findByMongoDB)
      if (serie) {
        const epLabel = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
        const foundEp = serie.episodes.find(
          (e: any) =>
            (Number(e.season) === Number(ep.season) && Number(e.episodeNumber) === Number(ep.episode)) ||
            e.episode?.toUpperCase() === epLabel
        );
        // uqloadCode suffit : le téléchargement simple le scrape pour produire
        // une URL fraîche (getDownloadByTitle fait pareil).
        if (foundEp && (foundEp.uqloadLink || foundEp.lien || foundEp.fileCode || foundEp.uqloadCode)) {
          const lien = foundEp.uqloadLink || foundEp.lien;
          match = {
            fileCode: foundEp.fileCode || '',
            info: {
              lien,
              titre: `${serie.titre} ${epLabel}`,
              uqloadLink: foundEp.uqloadLink,
              uqloadCode: foundEp.uqloadCode,
              lienFallback: foundEp.lien !== lien ? foundEp.lien : undefined,
            },
          };
        }
      }

      // Source 2: cache d'upload disque
      if (!match) {
        for (const key of Object.keys(uploaded)) {
          const file = uploaded[key];
          if (
            file.tmdbId &&
            Number(file.tmdbId) === tmdbIdNum &&
            file.season === ep.season &&
            file.episode === ep.episode
          ) {
            match = { fileCode: file.fileCode, info: file };
            break;
          }
        }
      }

      // Source 3: DoodStream folder listing API
      if (!match) {
        try {
          match = await findByFolderFallback(tmdbIdNum, ep.season, ep.episode);
        } catch {
          // ignore
        }
      }

      if (match) {
        let downloadUrl: string | null = null;

        // 1) UqloadCode → HLS frais converti en MP4 par le proxy FFmpeg
        //    (les MP4 directs de l'API renvoient un 403 côté CDN).
        const epFilename = `${serie?.titre || 'episode'}-S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}.mp4`;

        if (match.info?.uqloadCode) {
          // Scraping PACKER → HLS master playlist (avec view ID v) → FFmpeg proxy
          const fresh = await getFreshUqloadHls(match.info.uqloadCode);
          if (fresh?.type === 'hls') {
            downloadUrl = buildHlsDownloadUrl(fresh.url, epFilename);
          }
        }

        // 3) Liens stockés en base
        if (!downloadUrl) {
          const candidates = [
            match.info?.uqloadLink,
            match.info?.lien,
            match.info?.lienFallback,
          ].filter(Boolean) as string[];
          for (const url of [...new Set(candidates)]) {
            if (!url || /doodstream\.com\/(e|d)\//i.test(url)) continue;
            const alive = await isLinkAlive(url);
            if (alive) {
              downloadUrl = url;
              break;
            }
          }
        }

        // 3) DoodStream ne fournit plus de lien direct fiable : on renvoie
        //    vers sa page web /d/ (téléchargement déclenché côté utilisateur).
        if (!downloadUrl) {
          const doodCode =
            match.fileCode ||
            extractDoodFileCode(match.info?.lien) ||
            extractDoodFileCode(match.info?.uqloadLink) ||
            extractDoodFileCode(match.info?.lienFallback);
          if (doodCode) {
            downloadUrl = `https://doodstream.com/d/${doodCode}`;
          }
        }

        found.push({
          season: ep.season,
          episode: ep.episode,
          fileCode: match.fileCode || '',
          downloadUrl,
        });
      } else {
        missing.push({ season: ep.season, episode: ep.episode });
      }
    }

    // 4. Réponse : succès dès qu'au moins un épisode a un lien exploitable
    return res.json({
      success: found.length > 0,
      data: {
        missing,
        episodes: found,
        found: found.length,
        total: expectedEpisodes.length,
        seriesTitle: seriesData.name || seriesData.title || null,
      },
      message: found.length > 0
        ? null
        : `Série incomplète : ${missing.length} épisode(s) manquant(s)`,
    });
  } catch (error) {
    next(error);
  }
};
