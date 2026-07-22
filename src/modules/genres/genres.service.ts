import tmdbClient from '../../config/tmdb';
import { toTMDBLanguage } from '../../config/language';

export const getMovieGenres = async (language?: string) => {
  const { data } = await tmdbClient.get('/genre/movie/list', {
    params: { language: toTMDBLanguage(language) },
  });
  return data.genres;
};

export const getTvGenres = async (language?: string) => {
  const { data } = await tmdbClient.get('/genre/tv/list', {
    params: { language: toTMDBLanguage(language) },
  });
  return data.genres;
};
