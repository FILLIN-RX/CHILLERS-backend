import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';

// AnimeKai supports anime by TMDB ID or by title slug
// Priority: use TMDB ID embed (more reliable), fallback to title slug
const BASE_URL = 'https://animekai.to';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export class AnimeKaiProvider implements StreamingProvider {
  readonly name = 'animekai';

  supports(query: StreamQuery): boolean {
    return query.type === 'anime';
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    // Try TMDB-ID based embed first (most reliable)
    const embedUrl = query.title
      ? `${BASE_URL}/embed/${slugify(query.title)}`
      : `${BASE_URL}/embed/tmdb-${query.tmdbId}`;
    return { provider: this.name, embedUrl, type: 'movie' };
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const ep = query.episode || 1;
    const embedUrl = query.title
      ? `${BASE_URL}/embed/${slugify(query.title)}?ep=${ep}`
      : `${BASE_URL}/embed/tmdb-${query.tmdbId}?ep=${ep}`;
    return { provider: this.name, embedUrl, type: 'episode' };
  }
}
