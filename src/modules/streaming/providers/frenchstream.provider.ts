import { StreamingProvider, StreamQuery, StreamResult } from './provider.interface';
import { getFrenchStreamMovie, getFrenchStreamEpisode } from '../../frenchstream/frenchstream.service';
import { DirectScraper, extractUqloadCode } from './direct-scraper';
import tmdbClient from '../../../config/tmdb';
import Movie from '../../../models/Movie';
import Serie from '../../../models/Serie';

function getRefererForStreamUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Pour les CDN Vidzy (u14.vidzy.cc, etc.), le referer correct est la page embed
    // d'où vient le lien (fr14.vidzy.cc/embed-xxx.html), pas le domaine principal.
    // Ce referer est passé séparément via directScraper.referer — ici on retourne
    // un fallback générique qui force le proxy côté lecteur.
    if (parsed.hostname.includes('vidzy')) return 'https://vidzy.cc/';
    if (parsed.hostname.includes('uqload')) return 'https://uqload.is/';
    if (parsed.hostname.includes('dood') || parsed.hostname.includes('playmogo') || parsed.hostname.includes('d000')) return 'https://doodstream.com/';
    if (parsed.hostname.includes('streamtape')) return 'https://streamtape.com/';
    if (parsed.hostname.includes('voe')) return 'https://voe.sx/';
    if (parsed.hostname.includes('luluv')) return 'https://luluvdo.com/';
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return 'https://french-stream.net/';
  }
}

export class FrenchStreamProvider implements StreamingProvider {
  readonly name = 'frenchstream';

  supports(query: StreamQuery): boolean {
    return !!(query.title || query.tmdbId);
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    let movieTitle = query.title;
    let originalTitle = query.originalTitle;
    let year = query.year;
    let directors: string[] | undefined;
    let mainActors: string[] | undefined;

    let frenchTitle = query.frenchTitle;

    // Si tmdbId est fourni, récupérer les détails TMDB (titre, année, réalisateurs, acteurs)
    if (query.tmdbId) {
      try {
        const { data } = await tmdbClient.get(`/movie/${query.tmdbId}?language=${query.language || 'fr'}&append_to_response=credits`);
        if (!frenchTitle && data?.title) frenchTitle = data.title;
        if (!originalTitle && data?.original_title) originalTitle = data.original_title;
        if (!movieTitle) movieTitle = frenchTitle || originalTitle;
        if (!year && data?.release_date) {
          const y = new Date(data.release_date).getFullYear();
          if (!isNaN(y)) year = y;
        }
        if (data?.credits?.crew) {
          directors = data.credits.crew.filter((c: any) => c.job === 'Director').map((c: any) => c.name);
        }
        if (data?.credits?.cast) {
          mainActors = data.credits.cast.slice(0, 5).map((a: any) => a.name);
        }
      } catch (_) {}
    }

    if (!movieTitle && !frenchTitle && !originalTitle) return null;

    // Recherche d'une page source connue mémorisée dans MongoDB
    let knownPagePath: string | undefined;
    let existingMovie: any = null;
    try {
      const searchTerms = [movieTitle, frenchTitle, originalTitle].filter(Boolean) as string[];
      existingMovie = await Movie.findOne(
        query.tmdbId
          ? { tmdbId: query.tmdbId }
          : { $or: searchTerms.map(t => ({ titre: new RegExp(`^${t.trim()}$`, 'i') })) }
      ).select('_id providerPages');
      
      const matchedPage = existingMovie?.providerPages?.find(
        (p: any) => p.provider === this.name && (!p.language || p.language === (query.language || 'fr')) && p.isWorking !== false
      );
      if (matchedPage?.path) {
        knownPagePath = matchedPage.path;
      }
    } catch (_) {}

    console.log(`[FrenchStream Provider] Recherche film 1080p pour: "${frenchTitle || movieTitle}" (VO="${originalTitle || 'N/A'}", year=${year || 'non spécifiée'}, lang=${query.language || 'fr'}, directPage=${knownPagePath || 'aucune'})`);
    const result = await getFrenchStreamMovie(
      movieTitle || frenchTitle || originalTitle!,
      (query.language as any) || 'fr',
      year,
      knownPagePath,
      originalTitle,
      directors,
      mainActors,
      frenchTitle
    );

    if (result?.streamUrl) {
      console.log(`[FrenchStream Provider] Flux 1080p trouvé: ${result.streamUrl.slice(0, 80)}... (${result.fileSize})`);
      
      // Mémoriser la page source dans MongoDB pour les futures requêtes
      // et mettre à jour le lien principal du film si un nouvel embed a été trouvé
      if (result.pagePath && (existingMovie || query.tmdbId)) {
        const lang = query.language || 'fr';
        const filter = existingMovie?._id ? { _id: existingMovie._id } : { tmdbId: query.tmdbId };
        const uqCode = extractUqloadCode(result.streamUrl);
        const updatePayload: any = {
          $push: {
            providerPages: {
              provider: this.name,
              path: result.pagePath,
              language: lang,
              lastScrapedAt: new Date(),
              isWorking: true,
            },
          },
        };
        if (uqCode) {
          updatePayload.$set = {
            uqloadCode: uqCode,
            uqloadLink: `https://uqload.vc/embed-${uqCode}.html`,
            lien: `https://uqload.vc/embed-${uqCode}.html`,
          };
          console.log(`[FrenchStream Provider] 🔄 MongoDB mis à jour pour le film avec uqCode=${uqCode}`);
        }
        Movie.updateOne(
          filter,
          {
            $pull: { providerPages: { provider: this.name, language: lang } },
          }
        ).then(() => {
          return Movie.updateOne(filter, updatePayload);
        }).catch((err) => {
          console.warn(`[FrenchStream Provider] Erreur sauvegarde film MongoDB:`, err.message);
        });
      }

      let directStreamUrl = result.streamUrl;
      let directType: 'mp4' | 'hls' = /\.(m3u8)/i.test(result.streamUrl) ? 'hls' : 'mp4';
      let directReferer: string | undefined;

      if (!/\.(mp4|webm|mkv|m3u8)(\?|$)/i.test(result.streamUrl)) {
        try {
          const directRes = await DirectScraper.resolve(result.streamUrl);
          if (directRes?.directUrl) {
            directStreamUrl = directRes.directUrl;
            directType = directRes.type === 'hls' ? 'hls' : 'mp4';
            // Utiliser le referer du scraper (URL embed) si disponible — c'est
            // ce que le CDN Vidzy/Uqload vérifie pour autoriser la lecture.
            directReferer = directRes.referer;
          }
        } catch (_) {}
      }

      const isDirectStream = /\.(mp4|webm|mkv|m3u8)(\?|$)/i.test(directStreamUrl) || /u\d+\.vidzy\.cc/i.test(directStreamUrl);
      // Priorité : referer du scraper (URL embed) > referer générique par domaine
      const referer = directReferer || getRefererForStreamUrl(directStreamUrl);

      let downloadUrl: string | undefined = undefined;
      if (isDirectStream) {
        if (directType === 'mp4') {
          downloadUrl = directStreamUrl;
        } else if (directType === 'hls') {
          downloadUrl = `/api/download/stream?m3u8=${encodeURIComponent(directStreamUrl)}`;
        }
      }

      return {
        provider: this.name,
        // L'URL directe est renvoyée brute : le lecteur proxy le HLS via
        // /api/live/proxy (le backend ne sert pas de proxy /api/doodstream/stream).
        embedUrl: directStreamUrl,
        directUrl: directStreamUrl,
        downloadUrl,
        directType: isDirectStream ? directType : undefined,
        referer: isDirectStream ? referer : undefined,
        type: 'movie',
      };
    }

    return null;
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    let seriesTitle = query.title;
    let originalTitle = query.originalTitle;
    let frenchTitle = query.frenchTitle;

    // Si le titre n'a pas été envoyé, le récupérer via l'API TMDB
    if (query.tmdbId) {
      try {
        const { data } = await tmdbClient.get(`/tv/${query.tmdbId}?language=${query.language || 'fr'}`);
        if (!frenchTitle && data?.name) frenchTitle = data.name;
        if (!originalTitle && data?.original_name) originalTitle = data.original_name;
        if (!seriesTitle) seriesTitle = frenchTitle || originalTitle;
      } catch (_) {}
    }

    if (!seriesTitle && !frenchTitle && !originalTitle) return null;

    const season = query.season || 1;
    const episode = query.episode || 1;

    // Recherche d'une page source connue pour cette série / saison
    let knownPagePath: string | undefined;
    let existingSerie: any = null;
    try {
      const searchTerms = [seriesTitle, frenchTitle, originalTitle].filter(Boolean) as string[];
      existingSerie = await Serie.findOne(
        query.tmdbId
          ? { tmdbId: query.tmdbId }
          : { $or: searchTerms.map(t => ({ titre: new RegExp(`^${t.trim()}$`, 'i') })) }
      ).select('_id providerPages episodes');

      const matchedPage = existingSerie?.providerPages?.find(
        (p: any) => p.provider === this.name && (!p.season || p.season === season) && (!p.language || p.language === (query.language || 'fr')) && p.isWorking !== false
      );
      if (matchedPage?.path) {
        knownPagePath = matchedPage.path;
      }
    } catch (_) {}

    console.log(`[FrenchStream Provider] Recherche série 1080p pour: "${frenchTitle || seriesTitle}" S${season}E${episode} (lang=${query.language || 'fr'}, directPage=${knownPagePath || 'aucune'})`);
    const result = await getFrenchStreamEpisode(
      seriesTitle || frenchTitle || originalTitle!,
      season,
      episode,
      (query.language as any) || 'fr',
      knownPagePath,
      originalTitle,
      frenchTitle
    );

    if (result?.streamUrl) {
      console.log(`[FrenchStream Provider] Flux série 1080p trouvé: ${result.streamUrl.slice(0, 80)}... (${result.fileSize})`);
      
      // Mémoriser la page source dans MongoDB
      if (result.pagePath && (existingSerie || query.tmdbId)) {
        const lang = query.language || 'fr';
        const filter = existingSerie?._id ? { _id: existingSerie._id } : { tmdbId: query.tmdbId };
        Serie.updateOne(
          filter,
          {
            $pull: { providerPages: { provider: this.name, season, language: lang } },
          }
        ).then(() => {
          return Serie.updateOne(
            filter,
            {
              $push: {
                providerPages: {
                  provider: this.name,
                  path: result.pagePath,
                  season,
                  language: lang,
                  lastScrapedAt: new Date(),
                  isWorking: true,
                },
              },
            }
          );
        }).catch((err) => {
          console.warn(`[FrenchStream Provider] Erreur sauvegarde providerPages série:`, err.message);
        });
      }

      let directStreamUrl = result.streamUrl;
      let directType: 'mp4' | 'hls' = /\.(m3u8)/i.test(result.streamUrl) ? 'hls' : 'mp4';
      let directReferer: string | undefined;

      if (!/\.(mp4|webm|mkv|m3u8)(\?|$)/i.test(result.streamUrl)) {
        try {
          const directRes = await DirectScraper.resolve(result.streamUrl);
          if (directRes?.directUrl) {
            directStreamUrl = directRes.directUrl;
            directType = directRes.type === 'hls' ? 'hls' : 'mp4';
            // Utiliser le referer du scraper (URL embed) si disponible — c'est
            // ce que le CDN Vidzy/Uqload vérifie pour autoriser la lecture.
            directReferer = directRes.referer;
          }
        } catch (_) {}
      }

      const isDirectStream = /\.(mp4|webm|mkv|m3u8)(\?|$)/i.test(directStreamUrl) || /u\d+\.vidzy\.cc/i.test(directStreamUrl);
      // Priorité : referer du scraper (URL embed) > referer générique par domaine
      const referer = directReferer || getRefererForStreamUrl(directStreamUrl);

      let downloadUrl: string | undefined = undefined;
      if (isDirectStream) {
        if (directType === 'mp4') {
          downloadUrl = directStreamUrl;
        } else if (directType === 'hls') {
          downloadUrl = `/api/download/stream?m3u8=${encodeURIComponent(directStreamUrl)}`;
        }
      }

      return {
        provider: this.name,
        // L'URL directe est renvoyée brute : le lecteur proxy le HLS via
        // /api/live/proxy (le backend ne sert pas de proxy /api/doodstream/stream).
        embedUrl: directStreamUrl,
        directUrl: directStreamUrl,
        downloadUrl,
        directType: isDirectStream ? directType : undefined,
        referer: isDirectStream ? referer : undefined,
        type: 'episode',
      };
    }

    return null;
  }
}
