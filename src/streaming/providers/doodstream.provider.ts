import fs from 'fs';
import axios from 'axios';
import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';
import { getFileDownloadUrl, listFiles } from '../../modules/doodstream/doodstream.service';
import Serie from '../../models/Serie';
import Movie from '../../models/Movie';
import { UPLOADED_PATH, SERIES_OUTPUT_PATH } from '../../config/data-paths';

// ─── Background link-validity cache (stale-while-revalidate) ────────────────
// Principle: on the FIRST request we serve the stored URL immediately (fast)
// and fire a background check. If the check fails, the link is marked dead in
// the cache and the NEXT request automatically falls back to the fileCode embed.
// This gives us both speed (zero added latency on stream start) AND reliability
// (dead links are detected and bypassed within one cache cycle).

interface LinkCacheEntry {
  alive: boolean;
  checkedAt: number;   // ms timestamp
  pending: boolean;    // background check in-flight
}

const LINK_CACHE_TTL_ALIVE = 5 * 60 * 1000;   // 5 minutes — re-check alive links
const LINK_CACHE_TTL_DEAD  = 2 * 60 * 1000;   // 2 minutes — retry dead links sooner
const linkCache = new Map<string, LinkCacheEntry>();

/** Returns the cached validity state, or null if unknown/expired. */
function getCachedValidity(url: string): boolean | null {
  const entry = linkCache.get(url);
  if (!entry) return null;
  const ttl = entry.alive ? LINK_CACHE_TTL_ALIVE : LINK_CACHE_TTL_DEAD;
  if (Date.now() - entry.checkedAt > ttl) {
    linkCache.delete(url);
    return null;
  }
  return entry.alive;
}

/** Fires an async HEAD/GET check and updates the cache. Never throws. */
function validateInBackground(url: string): void {
  const existing = linkCache.get(url);
  if (existing?.pending) return; // already in-flight

  linkCache.set(url, { alive: existing?.alive ?? true, checkedAt: existing?.checkedAt ?? Date.now(), pending: true });

  (async () => {
    let alive = false;
    try {
      const res = await axios.head(url, {
        timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        maxRedirects: 5,
      });
      alive = res.status >= 200 && res.status < 400;
    } catch {
      try {
        const res = await axios.get(url, {
          timeout: 4000,
          responseType: 'stream',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          maxRedirects: 5,
        });
        res.data.destroy();
        alive = res.status >= 200 && res.status < 400;
      } catch {
        alive = false;
      }
    }

    linkCache.set(url, { alive, checkedAt: Date.now(), pending: false });
    if (!alive) {
      console.warn(`[DoodStream] Background check: link is dead → ${url.slice(0, 80)}`);
    }
  })();
}


let cachedUploadedFiles: Record<string, any> | null = null;
let lastCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

/**
 * Lecture disque (fallback). En priorité on lit directement dans MongoDB
 * (collection Serie / Movie) — le runtime ne dépend plus de l'état du
 * filesystem. Ce cache disque ne sert qu'à absorber le cas où la base
 * n'est pas encore synchronisée (post-scrape, pré-premier sync).
 */
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
  return str
    .toLowerCase()
    .replace(/[-–—:]/g, ' ')
    .replace(/saison\s*\d+/gi, '')
    .replace(/season\s*\d+/gi, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

const SE_PATTERN = /[Ss](\d+)[Ee](\d+)/;

function parseSeasonEpisode(filename: string): { season: number; episode: number } | null {
  const match = filename.match(SE_PATTERN);
  if (match) {
    return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  }
  return null;
}

export class DoodStreamProvider implements StreamingProvider {
  readonly name = 'doodstream';

  supports(query: StreamQuery): boolean {
    return !!query.title || !!query.tmdbId;
  }

  private findByTmdbId(tmdbId: number, season?: number, episode?: number): { fileCode: string; info: any } | null {
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
        // Sans S/E, garder le premier match série comme fallback
        if (!seriesFallback) {
          seriesFallback = { fileCode: file.fileCode, info: file };
        }
      }
    }
    // Si pas de film trouvé, retourner le premier épisode trouvé
    return seriesFallback;
  }

  private findByTitle(title: string, season?: number, episode?: number): { fileCode: string; info: any } | null {
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

    // Second pass: looser match
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

  private async findByFolderFallback(tmdbId: number, season: number, episode: number): Promise<{ fileCode: string; info: any } | null> {
    // Option B: find the series folderId from any S/E entry for this tmdbId, then list files on DoodStream
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
      // DoodStream API unavailable, return null
    }

    return null;
  }

  private async findByMongoDB(query: StreamQuery): Promise<{ fileCode: string; info: any } | null> {
    try {
      if (query.type === 'movie' || (!query.season && !query.episode)) {
        const movie = await Movie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();
        if (movie?.lien) {
          // Ne retourner QUE si le lien est hébergé sur Doodstream
          const isDoodstreamLien =
            /doodstream\.com|dood\.to|dood\.sh|dood\.so|dood\.cx|dood\.la|dood\.wf|dood\.pm|playmogo\.com/i
              .test(movie.lien);
          if (isDoodstreamLien) {
            console.log(`[DoodStream] MongoDB match movie="${movie.titre}" → ${movie.lien.slice(0, 60)}`);
            return { fileCode: '', info: { lien: movie.lien, titre: movie.titre } };
          }
          // Video non hébergée sur Doodstream → ignorer, le maillon suivant
          // (Otaku) pourra fournir une source alternative
        }
      }

      if (query.season !== undefined && query.episode !== undefined) {
        const safeTitle = query.title
          ? query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : null;
        const series = await Serie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(safeTitle ? [{ titre: { $regex: new RegExp(safeTitle, 'i') } }] : []),
          ],
        }).exec();

        if (series) {
          let found = series.episodes.find(
            (ep: any) => Number(ep.season) === Number(query.season) && Number(ep.episodeNumber) === Number(query.episode)
          );
          if (!found || (!found.fileCode && !found.lien)) {
            found = series.episodes.find((ep: any) => ep.fileCode || (ep.lien && ep.lien !== '#'));
          }
          if (found) {
            const epLabel = `S${String(found.season || 1).padStart(2, '0')}E${String(found.episodeNumber || 1).padStart(2, '0')}`;
            console.log(
              `[DoodStream] MongoDB match series="${series.titre}" ${epLabel} fileCode=${found.fileCode || '∅'}`
            );
            return {
              fileCode: found.fileCode || '',
              info: {
                lien: found.lien,
                titre: `${series.titre} ${epLabel}`,
                fldId: found.fldId,
                tmdbId: found.tmdbId,
              },
            };
          }
        }
      }
    } catch (err) {
      console.error('[DoodStream] MongoDB query error:', err);
    }
    return null;
  }

  private async findFile(query: StreamQuery): Promise<{ fileCode: string; info: any } | null> {
    const season = query.season;
    const episode = query.episode;

    // 1. MongoDB d'abord — c'est la source de vérité après sync.
    //    Rapide, indexé, et profite du shape enrichi (fileCode + season/episodeNumber).
    const mongo = await this.findByMongoDB(query);
    if (mongo) {
      console.log(`[DoodStream] Match by MongoDB for tmdbId=${query.tmdbId} title="${query.title}"`);
      return mongo;
    }

    // 2. Fallback disque — utile si la base n'a pas encore été synchronisée
    //    (post-scrape, pré-premier sync-series-to-mongo).
    if (query.tmdbId) {
      const byId = this.findByTmdbId(query.tmdbId, season, episode);
      if (byId) {
        console.log(`[DoodStream] Match by tmdbId=${query.tmdbId} S${season}E${episode} → ${byId.fileCode}`);
        return byId;
      }
    }

    if (query.title) {
      const byTitle = this.findByTitle(query.title, season, episode);
      if (byTitle) {
        console.log(`[DoodStream] Match by title="${query.title}" S${season}E${episode} → ${byTitle.fileCode}`);
        return byTitle;
      }
    }

    // 3. Option B fallback: si on a season+episode + tmdbId, lister le dossier DoodStream
    if (query.tmdbId && season !== undefined && episode !== undefined) {
      const fallback = await this.findByFolderFallback(query.tmdbId, season, episode);
      if (fallback) {
        console.log(`[DoodStream] Match by folder fallback tmdbId=${query.tmdbId} S${season}E${episode} → ${fallback.fileCode}`);
        return fallback;
      }
    }

    // 4. Dernier recours: match sans S/E
    if (query.tmdbId) {
      const byId = this.findByTmdbId(query.tmdbId);
      if (byId) return byId;
    }
    if (query.title) {
      return this.findByTitle(query.title);
    }

    console.log(`[DoodStream] No match for tmdbId=${query.tmdbId} title="${query.title}" S${season}E${episode}`);
    return null;
  }

  private async getStreamUrl(query: StreamQuery): Promise<string | null> {
    const match = await this.findFile(query);
    if (!match) return null;

    const lien = match.info.lien;

    if (lien && lien !== '#') {
      const cached = getCachedValidity(lien);

      if (cached !== false) {
        // Convert DoodStream / Playmogo download links to embed /e/ URLs
        validateInBackground(lien);
        const m = lien.match(/(?:doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\/([a-zA-Z0-9]+)/i);
        if (m) {
          return `https://doodstream.com/e/${m[1]}`;
        }
        return lien;
      }
    }

    // Fallback: Doodstream/Playmogo embed via fileCode
    if (match.fileCode) return `https://doodstream.com/e/${match.fileCode}`;

    return null;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    const embedUrl = await this.getStreamUrl(query);
    if (!embedUrl) return null;
    return { provider: this.name, embedUrl, type: 'movie' };
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const embedUrl = await this.getStreamUrl(query);
    if (!embedUrl) return null;
    return { provider: this.name, embedUrl, type: 'episode' };
  }

  async getDownloadUrl(title: string, tmdbId?: number): Promise<string | null> {
    const query: StreamQuery = { tmdbId: tmdbId || 0, title };
    const match = await this.findFile(query);
    if (!match) return null;

    // For downloads we can afford a bit more latency: try the API first for
    // a fresh protected URL, then fall back to the stored direct link.
    if (match.fileCode) {
      try {
        const dlUrl = await getFileDownloadUrl(match.fileCode);
        if (dlUrl) return dlUrl;
      } catch {
        // API indisponible, fallback au lien stocké
      }
    }

    if (match.info.lien && match.info.lien !== '#') return match.info.lien;

    return null;
  }
}
