import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';

const BASE_URL = 'https://vidlink.pro';

export class VidLinkProvider implements StreamingProvider {
  readonly name = 'vidlink';

  private buildParams(query: StreamQuery): URLSearchParams {
    return new URLSearchParams({
      primaryColor: 'D70466',
      autoplay: 'false',
      icons: 'vid',
      language: query.language || 'fr',
    });
  }

  supports(query: StreamQuery): boolean {
    return query.type !== 'anime';
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    const params = this.buildParams(query);
    const embedUrl = `${BASE_URL}/movie/${query.tmdbId}?${params.toString()}`;
    return { provider: this.name, embedUrl, type: 'movie' };
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const params = this.buildParams({ ...query, ...{ nextbutton: 'true' } });
    params.set('nextbutton', 'true');
    const embedUrl = `${BASE_URL}/tv/${query.tmdbId}/${query.season || 1}/${query.episode || 1}?${params.toString()}`;
    return { provider: this.name, embedUrl, type: 'episode' };
  }
}
