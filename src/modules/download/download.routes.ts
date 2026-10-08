import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import axios from 'axios';
import { ProviderManager } from '../streaming/provider-manager';
import { StreamQuery } from '../streaming/providers/provider.interface';
import { DirectScraper, getUqloadDirectLink } from '../streaming/providers/direct-scraper';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

const router = Router();
const providerManager = new ProviderManager();

function unwrapUrl(url: string | undefined | null): string {
  if (!url || typeof url !== 'string') return '';
  let current = url.trim();
  while (
    current.includes('/api/doodstream/stream?url=') ||
    current.includes('/api/download/file?url=') ||
    current.includes('/api/download/stream?m3u8=') ||
    current.includes('/api/omnisave/proxy?url=')
  ) {
    const match = current.match(/[?&](?:url|m3u8)=([^&]+)/);
    if (match) {
      try {
        current = decodeURIComponent(match[1]);
      } catch {
        break;
      }
    } else {
      break;
    }
  }
  return current;
}

/**
 * GET /api/download/resolve
 *
 * Résout automatiquement la meilleure URL de téléchargement (MP4 direct)
 * pour n'importe quel film ou épisode via le ProviderManager multi-sources.
 */
router.get('/resolve', async (req: Request, res: Response) => {
  try {
    const {
      tmdb_id,
      title,
      type = 'movie',
      season,
      episode,
      isPremium,
      language = 'fr'
    } = req.query as {
      tmdb_id?: string;
      title?: string;
      type?: 'movie' | 'series' | 'anime';
      season?: string;
      episode?: string;
      isPremium?: string;
      language?: string;
    };

    const tmdbIdNum = tmdb_id && /^\d+$/.test(tmdb_id) ? parseInt(tmdb_id, 10) : 0;
    const isPrem = isPremium === 'true' || isPremium === '1';
    const isTv = type === 'series' || type === 'anime' || season !== undefined || episode !== undefined;
    const cleanTitle = title
      ? title.replace(/\s*·\s*(?:S\d+)?E\d+.*$/i, '').trim()
      : undefined;

    const query: StreamQuery = {
      tmdbId: tmdbIdNum,
      title: cleanTitle,
      type: isTv ? 'tv' : 'movie',
      season: season !== undefined ? parseInt(season, 10) : undefined,
      episode: episode !== undefined ? parseInt(episode, 10) : undefined,
      isPremium: isPrem,
      language
    };

    console.log(`[Download Resolve] Résolution: "${cleanTitle || tmdb_id}" (type=${type}, S${season || 1}E${episode || 1}, premium=${isPrem})`);

    let downloadUrl: string | null = null;
    let directType: 'mp4' | 'hls' | 'embed' = 'embed';
    let resolvedProvider = 'chillers';

    // 1. Priorité absolue : chercher dans la base MongoDB Chillers (films et séries)
    // pour récupérer le vrai lien de téléchargement direct sans passer par le streaming
    if (isTv) {
      const serie = tmdbIdNum
        ? await Serie.findOne({ tmdbId: tmdbIdNum }).lean().exec()
        : cleanTitle
          ? await Serie.findOne({ titre: { $regex: new RegExp(cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }).lean().exec()
          : null;
      if (serie) {
        const sNum = query.season !== undefined ? Number(query.season) : 1;
        const eNum = query.episode !== undefined ? Number(query.episode) : 1;
        const ep = serie.episodes?.find((e: any) => Number(e.season) === sNum && Number(e.episodeNumber) === eNum);
        if (ep) {
          if (ep.uqloadCode) {
            const uq = await getUqloadDirectLink(ep.uqloadCode, false);
            if (uq?.directUrl) {
              downloadUrl = uq.directUrl;
              directType = 'mp4';
              resolvedProvider = 'uqload';
            }
          }
          if (!downloadUrl && ep.uqloadLink) {
            downloadUrl = ep.uqloadLink;
            directType = 'mp4';
            resolvedProvider = 'uqload';
          }
          if (!downloadUrl && ep.lien) {
            downloadUrl = ep.lien;
            directType = /\.mp4(\?|$)/i.test(ep.lien) ? 'mp4' : 'embed';
            resolvedProvider = 'mongodb';
          }
        }
      }
    } else {
      const movie = tmdbIdNum
        ? await Movie.findOne({ tmdbId: tmdbIdNum }).lean().exec()
        : cleanTitle
          ? await Movie.findOne({ titre: { $regex: new RegExp(cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }).lean().exec()
          : null;
      if (movie) {
        if (movie.uqloadCode) {
          const uq = await getUqloadDirectLink(movie.uqloadCode, false);
          if (uq?.directUrl) {
            downloadUrl = uq.directUrl;
            directType = 'mp4';
            resolvedProvider = 'uqload';
          }
        }
        if (!downloadUrl && movie.uqloadLink) {
          downloadUrl = movie.uqloadLink;
          directType = 'mp4';
          resolvedProvider = 'uqload';
        }
        if (!downloadUrl && movie.lien) {
          downloadUrl = movie.lien;
          directType = /\.mp4(\?|$)/i.test(movie.lien) ? 'mp4' : 'embed';
          resolvedProvider = 'mongodb';
        }
      }
    }

    // 2. Fallback ProviderManager si introuvable en base directe
    if (!downloadUrl) {
      const streamResult = isTv
        ? await providerManager.getEpisodeStream(query)
        : await providerManager.getMovieStream(query);

      if (streamResult) {
        resolvedProvider = streamResult.provider;
        const candidate = streamResult.downloadUrl || streamResult.directUrl || streamResult.embedUrl;
        if (candidate) {
          downloadUrl = unwrapUrl(candidate) || candidate;
          directType = streamResult.directType || (/\.m3u8(\?|$)/i.test(downloadUrl) ? 'hls' : /\.mp4(\?|$)/i.test(downloadUrl) ? 'mp4' : 'embed');
        }
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({
        success: false,
        error: 'Aucune source de téléchargement trouvée pour ce contenu',
        data: null
      });
    }

    // Si on a une URL Uqload interne /api/download/uqload/<code>, la résoudre en MP4
    if (downloadUrl.includes('/api/download/uqload/')) {
      const match = downloadUrl.match(/\/api\/download\/uqload\/([a-zA-Z0-9]+)/);
      if (match) {
        const uq = await getUqloadDirectLink(match[1], false);
        if (uq?.directUrl) {
          downloadUrl = uq.directUrl;
          directType = 'mp4';
        }
      }
    }

    // Si ce n'est pas encore un MP4 direct, tenter d'extraire le MP4 direct
    if (directType !== 'mp4' && downloadUrl) {
      try {
        const direct = await DirectScraper.resolve(downloadUrl, false);
        if (direct?.directUrl && direct.type === 'mp4') {
          downloadUrl = direct.directUrl;
          directType = 'mp4';
          console.log(`[Download Resolve] ✅ MP4 direct extrait avec succès pour download: ${downloadUrl.slice(0, 80)}...`);
        }
      } catch (err: any) {
        console.warn(`[Download Resolve] Échec extraction MP4 direct:`, err.message);
      }
    }

    // Nettoyage propre du nom de fichier (sans les triples underscores)
    const safeTitle = (title || 'video')
      .replace(/\s*:\s*/g, ' - ')
      .replace(/[/\\?%*:|"<>]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const cleanFilename = `${safeTitle}${isTv ? `_S${season || 1}E${episode || 1}` : ''}.mp4`;

    const isHls = directType === 'hls' || /\.m3u8(\?|$)/i.test(downloadUrl);
    const isMp4Direct = directType === 'mp4' || /\.mp4(\?|$)/i.test(downloadUrl);

    let finalDownloadUrl: string;

    if (isMp4Direct && downloadUrl.startsWith('http')) {
      // MP4 direct → proxy pour fournir Content-Disposition, Referer anti-blocage et Content-Length exact
      finalDownloadUrl = `/api/download/file?url=${encodeURIComponent(downloadUrl)}&filename=${encodeURIComponent(cleanFilename)}`;
      console.log(`[Download Resolve] MP4 direct → file proxy: ${downloadUrl.slice(0, 80)}...`);
    } else if (isHls && downloadUrl.startsWith('http')) {
      // HLS uniquement en dernier recours si aucun MP4 n'existe
      finalDownloadUrl = `/api/download/stream?m3u8=${encodeURIComponent(downloadUrl)}&filename=${encodeURIComponent(cleanFilename)}`;
      console.log(`[Download Resolve] HLS de dernier recours → FFmpeg proxy: ${downloadUrl.slice(0, 80)}...`);
    } else {
      finalDownloadUrl = downloadUrl;
    }

    return res.json({
      success: true,
      data: {
        downloadUrl: finalDownloadUrl,
        rawUrl: downloadUrl,
        directType: directType,
        provider: resolvedProvider,
        type: isTv ? 'episode' : 'movie',
        filename: cleanFilename,
        fileCode: ''
      }
    });
  } catch (error: any) {
    console.error('[Download Resolve] Erreur:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/download/uqload/:code
 *
 * Résout le lien MP4 direct Uqload et le sert via le proxy avec Content-Length
 */
router.get('/uqload/:code', async (req: Request, res: Response) => {
  const code = req.params.code as string;
  const filename = (req.query.filename as string) || 'video.mp4';
  try {
    const direct = await getUqloadDirectLink(code, false);
    if (direct?.directUrl) {
      if (await serveFileProxy(req, res, direct.directUrl, filename)) {
        return;
      }
      return res.redirect(direct.directUrl);
    }
  } catch (err: any) {
    console.error('[Download Uqload] Erreur:', err.message);
  }
  res.status(404).json({ success: false, error: 'Fichier Uqload introuvable ou indisponible' });
});

/**
 * Proxy d'un fichier distant vers la réponse cliente, avec les en-têtes de
 * taille conservés (Content-Length / Accept-Ranges) pour que le gestionnaire
 * de téléchargement affiche une vraie progression.
 *
 * Renvoie false si l'amont n'a pas répondu : l'appelant (/stream) peut alors
 * retomber sur FFmpeg au lieu de faire échouer le téléchargement.
 */
async function serveFileProxy(
  req: Request,
  res: Response,
  url: string,
  filename: string
): Promise<boolean> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!parsedUrl.protocol.startsWith('http')) return false;
  } catch {
    return false;
  }

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  if (url.includes('videodownloader') || url.includes('hakunaymatata')) {
    headers['Referer'] = 'https://videodownloader.site/';
  } else if (url.includes('uqload')) {
    headers['Referer'] = 'https://uqload.is/';
  } else if (url.includes('vidzy')) {
    headers['Referer'] = 'https://vidzy.cc/';
  } else if (url.includes('dood') || url.includes('playmogo') || url.includes('d000')) {
    headers['Referer'] = 'https://doodstream.com/';
  } else if (url.includes('voe')) {
    headers['Referer'] = 'https://voe.sx/';
  } else if (url.includes('streamtape')) {
    headers['Referer'] = 'https://streamtape.com/';
  } else {
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;
  }

  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }
  if (req.headers['if-range']) {
    headers['If-Range'] = req.headers['if-range'] as string;
  }

  let response: any;
  try {
    response = await axios({
      method: 'GET',
      url,
      headers,
      responseType: 'stream',
      validateStatus: status => status >= 200 && status < 400
    });
  } catch (error: any) {
    console.error('[Download File Proxy] Amont injoignable:', error.message);
    return false;
  }

  const isIos = /iPhone|iPad|iPod/i.test(req.headers['user-agent'] || '');
  res.status(response.status);

  if (isIos) {
    // Force Safari iOS to trigger native download dialog to Files app
    res.setHeader('Content-Type', 'application/octet-stream');
  } else {
    res.setHeader('Content-Type', (response.headers['content-type'] as string) || 'video/mp4');
  }

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  for (const [key, val] of Object.entries(response.headers)) {
    if (['content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified'].includes(key.toLowerCase())) {
      // Une longueur négative ou non numérique ferait afficher une taille
      // aberrante (-1 ko) par le téléchargeur natif d'iOS : on la rejette.
      if (key.toLowerCase() === 'content-length') {
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0) continue;
      }
      res.setHeader(key, val as string);
    }
  }

  response.data.pipe(res);
  return true;
}

/**
 * GET /api/download/file
 *
 * Proxy de téléchargement haute vitesse avec gestion des noms de fichiers, referers et en-têtes Range
 */
router.get('/file', async (req: Request, res: Response) => {
  try {
    const { url, filename = 'video.mp4' } = req.query as { url?: string; filename?: string };
    if (!url) {
      return res.status(400).json({ success: false, error: 'Paramètre ?url= requis' });
    }

    const target = unwrapUrl(url);
    try {
      if (!new URL(target).protocol.startsWith('http')) throw Error('protocole');
    } catch {
      return res.status(400).json({ success: false, error: 'URL invalide' });
    }

    if (!(await serveFileProxy(req, res, target, filename))) {
      return res.status(502).json({ success: false, error: 'Source de téléchargement injoignable' });
    }
  } catch (error: any) {
    console.error('[Download File Proxy] Erreur:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Erreur proxy de téléchargement' });
    }
  }
});

/**
 * Tente d'obtenir le MP4 direct équivalent à une playlist HLS.
 * Renvoie true uniquement si le fichier a pu être servi (en-têtes écrits).
 */
async function upgradeToDirectFile(
  req: Request,
  res: Response,
  hlsUrl: string,
  filename: string
): Promise<boolean> {
  let direct = null as any;
  try {
    direct = await DirectScraper.resolve(hlsUrl, false);
  } catch (err: any) {
    console.warn('[Download Stream] Échec extraction MP4 direct:', err?.message);
  }
  if (direct?.directUrl && direct.type === 'mp4' && direct.directUrl !== hlsUrl) {
    if (await serveFileProxy(req, res, direct.directUrl, filename)) {
      console.log(`[Download Stream] HLS remplacé par le MP4 direct : ${direct.directUrl.slice(0, 80)}`);
      return true;
    }
  }

  // Les HLS Uqload ne se relèvent pas depuis la playlist : le code du fichier
  // est dans le chemin (/hls2/…/<code>_h/master.m3u8) et l'API Uqload donne le
  // MP4 équivalent, celui qui porte une Content-Length.
  const code = hlsUrl.match(/\/([a-z0-9]{10,})_h\/[^/]*\.m3u8/i)?.[1];
  if (code) {
    try {
      const uq = await getUqloadDirectLink(code, false);
      if (uq?.directUrl && uq.type === 'mp4' && (await serveFileProxy(req, res, uq.directUrl, filename))) {
        console.log(`[Download Stream] HLS Uqload ${code} remplacé par le MP4 direct`);
        return true;
      }
    } catch (err: any) {
      console.warn('[Download Stream] Échec API Uqload:', err?.message);
    }
  }

  return false;
}

/**
 * GET /api/download/stream
 *
 * Proxy de téléchargement HLS vers MP4 via FFmpeg
 */
router.get('/stream', async (req: Request, res: Response) => {
  let m3u8Url = req.query.m3u8 as string;
  if (!m3u8Url) {
    res.status(400).json({ success: false, error: 'm3u8 query param required' });
    return;
  }

  m3u8Url = unwrapUrl(m3u8Url);

  const filename = (req.query.filename as string) || 'video.mp4';

  // Une page lecteur n'est pas une playlist : FFmpeg produirait une réponse
  // 200 vide « chunked » sans Content-Length (taille inconnue côté iOS).
  if (/\.html?(\?|$)|\/embed-|\/e\/|vidlink\.pro|youtube\.com/i.test(m3u8Url)) {
    res.status(400).json({ success: false, error: 'URL de playlist HLS attendue' });
    return;
  }

  // MP4 direct de préférence : le CDN répond avec une vraie Content-Length,
  // donc Safari/iOS affiche une taille et une progression fiables.
  if (await upgradeToDirectFile(req, res, m3u8Url, filename)) return;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');

  const referer = m3u8Url.includes('uqload') ? 'https://uqload.is/' : m3u8Url.includes('vidzy') ? 'https://vidzy.cc/' : '';
  const headers = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n${referer ? `Referer: ${referer}\r\n` : ''}`;

  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-headers', headers,
    '-i', m3u8Url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    'pipe:1',
  ]);

  ffmpeg.stdout.pipe(res);

  ffmpeg.stderr.on('data', () => {});

  ffmpeg.on('close', (code: number | null) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ success: false, error: `FFmpeg exited code ${code}` });
    }
  });

  ffmpeg.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'FFmpeg not found' });
    }
  });

  req.on('close', () => {
    ffmpeg.kill();
  });
});

/**
 * GET /api/download/premium
 *
 * Téléchargement direct 1080p Full HD pour les membres Premium
 */
router.get('/premium', async (req: Request, res: Response) => {
  try {
    const title = req.query.title as string;
    if (!title) {
      res.status(400).json({ success: false, error: 'title query param required' });
      return;
    }

    const { getFrenchStreamMovie } = await import('../frenchstream/frenchstream.service');
    const movie = await getFrenchStreamMovie(title);

    if (!movie?.streamUrl) {
      res.status(404).json({ success: false, error: `Aucune version 1080p trouvée pour "${title}"` });
      return;
    }

    res.redirect(movie.streamUrl);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
