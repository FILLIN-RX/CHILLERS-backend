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
      const movie = await Movie.findOne({
        $or: [
          ...(tmdbId ? [{ tmdbId }] : []),
          ...(title ? [{ titre: { $regex: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
        ],
      }).exec();
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
            info: { lien, titre: movie.titre, uqloadLink: movie.uqloadLink, lienFallback: movie.lien !== lien ? movie.lien : undefined },
          };
        }
      }
    }

    if (season !== undefined && episode !== undefined) {
      const series = await Serie.findOne({
        $or: [
          ...(tmdbId ? [{ tmdbId }] : []),
          ...(title ? [{ titre: { $regex: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
        ],
      }).exec();

      if (series) {
        const epLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        // Matching aligné sur le streaming : d'abord les champs numériques
        // season/episodeNumber, puis le label string `episode` en fallback.
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
              info: { lien, titre: `${series.titre} ${epLabel}`, uqloadLink: found.uqloadLink, lienFallback: found.lien !== lien ? found.lien : undefined },
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

    // Decide which URL to actually hand back to the client.
    //
    // Priority:
    // 1) Fresh Uqload direct URL (scraped from embed page via uqloadCode)
    // 2) Stored uqloadLink if still alive
    // 3) lien BD (lienFallback)
    // 4) DoodStream /d/ page as last resort
    let downloadUrl: string | null = null;

    // 1) Try scraping fresh Uqload direct URL
    const uqloadCode = match.info.uqloadCode ||
      (await (async () => {
        try {
          if (!tmdb_id) return null;
          const Movie = (await import('../../models/Movie')).default;
          const Serie = (await import('../../models/Serie')).default;
          if (seasonNum !== undefined && episodeNum !== undefined) {
            const s = await Serie.findOne({ tmdbId: Number(tmdb_id) }).exec();
            if (!s) return null;
            const ep = s.episodes.find((e: any) => Number(e.season) === Number(seasonNum) && Number(e.episodeNumber) === Number(episodeNum));
            return ep?.uqloadCode || null;
          }
          const m = await Movie.findOne({ tmdbId: Number(tmdb_id) }).exec();
          return m?.uqloadCode || null;
        } catch { return null; }
      })());

    if (uqloadCode) {
      try {
        const { scrapeDirectStream } = await import('../../streaming/providers/direct-scraper');
        const uqloadEmbedUrl = `https://uqload.is/embed-${uqloadCode}.html`;
        const scraped = await scrapeDirectStream(uqloadEmbedUrl);
        if (scraped) {
          downloadUrl = scraped.directUrl;
          console.log(`[Download] Uqload fresh URL scraped for code=${uqloadCode}: ${downloadUrl.slice(0, 100)}`);

          // Update MongoDB with fresh link so next request is instant
          try {
            if (seasonNum !== undefined && episodeNum !== undefined) {
              const SerieModel = (await import('../../models/Serie')).default;
              await SerieModel.updateOne(
                { tmdbId: Number(tmdb_id), 'episodes.uqloadCode': uqloadCode },
                { $set: { 'episodes.$.uqloadLink': scraped.directUrl } }
              );
            } else {
              const MovieModel = (await import('../../models/Movie')).default;
              await MovieModel.updateOne(
                { tmdbId: Number(tmdb_id) },
                { $set: { uqloadLink: scraped.directUrl } }
              );
            }
            console.log(`[Download] MongoDB updated with fresh Uqload link for tmdb=${tmdb_id}`);
          } catch (dbErr: any) {
            console.log(`[Download] MongoDB update failed: ${dbErr.message}`);
          }
        }
      } catch (err: any) {
        console.log(`[Download] Uqload scrape failed for code=${uqloadCode}: ${err.message}`);
      }
    }

    // 2) Try stored uqloadLink if still alive
    if (!downloadUrl) {
      const linksToTry = [
        match.info.uqloadLink !== match.info.lien ? match.info.uqloadLink : undefined,
        match.info.lien,
        match.info.lienFallback,
      ].filter(Boolean) as string[];

      for (const url of [...new Set(linksToTry)]) {
        if (!/doodstream\.com\/(e|d)\//i.test(url)) {
          const alive = await isLinkAlive(url);
          if (alive) {
            downloadUrl = url;
            break;
          }
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

    // Proxy l'HLS → le pipe au client avec Content-Disposition download
    const hlsProxyUrl = `/api/doodstream/stream?url=${encodeURIComponent(hlsUrl)}&referer=${encodeURIComponent('https://uqload.is/')}`;
    console.log(`[PROXY] Fallback HLS download: ${hlsProxyUrl.slice(0, 100)}`);

    // Rediriger vers le proxy stream (qui gère la réécriture des URLs HLS)
    res.redirect(302, hlsProxyUrl);
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

    // 3. Check each episode against the local JSON database
    const uploaded = getUploadedFiles();
    const missing: { season: number; episode: number }[] = [];
    const found: { season: number; episode: number; fileCode: string; downloadUrl: string | null }[] = [];

    for (const ep of expectedEpisodes) {
      let match: { fileCode: string; info: any } | null = null;

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

      if (!match) {
        // Fallback: try DoodStream folder listing via the existing helper
        try {
          match = await findByFolderFallback(tmdbIdNum, ep.season, ep.episode);
        } catch {
          // ignore
        }
      }

      if (match) {
        let downloadUrl: string | null = null;
        const storedLien = match.info?.lien;
        const isDirectUrl =
          !!storedLien &&
          !/doodstream\.com\/e\//i.test(storedLien) &&
          !/doodstream\.com\/d\//i.test(storedLien);

        if (isDirectUrl) {
          const alive = await isLinkAlive(storedLien);
          if (alive) {
            downloadUrl = storedLien;
          }
        }

        // DoodStream ne fournit plus de lien direct fiable : on renvoie
        // vers sa page web /d/ (téléchargement déclenché côté utilisateur).
        if (!downloadUrl) {
          const doodCode = match.fileCode || extractDoodFileCode(storedLien);
          if (doodCode) {
            downloadUrl = `https://doodstream.com/d/${doodCode}`;
          }
        }

        found.push({
          season: ep.season,
          episode: ep.episode,
          fileCode: match.fileCode,
          downloadUrl,
        });
      } else {
        missing.push({ season: ep.season, episode: ep.episode });
      }
    }

    // 4. If any episodes are missing, block the download
    if (missing.length > 0) {
      return res.json({
        success: false,
        data: {
          missing,
          found: found.length,
          total: expectedEpisodes.length,
          seriesTitle: seriesData.name || seriesData.title || null,
        },
        message: `Série incomplète : ${missing.length} épisode(s) manquant(s)`,
      });
    }

    // 5. All episodes found — return their download URLs
    return res.json({
      success: true,
      data: {
        episodes: found,
        total: found.length,
        seriesTitle: seriesData.name || seriesData.title || null,
      },
      message: null,
    });
  } catch (error) {
    next(error);
  }
};
