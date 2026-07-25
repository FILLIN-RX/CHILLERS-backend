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
      const movie = await Movie.findOne({
        $or: [
          ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
          ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
        ],
      }).exec();

      if (!movie) return null;

      // Priorité au streaming Uqload via son lecteur iframe (embed-<code>.html)
      // dès qu'un fichier Uqload est prêt (uqloadCode + uqloadLink confirmé).
      // On n'utilise PAS le lien direct .mp4 pour le streaming : il est signé,
      // éphémère et servi depuis un CDN non whitelisté (CSP media-src) → il ne
      // sert qu'au téléchargement. L'iframe Uqload ne périme pas.
      if (movie.uqloadCode && movie.uqloadLink) {
        return { provider: this.name, embedUrl: uqloadEmbedUrl(movie.uqloadCode), type: 'movie' };
      }

      // Fallback: lien stocké (embed DoodStream), converti en /e/.
      // resolveUrl() vérifie que le lien n'est pas expiré (timestamp e=)
      // isUrlAlive() vérifie que le serveur répond (HEAD)
      const url = resolveUrl(movie.lien);
      if (url && await isUrlAlive(url)) {
        return { provider: this.name, embedUrl: toEmbedUrl(url), type: 'movie' };
      }

      console.log(`[MongoDB] Aucun lien valide pour "${movie.titre}" (uqload + lien morts ou expirés) → fallback`);
      return null;
    } catch (err) {
      console.error('[MongoDB] getMovieStream error:', err);
    }
    return null;
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    if (query.season === undefined || query.episode === undefined) return null;

    try {
      const serie = await Serie.findOne({
        $or: [
          ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
          ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
        ],
      }).exec();

      if (!serie) return null;

      let ep = serie.episodes.find(
        (e: any) => Number(e.season) === Number(query.season) && Number(e.episodeNumber) === Number(query.episode)
      );

      // Fallback: if requested season/episode is missing, use the first available episode in DB
      if (!ep || (!ep.uqloadLink && !ep.lien)) {
        const fallbackEp = serie.episodes.find((e: any) => (e.uqloadLink && e.uqloadLink !== '#') || (e.lien && e.lien !== '#'));
        if (fallbackEp) {
          console.log(`[MongoDB] S${query.season}E${query.episode} indisponible, fallback vers S${fallbackEp.season}E${fallbackEp.episodeNumber} pour "${serie.titre}"`);
          ep = fallbackEp;
        }
      }

      if (!ep) return null;

      // Priorité au lecteur iframe Uqload quand le fichier est prêt.
      if (ep.uqloadCode && ep.uqloadLink) {
        return { provider: this.name, embedUrl: uqloadEmbedUrl(ep.uqloadCode), type: 'episode' };
      }

      // Fallback: lien stocké (embed DoodStream).
      const url = resolveUrl(ep.lien);
      if (url && await isUrlAlive(url)) {
        return { provider: this.name, embedUrl: toEmbedUrl(url), type: 'episode' };
      }

      console.log(`[MongoDB] Aucun lien valide pour S${query.season}E${query.episode} de "${serie.titre}" → fallback`);
      return null;
    } catch (err) {
      console.error('[MongoDB] getEpisodeStream error:', err);
    }
    return null;
  }
}

