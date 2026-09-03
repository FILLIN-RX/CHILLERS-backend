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
  const params = {
    with_genres: '16',
    sort_by: 'popularity.desc',
    page,
    with_original_language: 'ja',
    language: toTMDBLanguage(language),
  };

  const [tvRes, movieRes] = await Promise.all([
    tmdbClient.get('/discover/tv', { params }),
    tmdbClient.get('/discover/movie', { params }),
  ]);

  const combinedResults = [...tvRes.data.results, ...movieRes.data.results]
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

  return {
    page: tvRes.data.page,
    results: combinedResults,
    total_pages: Math.max(tvRes.data.total_pages, movieRes.data.total_pages),
    total_results: tvRes.data.total_results + movieRes.data.total_results,
  };
};

export const getAfrican = async (page: number = 1, language?: string, country?: string) => {
  const originCountry = country || 'NG|GH|CM|CI|SN';
  const { data } = await tmdbClient.get('/discover/tv', {
    params: { 
      with_origin_country: originCountry, 
      sort_by: 'popularity.desc', 
      page, 
      language: toTMDBLanguage(language) 
    },
  });
  return data;
};

export const getDetails = async (id: string, language?: string) => {
  try {
    const { data } = await tmdbClient.get(`/tv/${id}`, {
      params: { 
        append_to_response: 'credits,videos,content_ratings,external_ids,recommendations,similar,aggregate_credits,keywords', 
        language: toTMDBLanguage(language) 
      },
    });
    return data;
  } catch (err: any) {
    if (err?.response?.status === 404) {
      try {
        const { data } = await tmdbClient.get(`/movie/${id}`, {
          params: { 
            append_to_response: 'credits,videos,release_dates,recommendations,similar', 
            language: toTMDBLanguage(language) 
          },
        });
        return data;
      } catch (_) {}
    }
    throw err;
  }
};

export const getSeasonDetails = async (id: string, seasonNumber: string, language?: string) => {
  const { data } = await tmdbClient.get(`/tv/${id}/season/${seasonNumber}`, {
    params: { 
      append_to_response: 'credits,videos,images',
      language: toTMDBLanguage(language) 
    },
  });
  return data;
};
