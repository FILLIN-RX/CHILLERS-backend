import fs from 'fs';
import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';
import { scrapeDirectStream, isScrapableUrl } from './direct-scraper';
import { UPLOADED_PATH, SERIES_OUTPUT_PATH } from '../../config/data-paths';
import { isSignedLinkExpired } from '../../utils/link-ttl';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

const TAG = '[DirectProvider]';

/**
 * DirectProvider — tente d'extraire l'URL directe (.mp4 / .m3u8) d'un embed
 * Doodstream ou Uqload, puis construit une URL proxy qui pipe le flux via
 * notre backend (gestion des headers Referer, Range, CORS).
 *
 * Ce provider doit être placé AVANT MongoDBProvider dans la chaîne,
 * car MongoDBProvider renvoie des embed URLs (iframes) qui passent
 * toujours la validation → DirectProvider ne serait jamais appelé.
 *
 * Si le scrape échoue → fallback silencieux vers les providers suivants.
 */
export class DirectProvider implements StreamingProvider {
  readonly name = 'direct';

  supports(_query: StreamQuery): boolean {
    return true;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    return this.resolve(query);
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    return this.resolve(query);
  }

  private async resolve(query: StreamQuery): Promise<StreamResult | null> {
    const label = query.season !== undefined
      ? `S${query.season}E${query.episode} "${query.title}" (tmdb=${query.tmdbId})`
      : `"${query.title}" (tmdb=${query.tmdbId})`;
    console.log(`${TAG} resolve ${label}`);

    // 1. Cherche l'embed URL dans MongoDB ou le JSON
    const embedUrl = await this.findEmbedUrl(query);
    if (!embedUrl) {
      console.log(`${TAG} ${label} → pas d'embed URL trouvée, skip`);
      return null;
    }
    console.log(`${TAG} ${label} → embed URL trouvée: ${embedUrl.slice(0, 100)}`);

    // 2. Vérifie que c'est un embed scrapable (Doodstream ou Uqload)
    if (!isScrapableUrl(embedUrl)) {
      console.log(`${TAG} ${label} → URL non scrapable (ni Doodstream ni Uqload), skip`);
      return null;
    }

    // 3. Scrape pour extraire l'URL directe
    console.log(`${TAG} ${label} → lancement du scrape de ${embedUrl.slice(0, 80)}...`);
    const t0 = Date.now();
    let scraped = await scrapeDirectStream(embedUrl, true);
    let elapsed = Date.now() - t0;

    // 3b. Si le scrape Doodstream échoue (Cloudflare 403), tente l'embed Uqload
    if (!scraped) {
      const uqloadCode = await this.findUqloadCode(query);
      if (uqloadCode) {
        const uqloadEmbedUrl = `https://uqload.is/embed-${uqloadCode}.html`;
        console.log(`${TAG} ${label} → Doodstream échoué, tentative Uqload (${uqloadEmbedUrl})...`);
        const t1 = Date.now();
        scraped = await scrapeDirectStream(uqloadEmbedUrl, true);
        elapsed = Date.now() - t1;
      }
    }

    if (!scraped) {
      console.log(`${TAG} ${label} → scrape échoué en ${elapsed}ms, fallback aux providers suivants`);
      return null;
    }

    // 4. Construit l'URL proxy (backend pipe le flux avec les bons headers)
    const proxyUrl = `/api/doodstream/stream?url=${encodeURIComponent(scraped.directUrl)}&referer=${encodeURIComponent(scraped.referer)}`;

    // 5. Update MongoDB with fresh URL so next request is instant
    this.updateMongoDbFreshUrl(query, scraped.directUrl).catch(() => {});

    console.log(`${TAG} ${label} → SCRAPE RÉUSSI en ${elapsed}ms`);
    console.log(`${TAG}   type: ${scraped.type}`);
    console.log(`${TAG}   directUrl: ${scraped.directUrl.slice(0, 150)}`);
    console.log(`${TAG}   referer: ${scraped.referer}`);
    console.log(`${TAG}   proxyUrl: ${proxyUrl.slice(0, 150)}`);

    return {
      provider: this.name,
      embedUrl: proxyUrl,
      type: query.season !== undefined ? 'episode' : 'movie',
    };
  }

  private async findEmbedUrl(query: StreamQuery): Promise<string | null> {
    // Try MongoDB first
    console.log(`${TAG} findEmbedUrl: recherche MongoDB...`);
    const mongoUrl = await this.findFromMongoDB(query);
    if (mongoUrl) {
      console.log(`${TAG} findEmbedUrl: trouvé dans MongoDB → ${mongoUrl.slice(0, 100)}`);
      return mongoUrl;
    }
    console.log(`${TAG} findEmbedUrl: pas dans MongoDB, fallback disque...`);

    // Fallback to disk JSON
    const diskUrl = this.findFromDisk(query);
    if (diskUrl) {
      console.log(`${TAG} findEmbedUrl: trouvé sur disque → ${diskUrl.slice(0, 100)}`);
    } else {
      console.log(`${TAG} findEmbedUrl: pas trouvé (MongoDB + disque)`);
    }
    return diskUrl;
  }

  private toEmbedUrl(lien: string): string {
    const m = lien.match(/(?:doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\/([a-zA-Z0-9]+)/i);
    if (m) return `https://doodstream.com/e/${m[1]}`;
    const uqload = lien.match(/uqload\.(?:is|com)\/(?:embed-?([a-zA-Z0-9]+)|([a-zA-Z0-9]+))/i);
    if (uqload) return `https://uqload.is/embed-${uqload[1] || uqload[2]}.html`;
    const st = lien.match(/streamtape\.com\/(?:e|v|f)\/([a-zA-Z0-9]+)/i);
    if (st) return `https://streamtape.com/e/${st[1]}`;
    return lien;
  }

  private isDoodOrUqload(url: string | undefined | null): boolean {
    if (!url || url === '#') return false;
    return /doodstream\.com|dood\.(to|sh|so|cx|la|wf|pm)|playmogo\.com|d000d\.com|d0000d\.com|uqload\.(is|com)/i.test(url);
  }

  private async findUqloadCode(query: StreamQuery): Promise<string | null> {
    try {
      if (query.season !== undefined && query.episode !== undefined) {
        const serie = await Serie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();
        if (!serie) return null;
        const ep = serie.episodes.find(
          (e: any) => Number(e.season) === Number(query.season) && Number(e.episodeNumber) === Number(query.episode)
        );
        if (ep?.uqloadCode && ep.uqloadLink) return ep.uqloadCode;
        return null;
      } else {
        const movie = await Movie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();
        if (!movie) return null;
        if (movie.uqloadCode && movie.uqloadLink) return movie.uqloadCode;
        return null;
      }
    } catch (err) {
      console.error(`${TAG} findUqloadCode error:`, err);
    }
    return null;
  }

  private async findFromMongoDB(query: StreamQuery): Promise<string | null> {
    try {
      if (query.season !== undefined && query.episode !== undefined) {
        const serie = await Serie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();

        if (!serie) {
          console.log(`${TAG} MongoDB: série introuvable pour tmdbId=${query.tmdbId}`);
          return null;
        }

        const ep = serie.episodes.find(
          (e: any) => Number(e.season) === Number(query.season) && Number(e.episodeNumber) === Number(query.episode)
        );
        if (!ep) {
          console.log(`${TAG} MongoDB: épisode S${query.season}E${query.episode} introuvable dans "${serie.titre}" (${serie.episodes.length} épisodes)`);
          return null;
        }

        const lien = ep.lien;
        if (!lien || lien === '#') {
          console.log(`${TAG} MongoDB: lien vide/mort pour S${query.season}E${query.episode}`);
          return null;
        }
        if (isSignedLinkExpired(lien)) {
          console.log(`${TAG} MongoDB: lien expiré pour S${query.season}E${query.episode}: ${lien.slice(0, 80)}`);
          return null;
        }
        if (!this.isDoodOrUqload(lien)) {
          console.log(`${TAG} MongoDB: lien non-Doodstream/Uqload pour S${query.season}E${query.episode}: ${lien.slice(0, 80)}`);
          return null;
        }

        return this.toEmbedUrl(lien);
      } else {
        const movie = await Movie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();

        if (!movie) {
          console.log(`${TAG} MongoDB: film introuvable pour tmdbId=${query.tmdbId}`);
          return null;
        }

        const lien = movie.lien;
        if (!lien || lien === '#') {
          console.log(`${TAG} MongoDB: lien vide/mort pour "${movie.titre}"`);
          return null;
        }
        if (isSignedLinkExpired(lien)) {
          console.log(`${TAG} MongoDB: lien expiré pour "${movie.titre}": ${lien.slice(0, 80)}`);
          return null;
        }
        if (!this.isDoodOrUqload(lien)) {
          console.log(`${TAG} MongoDB: lien non-Doodstream/Uqload pour "${movie.titre}": ${lien.slice(0, 80)}`);
          return null;
        }

        return this.toEmbedUrl(lien);
      }
    } catch (err) {
      console.error(`${TAG} MongoDB lookup error:`, err);
    }
    return null;
  }

  private findFromDisk(query: StreamQuery): string | null {
    const all: Record<string, any> = {};
    if (fs.existsSync(UPLOADED_PATH)) {
      try { Object.assign(all, JSON.parse(fs.readFileSync(UPLOADED_PATH, 'utf-8'))); } catch { /* ignore */ }
    }
    if (fs.existsSync(SERIES_OUTPUT_PATH)) {
      try { Object.assign(all, JSON.parse(fs.readFileSync(SERIES_OUTPUT_PATH, 'utf-8'))); } catch { /* ignore */ }
    }

    const normalize = (s: string) => s.toLowerCase().replace(/[-–—:]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

    for (const key of Object.keys(all)) {
      const file = all[key];
      const matchId = query.tmdbId && file.tmdbId && Number(file.tmdbId) === query.tmdbId;
      const matchTitle = query.title && normalize(file.titre || '').includes(normalize(query.title));

      if (matchId || matchTitle) {
        if (query.season !== undefined && query.episode !== undefined) {
          if (file.season === query.season && file.episode === query.episode) {
            if (file.lien && file.lien !== '#' && this.isDoodOrUqload(file.lien)) {
              return this.toEmbedUrl(file.lien);
            }
          }
        } else {
          if (file.lien && file.lien !== '#' && this.isDoodOrUqload(file.lien)) {
            return this.toEmbedUrl(file.lien);
          }
        }
      }
    }
    return null;
  }

  private async updateMongoDbFreshUrl(query: StreamQuery, freshUrl: string): Promise<void> {
    try {
      if (query.season !== undefined && query.episode !== undefined) {
        const serie = await Serie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();
        if (!serie) return;
        const ep = serie.episodes.find(
          (e: any) => Number(e.season) === Number(query.season) && Number(e.episodeNumber) === Number(query.episode)
        );
        if (ep?.uqloadCode) {
          await Serie.updateOne(
            { _id: serie._id, 'episodes.uqloadCode': ep.uqloadCode },
            { $set: { 'episodes.$.uqloadLink': freshUrl } }
          );
          console.log(`${TAG} MongoDB updated uqloadLink for episode "${query.title}" S${query.season}E${query.episode}`);
        }
      } else {
        const movie = await Movie.findOne({
          $or: [
            ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
            ...(query.title ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }] : []),
          ],
        }).exec();
        if (movie?.uqloadCode) {
          await Movie.updateOne(
            { _id: movie._id },
            { $set: { uqloadLink: freshUrl } }
          );
          console.log(`${TAG} MongoDB updated uqloadLink for "${query.title}"`);
        }
      }
    } catch (err: any) {
      console.error(`${TAG} MongoDB update error:`, err.message);
    }
  }
}
