import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import axios from 'axios';
import { ProviderManager } from '../streaming/provider-manager';
import { StreamQuery } from '../streaming/providers/provider.interface';
import { DirectScraper, getUqloadDirectLink, extractUqloadCode } from '../streaming/providers/direct-scraper';
import { getOtakuDirectLink } from '../otaku/otaku.service';
import { isSignedLinkExpired } from '../../utils/link-ttl';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import tmdbClient from '../../config/tmdb';

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

function isEmbedOrHtml(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\.html?(\?|$)/i.test(url) || url.includes('/embed-') || url.includes('/e/') || url.includes('/embed/');
}

function isDirectVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\.(mp4|mkv|webm|m3u8)(\?|$)/i.test(url);
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
      language = 'fr',
      originalTitle
    } = req.query as {
      tmdb_id?: string;
      title?: string;
      type?: 'movie' | 'series' | 'anime';
      season?: string;
      episode?: string;
      isPremium?: string;
      language?: string;
      originalTitle?: string;
    };

    const tmdbIdNum = tmdb_id && /^\d+$/.test(tmdb_id) ? parseInt(tmdb_id, 10) : 0;
    const isPrem = isPremium === 'true' || isPremium === '1';
    const isTv = type === 'series' || type === 'anime' || season !== undefined || episode !== undefined;
    const cleanTitle = title
      ? title.replace(/\s*·\s*(?:S\d+)?E\d+.*$/i, '').trim()
      : undefined;

    const userAgent = (req.headers['user-agent'] as string) || '';
    const isIOS = /iPad|iPhone|iPod/i.test(userAgent) || req.query.isIOS === 'true' || req.query.platform === 'ios';

    let frenchTitle: string | undefined;
    let origTitle = originalTitle;

    if (tmdbIdNum) {
      try {
        const tmdbEndpoint = isTv ? `/tv/${tmdbIdNum}?language=fr` : `/movie/${tmdbIdNum}?language=fr`;
        const { data } = await tmdbClient.get(tmdbEndpoint);
        if (isTv) {
          frenchTitle = data?.name;
          origTitle = origTitle || data?.original_name;
        } else {
          frenchTitle = data?.title;
          origTitle = origTitle || data?.original_title;
        }
      } catch (_) {}
    }

    const query: StreamQuery = {
      tmdbId: tmdbIdNum,
      title: cleanTitle || frenchTitle || origTitle,
      frenchTitle,
      originalTitle: origTitle,
      type: type === 'anime' ? 'anime' : (isTv ? 'tv' : 'movie'),
      isAnime: type === 'anime',
      season: season !== undefined ? parseInt(season, 10) : undefined,
      episode: episode !== undefined ? parseInt(episode, 10) : undefined,
      isPremium: isPrem,
      language,
      isIOS,
    };

    console.log(`[Download Resolve] Résolution: "${query.title}" (FR="${frenchTitle || 'N/A'}", VO="${origTitle || 'N/A'}", type=${type}, S${season || 1}E${episode || 1}, premium=${isPrem}, isIOS=${isIOS})`);

    let downloadUrl: string | null = null;
    let fallbackEmbed: string | null = null;
    let iosFallbackUqload: { url: string; directType: 'mp4' | 'hls'; provider: string } | null = null;
    let directType: 'mp4' | 'hls' | 'embed' = 'embed';
    let resolvedProvider = 'chillers';

    const searchTitles = [cleanTitle, frenchTitle, origTitle].filter(Boolean) as string[];

    // 1. Priorité absolue : vérifier la base MongoDB Chillers d'abord (films et séries)
    // On analyse le lien trouvé : si c'est Uqload et que le user est iOS, on le garde en fallback
    // et on cherche un autre lien (FrenchStream/Vidzy MP4 natif).
    if (isTv) {
      const serie = tmdbIdNum
        ? await Serie.findOne({ tmdbId: tmdbIdNum }).lean().exec()
        : searchTitles.length > 0
          ? await Serie.findOne({ $or: searchTitles.map(t => ({ titre: { $regex: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } })) }).lean().exec()
          : null;
      if (serie) {
        const sNum = query.season !== undefined ? Number(query.season) : 1;
        const eNum = query.episode !== undefined ? Number(query.episode) : 1;
        const ep = serie.episodes?.find((e: any) => Number(e.season) === sNum && Number(e.episodeNumber) === eNum);
        if (ep) {
          const uqCode = ep.uqloadCode || (ep.uqloadLink ? extractUqloadCode(ep.uqloadLink) : null) || (ep.lien ? extractUqloadCode(ep.lien) : null);
          if (uqCode) {
            const uq = await getUqloadDirectLink(uqCode, false);
            if (uq?.directUrl && !isEmbedOrHtml(uq.directUrl)) {
              if (isIOS) {
                console.log(`[Download Resolve] MongoDB a un lien Uqload pour la série mais client=iOS → conservé comme fallback`);
                iosFallbackUqload = {
                  url: uq.directUrl,
                  directType: uq.type === 'hls' ? 'hls' : 'mp4',
                  provider: 'uqload'
                };
              } else {
                downloadUrl = uq.directUrl;
                directType = uq.type === 'hls' ? 'hls' : 'mp4';
                resolvedProvider = 'uqload';
              }
            }
          }
          if (!downloadUrl && !iosFallbackUqload && ep.uqloadLink && !isEmbedOrHtml(ep.uqloadLink) && /\.mp4(\?|$)/i.test(ep.uqloadLink) && !isSignedLinkExpired(ep.uqloadLink)) {
            if (isIOS && /uqload/i.test(ep.uqloadLink)) {
              console.log(`[Download Resolve] MongoDB a un uqloadLink pour la série mais client=iOS → conservé comme fallback`);
              iosFallbackUqload = { url: ep.uqloadLink, directType: 'mp4', provider: 'uqload' };
            } else {
              downloadUrl = ep.uqloadLink;
              directType = 'mp4';
              resolvedProvider = 'uqload';
            }
          }
          // Lien direct non-Uqload stocké en base (MP4 direct)
          if (!downloadUrl && ep.lien && !isSignedLinkExpired(ep.lien) && !isEmbedOrHtml(ep.lien) && isDirectVideoUrl(ep.lien) && !/uqload|vidzy/i.test(ep.lien)) {
            downloadUrl = ep.lien;
            directType = /\.m3u8(\?|$)/i.test(ep.lien) ? 'hls' : 'mp4';
            resolvedProvider = 'mongodb';
          }
          if (!downloadUrl && !iosFallbackUqload) {
            const cand = ep.lien || ep.uqloadLink || null;
            if (cand && !isSignedLinkExpired(cand)) {
              if (isIOS && /uqload/i.test(cand)) {
                iosFallbackUqload = { url: cand, directType: 'mp4', provider: 'uqload' };
              } else {
                fallbackEmbed = cand;
              }
            }
          }
        }
      }
    } else {
      const movie = tmdbIdNum
        ? await Movie.findOne({ tmdbId: tmdbIdNum }).lean().exec()
        : searchTitles.length > 0
          ? await Movie.findOne({ $or: searchTitles.map(t => ({ titre: { $regex: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } })) }).lean().exec()
          : null;
      if (movie) {
        const uqCode = movie.uqloadCode || (movie.uqloadLink ? extractUqloadCode(movie.uqloadLink) : null) || (movie.lien ? extractUqloadCode(movie.lien) : null);
        if (uqCode) {
          const uq = await getUqloadDirectLink(uqCode, false);
          if (uq?.directUrl && !isEmbedOrHtml(uq.directUrl)) {
            if (isIOS) {
              console.log(`[Download Resolve] MongoDB a un lien Uqload pour "${movie.titre}" mais client=iOS → conservé comme fallback`);
              iosFallbackUqload = {
                url: uq.directUrl,
                directType: uq.type === 'hls' ? 'hls' : 'mp4',
                provider: 'uqload'
              };
            } else {
              downloadUrl = uq.directUrl;
              directType = uq.type === 'hls' ? 'hls' : 'mp4';
              resolvedProvider = 'uqload';
            }
          }
        }
        if (!downloadUrl && !iosFallbackUqload && movie.uqloadLink && !isEmbedOrHtml(movie.uqloadLink) && /\.mp4(\?|$)/i.test(movie.uqloadLink) && !isSignedLinkExpired(movie.uqloadLink)) {
          if (isIOS && /uqload/i.test(movie.uqloadLink)) {
            console.log(`[Download Resolve] MongoDB a un uqloadLink pour "${movie.titre}" mais client=iOS → conservé comme fallback`);
            iosFallbackUqload = { url: movie.uqloadLink, directType: 'mp4', provider: 'uqload' };
          } else {
            downloadUrl = movie.uqloadLink;
            directType = 'mp4';
            resolvedProvider = 'uqload';
          }
        }
        // Lien direct non-Uqload stocké en base (MP4 direct)
        if (!downloadUrl && movie.lien && !isSignedLinkExpired(movie.lien) && !isEmbedOrHtml(movie.lien) && isDirectVideoUrl(movie.lien) && !/uqload|vidzy/i.test(movie.lien)) {
          downloadUrl = movie.lien;
          directType = /\.m3u8(\?|$)/i.test(movie.lien) ? 'hls' : 'mp4';
          resolvedProvider = 'mongodb';
        }
        if (!downloadUrl && !iosFallbackUqload) {
          const cand = movie.lien || movie.uqloadLink || null;
          if (cand && !isSignedLinkExpired(cand)) {
            if (isIOS && /uqload/i.test(cand)) {
              iosFallbackUqload = { url: cand, directType: 'mp4', provider: 'uqload' };
            } else {
              fallbackEmbed = cand;
            }
          }
        }
      }
    }

    // 2. ProviderManager (FrenchStream, AfroLandTV, Otaku, etc.)
    if (!downloadUrl || isEmbedOrHtml(downloadUrl)) {
      const providerOpts = isIOS && iosFallbackUqload
        ? { only: ['frenchstream', 'afroland', 'frenchanime', 'otaku', 'fawesome'] }
        : undefined;

      const streamResult = isTv
        ? await providerManager.getEpisodeStream(query, providerOpts)
        : await providerManager.getMovieStream(query, providerOpts);

      if (streamResult) {
        resolvedProvider = streamResult.provider;
        // Priorité 1 : URL MP4 directe déjà enrichie / en cache
        if (streamResult.directUrl && !isEmbedOrHtml(streamResult.directUrl)) {
          downloadUrl = streamResult.directUrl;
          directType = streamResult.directType || (/\.m3u8(\?|$)/i.test(downloadUrl) ? 'hls' : 'mp4');
        } else if (streamResult.downloadUrl && !isEmbedOrHtml(streamResult.downloadUrl)) {
          downloadUrl = unwrapUrl(streamResult.downloadUrl) || streamResult.downloadUrl;
          directType = streamResult.directType || (/\.m3u8(\?|$)/i.test(downloadUrl) ? 'hls' : 'mp4');
        } else {
          // Si on n'a qu'un embed, on le garde comme cible pour l'étape d'extraction
          const candidate = streamResult.downloadUrl || streamResult.embedUrl;
          if (candidate) {
            downloadUrl = unwrapUrl(candidate) || candidate;
            directType = 'embed';
          }
        }
      }
    }

    // 3. Fallback iOS : si aucun autre provider n'a renvoyé de flux direct, on réutilise le lien Uqload MongoDB
    if ((!downloadUrl || isEmbedOrHtml(downloadUrl)) && iosFallbackUqload) {
      console.log(`[Download Resolve] iOS: Aucun autre provider direct trouvé, fallback sur MongoDB (${iosFallbackUqload.provider})`);
      downloadUrl = iosFallbackUqload.url;
      directType = iosFallbackUqload.directType;
      resolvedProvider = iosFallbackUqload.provider;
    }

    // 4. Fallback sur l'embed trouvé en base si le ProviderManager n'a rien renvoyé
    if (!downloadUrl && fallbackEmbed) {
      downloadUrl = fallbackEmbed;
      directType = 'embed';
    }

    if (!downloadUrl) {
      return res.status(404).json({
        success: false,
        error: 'Aucune source de téléchargement trouvée pour ce contenu',
        data: null
      });
    }

    // 4. Si on a une URL Uqload interne /api/download/uqload/<code>, la résoudre en MP4
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

    // 5. Si downloadUrl est un embed HTML ou non direct, extraire le flux MP4 direct
    if (downloadUrl && (isEmbedOrHtml(downloadUrl) || directType === 'embed')) {
      try {
        // A. Uqload direct via scraper embed (obfuscation PACKER bypass)
        const uqCode = extractUqloadCode(downloadUrl);
        if (uqCode) {
          const uqDirect = await DirectScraper.scrapeUqloadEmbedDirect(uqCode);
          if (uqDirect?.directUrl && !isEmbedOrHtml(uqDirect.directUrl)) {
            downloadUrl = uqDirect.directUrl;
            directType = uqDirect.type === 'hls' || /\.m3u8/i.test(uqDirect.directUrl) ? 'hls' : 'mp4';
            console.log(`[Download Resolve] ✅ Uqload Direct extrait: ${downloadUrl.slice(0, 80)}...`);
          }
        }

        // B. Vidzy direct (scraper direct Vidzy + fallback OpenOtaku API)
        if (downloadUrl && (isEmbedOrHtml(downloadUrl) || directType === 'embed') && DirectScraper.isVidzyUrl(downloadUrl)) {
          const vidzyDirect = await DirectScraper.scrapeVidzyEmbed(downloadUrl);
          if (vidzyDirect?.directUrl && !isEmbedOrHtml(vidzyDirect.directUrl)) {
            downloadUrl = vidzyDirect.directUrl;
            directType = vidzyDirect.type === 'hls' || /\.m3u8/i.test(vidzyDirect.directUrl) ? 'hls' : 'mp4';
            console.log(`[Download Resolve] ✅ Vidzy Direct extrait: ${downloadUrl.slice(0, 80)}...`);
          } else {
            // Fallback OpenOtaku API pour Vidzy / LuluVid
            const otakuDirect = await getOtakuDirectLink(downloadUrl);
            if (otakuDirect && !isEmbedOrHtml(otakuDirect)) {
              downloadUrl = otakuDirect;
              directType = /\.m3u8/i.test(otakuDirect) ? 'hls' : 'mp4';
              console.log(`[Download Resolve] ✅ OpenOtaku API direct extrait: ${downloadUrl.slice(0, 80)}...`);
            }
          }
        }

        // C. DirectScraper généraliste (Doodstream, etc.)
        if (downloadUrl && (isEmbedOrHtml(downloadUrl) || directType === 'embed')) {
          const direct = await DirectScraper.resolve(downloadUrl, false);
          if (direct?.directUrl && !isEmbedOrHtml(direct.directUrl)) {
            downloadUrl = direct.directUrl;
            directType = direct.type === 'hls' || /\.m3u8/i.test(direct.directUrl) ? 'hls' : 'mp4';
            console.log(`[Download Resolve] ✅ ${directType.toUpperCase()} direct extrait avec succès pour download: ${downloadUrl.slice(0, 80)}...`);
          }
        }
      } catch (err: any) {
        console.warn(`[Download Resolve] Échec extraction direct:`, err.message);
      }
    }

    // Dernier filet : ne jamais livrer une signature déjà expirée. Le CDN
    // répond 403 (page nginx) au client au moment du téléchargement, ce qui se
    // traduit par « certains liens renvoient un 403 » côté utilisateur.
    if (isSignedLinkExpired(downloadUrl)) {
      console.warn(`[Download Resolve] ⚠️ Lien final expiré (${resolvedProvider}) rejeté: ${downloadUrl.slice(0, 90)}`);
      return res.status(404).json({
        success: false,
        error: "Le lien de téléchargement a expiré chez l'hébergeur. Relance la résolution.",
        data: null,
      });
    }

    // Nettoyage propre du nom de fichier (sans les triples underscores)
    const safeTitle = (title || 'video')
      .replace(/\s*:\s*/g, ' - ')
      .replace(/[/\\?%*:|"<>]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const cleanFilename = `${safeTitle}${isTv ? `_S${season || 1}E${episode || 1}` : ''}.mp4`;

    // Une URL d'hébergeur sans extension vidéo (vidlink.pro/tv/...) n'est pas repérée par
    // isEmbedOrHtml : on exige donc un fichier direct ou l'un de nos proxies, sinon le client
    // naviguerait sur la page de l'hébergeur au lieu de télécharger.
    const isHtml = isEmbedOrHtml(downloadUrl);
    const isServedFile = isDirectVideoUrl(downloadUrl) || downloadUrl.includes('/api/download/');
    if (isHtml || !isServedFile) {
      console.warn(`[Download Resolve] ⚠️ URL finale non téléchargeable (${downloadUrl}) → rejeté pour éviter d'ouvrir une page web au lieu de télécharger.`);
      return res.status(404).json({
        success: false,
        error: "Ce contenu est disponible en streaming iframe mais aucun fichier vidéo brut (MP4) n'a pu être extrait pour le téléchargement direct.",
        data: null
      });
    }

    const isHls = (directType === 'hls' || /\.m3u8(\?|$)/i.test(downloadUrl));
    const isMp4Direct = (directType === 'mp4' || /\.mp4(\?|$)/i.test(downloadUrl));

    let finalDownloadUrl: string;

    if (isMp4Direct && downloadUrl.startsWith('http')) {
      // iOS : WebKit ignore l'attribut download cross-origin et lit le MP4 inline
      // si le serveur ne renvoie pas Content-Disposition: attachment. On passe
      // donc TOUJOURS par le proxy /file sur iOS (headers safari-safe).
      if (isIOS) {
        finalDownloadUrl = `/api/download/file?url=${encodeURIComponent(downloadUrl)}&filename=${encodeURIComponent(cleanFilename)}`;
        console.log(`[Download Resolve] MP4 direct client=iOS → file proxy: ${downloadUrl.slice(0, 80)}...`);
      } else if (DirectScraper.isVidzyUrl(downloadUrl) || (!downloadUrl.includes('/api/') && /\.mp4(\?|$)/i.test(downloadUrl))) {
        // Pour Vidzy et tous les hébergeurs MP4 direct qui gèrent le téléchargement natif (comme OpenOtaku) :
        // On sert l'URL directe pour une vitesse maximale et éviter que le proxy Node.js ne coupe la connexion
        // ou ne produise des fichiers corrompus de 0 ko ou 55 bytes.
        finalDownloadUrl = downloadUrl;
        console.log(`[Download Resolve] MP4 direct (mode OpenOtaku direct): ${downloadUrl.slice(0, 80)}...`);
      } else {
        finalDownloadUrl = `/api/download/file?url=${encodeURIComponent(downloadUrl)}&filename=${encodeURIComponent(cleanFilename)}`;
        console.log(`[Download Resolve] MP4 direct → file proxy: ${downloadUrl.slice(0, 80)}...`);
      }
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
      decompress: false,
      validateStatus: status => status >= 200 && status < 400
    });
  } catch (error: any) {
    const upstreamStatus = error?.response?.status;
    console.error(
      `[Download File Proxy] Amont en échec${upstreamStatus ? ` (HTTP ${upstreamStatus})` : ''}: ${error.message} — ${url.slice(0, 90)}`,
    );
    return false;
  }

  const upstreamContentType = String(response.headers['content-type'] || '').toLowerCase();
  if (upstreamContentType.includes('text/html')) {
    console.warn(`[Download File Proxy] ⚠️ L'amont a renvoyé du HTML (text/html) au lieu d'un fichier binaire pour: ${url}`);
    return false;
  }

  res.status(response.status);

  // Pour iOS Safari et tous les navigateurs modernes :
  // Toujours renvoyer un Content-Type vidéo explicite (video/mp4)
  // Surtout PAS "application/octet-stream" qui perturbe la négociation HTTP Range sur WebKit
  const upstreamType = (response.headers['content-type'] as string) || '';
  const contentType = (upstreamType && !upstreamType.includes('text/html') && upstreamType !== 'application/octet-stream')
    ? upstreamType
    : 'video/mp4';
  res.setHeader('Content-Type', contentType);

  // Format RFC 6266 conforme pour Content-Disposition:
  // - filename="ascii.mp4" (sans caractères spéciaux pour que Safari iOS ne tronque pas)
  // - filename*=UTF-8''encoded.mp4 (pour préserver le titre complet et les accents)
  const safeAsciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encodedFilename = encodeURIComponent(filename);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeAsciiFilename}"; filename*=UTF-8''${encodedFilename}`
  );

  // Indispensable pour Safari iOS : déclarer Accept-Ranges
  res.setHeader('Accept-Ranges', 'bytes');

  for (const [key, val] of Object.entries(response.headers)) {
    const lowerKey = key.toLowerCase();
    if (['content-length', 'content-range', 'etag', 'last-modified'].includes(lowerKey)) {
      // Une longueur négative ou non numérique ferait afficher une taille
      // aberrante (-1 ko) par le téléchargeur natif d'iOS : on la rejette.
      if (lowerKey === 'content-length') {
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0) continue;
      }
      res.setHeader(key, val as string);
    }
  }

  // Nettoyer la connexion amont si le client iOS ferme ou annule
  req.on('close', () => {
    if (response?.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }
  });

  response.data.pipe(res);
  return true;
}

/**
 * GET /api/download/file
 *
 * Proxy de téléchargement haute vitesse avec gestion des noms de fichiers, referers et en-têtes Range
 */
router.get('/file', async (req: Request, res: Response) => {
  let target = '';
  try {
    const { url, filename = 'video.mp4' } = req.query as { url?: string; filename?: string };
    if (!url) {
      return res.status(400).json({ success: false, error: 'Paramètre ?url= requis' });
    }

    target = unwrapUrl(url);
    try {
      if (!new URL(target).protocol.startsWith('http')) throw Error('protocole');
    } catch {
      return res.status(400).json({ success: false, error: 'URL invalide' });
    }

    if (!(await serveFileProxy(req, res, target, filename))) {
      console.warn(`[Download File Proxy] Proxy échoué pour ${target.slice(0, 80)}...`);
      // Rediriger le navigateur vers une signature morte afficherait la page
      // 403 de l'hébergeur : on renvoie plutôt une erreur claire.
      if (isSignedLinkExpired(target)) {
        return res.status(502).json({
          success: false,
          error: "Ce lien de téléchargement a expiré chez l'hébergeur. Relance la résolution.",
        });
      }
      if (target.includes('uqload') || target.includes('vidzy')) {
        return res.status(502).json({
          success: false,
          error: "Ce lien de téléchargement a expiré ou est inaccessible auprès de l'hébergeur."
        });
      }
      return res.redirect(target);
    }
  } catch (error: any) {
    console.error('[Download File Proxy] Erreur:', error.message);
    if (!res.headersSent) {
      return res.redirect(target || '/');
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
  const code = hlsUrl.match(/\/([a-z0-9]{10,})_h\/[^/]*\.m3u8/i)?.[1]
    || hlsUrl.match(/\/([a-z0-9]{10,})_[a-z,]+\.urlset/i)?.[1]
    || extractUqloadCode(hlsUrl);
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

  // Une playlist signée expirée ferait échouer FFmpeg en silence (réponse
  // 200 « chunked » vide). On le signale proprement côté client.
  if (isSignedLinkExpired(m3u8Url)) {
    res.status(502).json({
      success: false,
      error: "Le lien de streaming a expiré chez l'hébergeur. Relance la résolution.",
    });
    return;
  }

  // Une page lecteur n'est pas une playlist : FFmpeg produirait une réponse
  // 200 vide « chunked » sans Content-Length (taille inconnue côté iOS).
  if (/\.html?(\?|$)|\/embed-|\/e\/|vidlink\.pro|youtube\.com/i.test(m3u8Url)) {
    res.status(400).json({ success: false, error: 'URL de playlist HLS attendue' });
    return;
  }

  // MP4 direct de préférence : le CDN répond avec une vraie Content-Length,
  // donc Safari/iOS affiche une taille et une progression fiables.
  if (await upgradeToDirectFile(req, res, m3u8Url, filename)) return;

  const safeAsciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encodedFilename = encodeURIComponent(filename);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeAsciiFilename}"; filename*=UTF-8''${encodedFilename}`
  );
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

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
