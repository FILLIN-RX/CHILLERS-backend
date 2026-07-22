import { StreamingProvider, StreamQuery, StreamResult } from './provider.interface';
import { searchOtaku } from '../../modules/otaku/otaku.service';

export class OtakuProvider implements StreamingProvider {
  readonly name = 'otaku';

  supports(query: StreamQuery): boolean {
    return !!query.title;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    if (!query.title) return null;

    console.log(`[Otaku] Searching movie: "${query.title}"`);
    const result = await searchOtaku(query.title, 'movie');

    if (result?.lien) {
      console.log(`[Otaku] Found movie link: ${result.lien.slice(0, 80)}...`);
      return {
        provider: this.name,
        embedUrl: result.lien,
        type: 'movie',
      };
    }

    return null;
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    if (!query.title) return null;

    console.log(`[Otaku] Searching series: "${query.title}" S${query.season}E${query.episode}`);
    const result = await searchOtaku(query.title, 'series');

    if (result?.lien) {
      console.log(`[Otaku] Found series link: ${result.lien.slice(0, 80)}...`);
      return {
        provider: this.name,
        embedUrl: result.lien,
        type: 'episode',
      };
    }

    return null;
  }
}
