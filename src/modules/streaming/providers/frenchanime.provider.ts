import ProviderCatalogItem from '../../../models/ProviderCatalogItem';
import { fetchW16AnimePayload } from '../../catalog/w16-anime-source';
import { StreamingProvider, StreamQuery, StreamResult } from './provider.interface';

/** Résout les épisodes du catalogue French Anime (W16) lié au catalogue TMDB. */
export class FrenchAnimeProvider implements StreamingProvider {
  readonly name = 'frenchanime';

  supports(query: StreamQuery): boolean {
    return Boolean(query.tmdbId && (query.type === 'anime' || query.type === 'tv' || query.isAnime));
  }

  async getMovieStream(_query: StreamQuery): Promise<StreamResult | null> {
    return null;
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    const season = Number(query.season || 1);
    const episode = Number(query.episode || 1);
    let items = await ProviderCatalogItem.find({
      provider: 'otaku', // Le catalogue W16 existant partage l'index anime Otaku.
      type: 'anime',
      tmdbId: query.tmdbId,
      active: true,
    })
      .select('sourceId title season pageUrl language')
      .lean();

    if (!items.length && (query.title || query.frenchTitle || query.originalTitle)) {
      const searchTitle = (query.title || query.frenchTitle || query.originalTitle)!.replace(/\b(saison|season)\s*\d+/gi, '').trim();
      const escaped = searchTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      items = await ProviderCatalogItem.find({
        provider: 'otaku',
        type: 'anime',
        active: true,
        title: new RegExp(`^${escaped}\\b`, 'i'),
      })
        .select('sourceId title season pageUrl language')
        .lean();
    }

    const item = items.find((entry: any) => {
      const s = entry.season !== undefined ? Number(entry.season) : (entry.title?.match(/saison\s*(\d+)/i)?.[1] ? Number(entry.title.match(/saison\s*(\d+)/i)[1]) : 1);
      return s === season;
    });
    if (!item) {
      console.log(`[French Anime] Aucun catalogue lié à TMDB ${query.tmdbId} S${season}`);
      return null;
    }

    const payload = await fetchW16AnimePayload(item.sourceId);
    const sourceEpisode = payload?.episodes?.[String(episode)]
      || payload?.episodes?.[String(episode).padStart(2, '0')];
    if (!sourceEpisode?.links.length) {
      console.log(`[French Anime] Épisode S${season}E${episode} absent de « ${item.title} » (${item.sourceId})`);
      return null;
    }

    const wantedLanguage = (query.language || 'fr').toLowerCase();
    const preferred = wantedLanguage === 'vostfr'
      ? ['VOSTFR', 'VF']
      : ['VF', 'VOSTFR'];
    const link = preferred.flatMap((language) => sourceEpisode.links.filter((candidate) => candidate.language === language))[0];
    if (!link) return null;

    console.log(`[French Anime] Flux ${link.language} trouvé pour « ${item.title} » S${season}E${episode} (${link.host})`);
    return {
      provider: this.name,
      embedUrl: link.url,
      // Fournir l'embedUrl comme downloadUrl : la route /api/download/resolve
      // le passera à DirectScraper.resolve() pour extraire le MP4 direct.
      // Sans ce champ, le bouton Télécharger ne fonctionne jamais pour les animes W16.
      downloadUrl: link.url,
      type: 'episode',
      language: link.language,
      referer: `${new URL(item.pageUrl).origin}/`,
    };
  }
}
