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

      // 1. Priorité au lien direct direct (Vidzy/MP4 OpenOtaku) s'il est actif
      const directUrl = resolveUrl(movie.lien);
      if (directUrl && await isUrlAlive(directUrl)) {
        return { provider: this.name, embedUrl: toEmbedUrl(directUrl), type: 'movie' };
      }

      // 2. Fallback Uqload
      if (movie.uqloadCode) {
        return { provider: this.name, embedUrl: uqloadEmbedUrl(movie.uqloadCode), type: 'movie' };
      }

      // 3. Fallback Streamtape
      if ((movie as any).streamtapeCode) {
        return { provider: this.name, embedUrl: `https://streamtape.com/e/${(movie as any).streamtapeCode}`, type: 'movie' };
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

      // 1. Priorité au lien direct (Vidzy/MP4) s'il est actif
      const directUrl = resolveUrl(ep.lien);
      if (directUrl && await isUrlAlive(directUrl)) {
        return { provider: this.name, embedUrl: toEmbedUrl(directUrl), type: 'episode' };
      }

      // 2. Fallback Uqload
      if (ep.uqloadCode) {
        return { provider: this.name, embedUrl: uqloadEmbedUrl(ep.uqloadCode), type: 'episode' };
      }

      // 3. Fallback Streamtape
      if ((ep as any).streamtapeCode) {
        return { provider: this.name, embedUrl: `https://streamtape.com/e/${(ep as any).streamtapeCode}`, type: 'episode' };
      }

      // 4. Fallback uqloadLink
      if (ep.uqloadLink && await isUrlAlive(ep.uqloadLink)) {
        return { provider: this.name, embedUrl: toEmbedUrl(ep.uqloadLink), type: 'episode' };
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

