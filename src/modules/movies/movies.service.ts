import tmdbClient from '../../config/tmdb';
import { toTMDBLanguage } from '../../config/language';

export const getPopular = async (page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/movie/popular', { params: { page, language: toTMDBLanguage(language) } });
  return data;
};

export const getTrending = async (language?: string) => {
  const { data } = await tmdbClient.get('/trending/movie/week', { params: { language: toTMDBLanguage(language) } });
  return data;
};

export const getUpcoming = async (page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/movie/upcoming', { params: { page, language: toTMDBLanguage(language) } });
  return data;
};

export const getTopRated = async (page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/movie/top_rated', { params: { page, language: toTMDBLanguage(language) } });
  return data;
};

export const getDetails = async (id: string, language?: string) => {
  const { data } = await tmdbClient.get(`/movie/${id}`, {
    params: { append_to_response: 'credits,videos', language: toTMDBLanguage(language) },
  });
  return data;
};

export const getRecommendations = async (id: string, language?: string) => {
  const { data } = await tmdbClient.get(`/movie/${id}/recommendations`, { params: { language: toTMDBLanguage(language) } });
  return data;
};

export const getTrailer = async (id: string, language?: string) => {
  const { data } = await tmdbClient.get(`/movie/${id}/videos`, { params: { language: toTMDBLanguage(language) } });
  const results = data.results || [];
  const trailer = results.find(
    (v: any) => v.site === 'YouTube' && v.type === 'Trailer' && v.official === true
  );
  return trailer || results.find((v: any) => v.site === 'YouTube' && v.type === 'Trailer') || null;
};

export const getByGenre = async (genreId: string, page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/discover/movie', {
    params: { with_genres: genreId, sort_by: 'popularity.desc', page, language: toTMDBLanguage(language) },
  });
  return data;
};
