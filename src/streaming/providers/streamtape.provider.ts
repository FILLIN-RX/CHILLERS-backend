import { StreamingProvider, StreamResult, StreamQuery } from './provider.interface';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

export class StreamtapeProvider implements StreamingProvider {
  readonly name = 'streamtape';

  supports(query: StreamQuery): boolean {
    return !!query.title || !!query.tmdbId;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    const embedUrl = await this.findMovieStream(query);
    if (!embedUrl) return null;
    return { provider: this.name, embedUrl, type: 'movie' };
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const embedUrl = await this.findEpisodeStream(query);
    if (!embedUrl) return null;
    return { provider: this.name, embedUrl, type: 'episode' };
  }

  private embedUrl(code: string): string {
    return `https://streamtape.com/e/${code}`;
  }

  private isStreamtapeUrl(url: string): string | null {
    const m = url.match(/streamtape\.com\/(?:e|v)\/([a-zA-Z0-9_\-]+)/i);
    if (m) return this.embedUrl(m[1]);
    return null;
  }

  private async findMovieStream(query: StreamQuery): Promise<string | null> {
    try {
      const movie = await Movie.findOne({
        $or: [
          ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
          ...(query.title
            ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }]
            : []),
        ],
      }).exec();

      if (!movie) return null;

      if (movie.streamtapeLink || movie.streamtapeCode) {
        const code = movie.streamtapeCode || (movie.streamtapeLink?.match(/streamtape\.com\/(?:e|v)\/([a-zA-Z0-9_\-]+)/i)?.[1]);
        if (code) return this.embedUrl(code);
      }

      if (movie.lien) {
        const fromLien = this.isStreamtapeUrl(movie.lien);
        if (fromLien) return fromLien;
      }
    } catch (err) {
      console.error('[Streamtape] Movie query error:', err);
    }
    return null;
  }

  private async findEpisodeStream(query: StreamQuery): Promise<string | null> {
    if (query.season === undefined || query.episode === undefined) return null;

    try {
      const series = await Serie.findOne({
        $or: [
          ...(query.tmdbId ? [{ tmdbId: query.tmdbId }] : []),
          ...(query.title
            ? [{ titre: { $regex: new RegExp(query.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }]
            : []),
        ],
      }).exec();

      if (!series) return null;

      const ep = series.episodes.find(
        (e: any) => Number(e.season) === Number(query.season) && Number(e.episodeNumber) === Number(query.episode),
      );
      if (!ep) return null;

      if (ep.streamtapeLink || ep.streamtapeCode) {
        const code = ep.streamtapeCode || (ep.streamtapeLink?.match(/streamtape\.com\/(?:e|v)\/([a-zA-Z0-9_\-]+)/i)?.[1]);
        if (code) return this.embedUrl(code);
      }

      if (ep.lien) {
        const fromLien = this.isStreamtapeUrl(ep.lien);
        if (fromLien) return fromLien;
      }
    } catch (err) {
      console.error('[Streamtape] Serie query error:', err);
    }
    return null;
  }
}
