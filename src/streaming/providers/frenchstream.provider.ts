import { StreamingProvider, StreamQuery, StreamResult } from './provider.interface';
import { getFrenchStreamMovie } from '../../modules/frenchstream/frenchstream.service';
import tmdbClient from '../../config/tmdb';

export class FrenchStreamProvider implements StreamingProvider {
  readonly name = 'frenchstream';

  supports(query: StreamQuery): boolean {
    return !!(query.title || query.tmdbId);
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    let movieTitle = query.title;

    // Si le titre n'a pas été envoyé, le récupérer via l'API TMDB
    if (!movieTitle && query.tmdbId) {
      try {
        const { data } = await tmdbClient.get(`/movie/${query.tmdbId}?language=${query.language || 'fr'}`);
        movieTitle = data?.title || data?.original_title;
      } catch (_) {}
    }

    if (!movieTitle) return null;

    console.log(`[FrenchStream Provider] Recherche flux 1080p pour: "${movieTitle}" (isPremium=${!!query.isPremium})`);
    const result = await getFrenchStreamMovie(movieTitle);

    if (result?.streamUrl) {
      console.log(`[FrenchStream Provider] Flux 1080p trouvé: ${result.streamUrl.slice(0, 80)}... (${result.fileSize})`);
      return {
        provider: this.name,
        embedUrl: result.streamUrl,
        type: 'movie',
      };
    }

    return null;
  }

  async getEpisodeStream(_query: StreamQuery): Promise<StreamResult | null> {
    return null;
  }
}
