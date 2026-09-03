import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import { isSignedLinkExpired } from '../../utils/link-ttl';
import axios from 'axios';

function toEmbedUrl(lien: string): string {
  const match = lien.match(/(?:doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\/([a-zA-Z0-9]+)/i);
  if (match) return `https://doodstream.com/e/${match[1]}`;
  const stMatch = lien.match(/streamtape\.com\/(?:e|v|f)\/([a-zA-Z0-9]+)/i);
  if (stMatch) return `https://streamtape.com/e/${stMatch[1]}`;
  return lien;
}

/** URL du lecteur iframe Uqload à partir d'un file code. */
function uqloadEmbedUrl(code: string): string {
  return `https://uqload.is/embed-${code}.html`;
}

/** Retourne l'URL si elle est valide et non expirée, sinon null. */
function resolveUrl(url: string | undefined | null): string | null {
  if (!url || url === '#') return null;
  if (isSignedLinkExpired(url)) return null;
  return url;
}

function isEmbedOrProtectedUrl(url: string): boolean {
  return /doodstream|playmogo|d000d|d0000d|dood\.|vidlink|vidapi|uqload|streamtape|youtube|embed|\/e\//i.test(url);
}

/** HEAD check rapide pour savoir si l'URL est joignable (pas morte). */
async function isUrlAlive(url: string): Promise<boolean> {
  if (isEmbedOrProtectedUrl(url)) return true;
  try {
    const res = await axios.head(url, {
      timeout: 3000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 3,
      validateStatus: (s) => s < 400,
    });
    return true;
  } catch {
    try {
      const res = await axios.get(url, {
        timeout: 3000,
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        maxRedirects: 3,
        validateStatus: (s) => s < 400,
      });
      res.data.destroy();
      return true;
    } catch {
      return false;
    }
  }
}

async function isUqloadAlive(code: string): Promise<boolean> {
  if (!code) return false;
  try {
    const res = await axios.get(`https://uqload.is/embed-${code}.html`, {
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      validateStatus: (s) => s === 200,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    if (
      html.includes('File is no longer available') ||
      html.includes('expired or has been deleted') ||
      html.includes('File Not Found') ||
      (html.includes('deleted') && html.includes('expired'))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class MongoDBProvider implements StreamingProvider {
  readonly name = 'mongodb';

  supports(_query: StreamQuery): boolean {
    return true;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    try {
      // Priority 1: exact tmdbId match
      let movie = query.tmdbId ? await Movie.findOne({ tmdbId: query.tmdbId }).exec() : null;
      // Priority 2: title regex fallback
      if (!movie && query.title) {
        const escaped = query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        movie = await Movie.findOne({ titre: { $regex: new RegExp(escaped, 'i') } }).exec();
      }
      if (!movie) return null;

      // 0. Si le film a des sources multiples enregistrées
      if (movie.sources && movie.sources.length > 0) {
        // Pour les utilisateurs Premium, prioriser les sources 1080p ou marquées isPremium
        const sortedSources = [...movie.sources].sort((a, b) => {
          if (query.isPremium) {
            const scoreA = (a.quality === '1080p' ? 2 : 0) + (a.isPremium ? 1 : 0);
            const scoreB = (b.quality === '1080p' ? 2 : 0) + (b.isPremium ? 1 : 0);
            return scoreB - scoreA;
          }
          return 0;
        });

        for (const s of sortedSources) {
          const u = resolveUrl(s.url);
          if (u && await isUrlAlive(u)) {
            return {
              provider: s.source || this.name,
              embedUrl: toEmbedUrl(u),
              type: 'movie'
            };
          }
        }
      }

      // 1. Priorité au lien direct (Vidzy/MP4 OpenOtaku) s'il est actif
      const directUrl = resolveUrl(movie.lien);
      if (directUrl && await isUrlAlive(directUrl)) {
        return { provider: movie.source || this.name, embedUrl: toEmbedUrl(directUrl), type: 'movie' };
      }

      // 2. Fallback Uqload (vérification active de la disponibilité du fichier)
      if (movie.uqloadCode) {
        const alive = await isUqloadAlive(movie.uqloadCode);
        if (alive) {
          return { provider: 'uqload', embedUrl: uqloadEmbedUrl(movie.uqloadCode), type: 'movie' };
        } else {
          console.log(`[MongoDB] Uqload code ${movie.uqloadCode} est expiré/mort pour "${movie.titre}" → suppression et passage aux autres sources`);
          Movie.updateOne({ _id: movie._id }, { $unset: { uqloadCode: 1, uqloadLink: 1 } }).exec().catch(() => {});
        }
      }

      // 3. Fallback Streamtape
      if ((movie as any).streamtapeCode) {
        return { provider: 'streamtape', embedUrl: `https://streamtape.com/e/${(movie as any).streamtapeCode}`, type: 'movie' };
      }

      // 4. Fallback lien secondaire
      const fallbackUrl = resolveUrl((movie as any).lienFallback);
      if (fallbackUrl && await isUrlAlive(fallbackUrl)) {
        return { provider: this.name, embedUrl: toEmbedUrl(fallbackUrl), type: 'movie' };
      }

      console.log(`[MongoDB] Aucun lien valide pour "${movie.titre}" → fallback providers`);
      return null;
    } catch (err) {
      console.error('[MongoDB] getMovieStream error:', err);
    }
    return null;
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    if (query.season === undefined || query.episode === undefined) return null;

    try {
      let serie = query.tmdbId ? await this.findSerie(query) : null;
      if (!serie && query.title) {
        const escaped = query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const byTitle = await Serie.find({ titre: { $regex: new RegExp(escaped, 'i') } }).exec();
        if (byTitle.length) {
          const bySeason = byTitle.find(s => s.episodes?.some(
            (e: any) => Number(e.season) === Number(query.season)
          ));
          serie = bySeason || byTitle[0];
        }
      }

      if (!serie) return null;

      let ep = serie.episodes?.find(
        (e: any) => Number(e.season) === Number(query.season) && Number(e.episodeNumber) === Number(query.episode)
      );

      if (!ep) return null;

      // 0. Si l'épisode a des sources multiples enregistrées
      if (ep.sources && ep.sources.length > 0) {
        const sortedSources = [...ep.sources].sort((a, b) => {
          if (query.isPremium) {
            const scoreA = (a.quality === '1080p' ? 2 : 0) + (a.isPremium ? 1 : 0);
            const scoreB = (b.quality === '1080p' ? 2 : 0) + (b.isPremium ? 1 : 0);
            return scoreB - scoreA;
          }
          return 0;
        });

        for (const s of sortedSources) {
          const u = resolveUrl(s.url);
          if (u && await isUrlAlive(u)) {
            return {
              provider: s.source || this.name,
              embedUrl: toEmbedUrl(u),
              type: 'episode'
            };
          }
        }
      }

      // 1. Priorité au lien direct (Vidzy/MP4) s'il est actif
      const directUrl = resolveUrl(ep.lien);
      if (directUrl && await isUrlAlive(directUrl)) {
        return { provider: ep.source || this.name, embedUrl: toEmbedUrl(directUrl), type: 'episode' };
      }

      // 2. Fallback Uqload (vérification active)
      if (ep.uqloadCode) {
        const alive = await isUqloadAlive(ep.uqloadCode);
        if (alive) {
          return { provider: 'uqload', embedUrl: uqloadEmbedUrl(ep.uqloadCode), type: 'episode' };
        } else {
          console.log(`[MongoDB] Uqload code ${ep.uqloadCode} est expiré/mort pour S${query.season}E${query.episode} de "${serie.titre}" → suppression`);
        }
      }

      // 3. Fallback Streamtape
      if ((ep as any).streamtapeCode) {
        return { provider: 'streamtape', embedUrl: `https://streamtape.com/e/${(ep as any).streamtapeCode}`, type: 'episode' };
      }

      // 4. Fallback uqloadLink
      if (ep.uqloadLink && await isUrlAlive(ep.uqloadLink)) {
        return { provider: 'uqload', embedUrl: toEmbedUrl(ep.uqloadLink), type: 'episode' };
      }

      console.log(`[MongoDB] Aucun lien valide pour S${query.season}E${query.episode} de "${serie.titre}" → fallback providers`);
      return null;
    } catch (err) {
      console.error('[MongoDB] getEpisodeStream error:', err);
    }
    return null;
  }

  private async findSerie(query: StreamQuery): Promise<any> {
    if (query.tmdbId) {
      const byId = await Serie.find({ tmdbId: query.tmdbId }).exec();
      if (byId.length) {
        if (query.season !== undefined) {
          const bySeason = byId.find(s => s.episodes?.some(
            (e: any) => Number(e.season) === Number(query.season)
          ));
          if (bySeason) return bySeason;
        }
        return byId[0];
      }
    }
    return null;
  }
}

