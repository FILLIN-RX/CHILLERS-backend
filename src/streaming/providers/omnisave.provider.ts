import { StreamingProvider, StreamQuery, StreamResult } from './provider.interface';
import { searchOmniSave, getOmniSaveDownloads } from '../../modules/omnisave/omnisave.service';
import tmdbClient from '../../config/tmdb';

export class OmniSaveProvider implements StreamingProvider {
  readonly name = 'omnisave';

  supports(query: StreamQuery): boolean {
    return !!(query.title || query.tmdbId);
  }

  private async resolveTitle(query: StreamQuery): Promise<string | null> {
    if (query.title) return query.title;
    if (query.tmdbId) {
      try {
        const endpoint = query.type === 'tv' || query.type === 'anime' ? `/tv/${query.tmdbId}` : `/movie/${query.tmdbId}`;
        const { data } = await tmdbClient.get(`${endpoint}?language=${query.language || 'fr'}`);
        return data?.title || data?.name || data?.original_title || data?.original_name || null;
      } catch (_) {}
    }
    return null;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    const title = await this.resolveTitle(query);
    if (!title) return null;

    try {
      console.log(`[OmniSave Provider] Recherche film: "${title}"`);
      const searchRes = await searchOmniSave(title, 1, 5);
      if (!searchRes.items || searchRes.items.length === 0) return null;

      const item = searchRes.items[0];
      const dlRes = await getOmniSaveDownloads(item.subjectId, item.detailPath, 1, 1);

      const available = dlRes.downloads
        .filter(d => !d.vipLocked && d.url)
        .sort((a, b) => b.resolution - a.resolution);

      if (available.length > 0) {
        const best = available[0];
        console.log(`[OmniSave Provider] Flux trouvé (${best.resolution}p): ${best.url.slice(0, 60)}...`);
        return {
          provider: this.name,
          embedUrl: `/api/omnisave/proxy?url=${encodeURIComponent(best.url)}`,
          type: 'movie'
        };
      }
    } catch (error: any) {
      console.error(`[OmniSave Provider] Erreur film "${title}":`, error.message);
    }
    return null;
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const title = await this.resolveTitle(query);
    if (!title) return null;

    try {
      const season = query.season || 1;
      const episode = query.episode || 1;
      console.log(`[OmniSave Provider] Recherche série/anime: "${title}" S${season}E${episode}`);

      const searchRes = await searchOmniSave(title, 1, 5);
      if (!searchRes.items || searchRes.items.length === 0) return null;

      const item = searchRes.items[0];
      const dlRes = await getOmniSaveDownloads(item.subjectId, item.detailPath, season, episode);

      const available = dlRes.downloads
        .filter(d => !d.vipLocked && d.url)
        .sort((a, b) => b.resolution - a.resolution);

      if (available.length > 0) {
        const best = available[0];
        console.log(`[OmniSave Provider] Épisode trouvé (${best.resolution}p): ${best.url.slice(0, 60)}...`);
        return {
          provider: this.name,
          embedUrl: `/api/omnisave/proxy?url=${encodeURIComponent(best.url)}`,
          type: 'episode'
        };
      }
    } catch (error: any) {
      console.error(`[OmniSave Provider] Erreur épisode "${title}":`, error.message);
    }
    return null;
  }
}
