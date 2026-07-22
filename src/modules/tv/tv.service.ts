import tmdbClient from '../../config/tmdb';
import { toTMDBLanguage } from '../../config/language';

export const getPopular = async (page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/tv/popular', { params: { page, language: toTMDBLanguage(language) } });
  return data;
};

export const getTrending = async (language?: string) => {
  const { data } = await tmdbClient.get('/trending/tv/week', { params: { language: toTMDBLanguage(language) } });
  return data;
};

export const getTopRated = async (page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/tv/top_rated', { params: { page, language: toTMDBLanguage(language) } });
  return data;
};

export const getByGenre = async (genreId: string, page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/discover/tv', {
    params: { with_genres: genreId, sort_by: 'popularity.desc', page, language: toTMDBLanguage(language) },
  });
  return data;
};

export const getAnime = async (page: number = 1, language?: string) => {
  const { data } = await tmdbClient.get('/discover/tv', {
    params: {
      with_genres: '16',
      sort_by: 'popularity.desc',
      page,
      with_original_language: 'ja',
      language: toTMDBLanguage(language),
    },
  });
  return data;
};

export const getDetails = async (id: string, language?: string) => {
  const { data } = await tmdbClient.get(`/tv/${id}`, {
    params: { append_to_response: 'credits,videos', language: toTMDBLanguage(language) },
  });
  return data;
};

export const getSeasonDetails = async (id: string, seasonNumber: string, language?: string) => {
  const { data } = await tmdbClient.get(`/tv/${id}/season/${seasonNumber}`, {
    params: { language: toTMDBLanguage(language) },
  });
  return data;
};
