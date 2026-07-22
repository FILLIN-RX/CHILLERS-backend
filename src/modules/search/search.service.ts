import tmdbClient from '../../config/tmdb';
import { toTMDBLanguage } from '../../config/language';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

export const searchMulti = async (query: string, page: number = 1, language?: string) => {
  // 1. Recherche dans MongoDB (Locale)
  const regex = new RegExp(query, 'i');
  const localMovies = await Movie.find({ titre: regex }).limit(5);
  const localSeries = await Serie.find({ titre: regex }).limit(5);

  // 2. Recherche sur TMDB (API)
  const { data } = await tmdbClient.get('/search/multi', {
    params: { query, page, language: toTMDBLanguage(language) },
  });

  // 3. Fusion des résultats (simplifiée)
  return {
    localResults: {
      movies: localMovies,
      series: localSeries
    },
    tmdbResults: data
  };
};
