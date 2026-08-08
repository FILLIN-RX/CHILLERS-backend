import axios from 'axios';
import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';
import { getFileDownloadUrl } from '../../modules/doodstream/doodstream.service';
import Serie from '../../models/Serie';
import Movie from '../../models/Movie';

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

/**
 * Extrait le fileCode d'une URL DoodStream/Playmogo (/e/ ou /d/).
 */
function extractDoodFileCode(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\/([a-zA-Z0-9]+)/i);
  return m ? m[1] : null;
}

/**
 * Source unique : MongoDB. Plus de fallback JSON.
 * Priorité stricte : tmdbId → titre. Si plusieurs docs ont le même tmdbId
 * (séries homonymes), prendre celui qui contient la saison demandée.
 */
async function findByMongoDB(query: StreamQuery): Promise<{ fileCode: string; info: any } | null> {
  try {
    if (query.type === 'movie' || (!query.season && !query.episode)) {
      // 1. tmdbId strict
      let movie = query.tmdbId
        ? await Movie.findOne({ tmdbId: query.tmdbId }).exec()
        : null;
      // 2. fallback sur titre exact (uniquement si tmdbId absent)
      if (!movie && !query.tmdbId && query.title) {
        const escaped = query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        movie = await Movie.findOne({ titre: { $regex: new RegExp(`^${escaped}$`, 'i') } }).exec();
      }
      if (movie?.lien) {
        // Ne retourner QUE si le lien est hébergé sur Doodstream/Playmogo
        const isDoodstreamLien =
          /doodstream\.com|dood\.to|dood\.sh|dood\.so|dood\.cx|dood\.la|dood\.wf|dood\.pm|playmogo\.com/i
            .test(movie.lien);
        if (isDoodstreamLien) {
          console.log(`[DoodStream] MongoDB match movie="${movie.titre}" → ${movie.lien.slice(0, 60)}`);
          return {
            fileCode: extractDoodFileCode(movie.lien) || extractDoodFileCode(movie.uqloadLink) || '',
            info: { lien: movie.lien, titre: movie.titre },
          };
        }
      }
    }

    if (query.season !== undefined && query.episode !== undefined) {
      // 1. tmdbId strict
      let series: any = null;
      if (query.tmdbId) {
        const byId = await Serie.find({ tmdbId: query.tmdbId }).exec();
        if (byId.length) {
          series = byId.find((s: any) => s.episodes?.some(
            (e: any) => Number(e.season) === Number(query.season)
          )) || byId[0];
        }
      }
      // 2. fallback sur titre exact (uniquement si tmdbId absent)
      if (!series && !query.tmdbId && query.title) {
        const escaped = query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        series = await Serie.findOne({ titre: { $regex: new RegExp(`^${escaped}$`, 'i') } }).exec();
      }

      if (series) {
        const found = series.episodes.find(
          (ep: any) => Number(ep.season) === Number(query.season) && Number(ep.episodeNumber) === Number(query.episode)
        );
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

export class DoodStreamProvider implements StreamingProvider {
  readonly name = 'doodstream';

  supports(query: StreamQuery): boolean {
    return !!query.title || !!query.tmdbId;
  }

  private async findFile(query: StreamQuery): Promise<{ fileCode: string; info: any } | null> {
    const match = await findByMongoDB(query);
    if (match) {
      console.log(`[DoodStream] Match by MongoDB for tmdbId=${query.tmdbId} title="${query.title}"`);
      return match;
    }

    console.log(`[DoodStream] No match for tmdbId=${query.tmdbId} title="${query.title}" S${query.season}E${query.episode}`);
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
