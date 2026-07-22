import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';

const BASE_URL = 'https://vidapi.xyz/embed';

export class VidAPIProvider implements StreamingProvider {
  readonly name = 'vidapi';

  supports(_query: StreamQuery): boolean {
    return true;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    const embedUrl = `${BASE_URL}/movie/${query.tmdbId}?language=${query.language || 'fr'}`;
    return { provider: this.name, embedUrl, type: 'movie' };
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const embedUrl = `${BASE_URL}/tv/${query.tmdbId}/${query.season || 1}/${query.episode || 1}?language=${query.language || 'fr'}`;
    return { provider: this.name, embedUrl, type: 'episode' };
  }
}
