import tmdbClient from '../../config/tmdb';
import { toTMDBLanguage } from '../../config/language';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

// Petit limiteur de concurrence maison (équivalent p-limit avec une cap à 4).
// p-limit n'est pas une dépendance du backend — on évite un nouveau package.
const queue: Array<() => void> = [];
let active = 0;
const MAX = 4;

function limit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (active < MAX) run();
    else queue.push(run);
  });
}

async function fetchDetails(media_type: 'movie' | 'tv', id: number, language?: string) {
  return limit(() =>
    tmdbClient
      .get(`/${media_type}/${id}`, {
        params: {
          append_to_response: 'images,credits,videos',
          include_image_language: 'en,fr,null',
          language: toTMDBLanguage(language),
        },
      })
      .then(r => r.data)
      .catch(() => null)
  );
}

/**
 * Recherche multi-source :
 *  1. MongoDB local (films + séries, regex insensible à la casse, max 5 chacun)
 *  2. TMDB /search/movie + /search/tv en parallèle (sépare les personnes)
 *  3. Hydratation des top-8 de chaque côté avec append_to_response=images,credits,videos
 *     (c'est ce qui donne les posters/casts/trailers réels — /search/multi les strip)
 *
 * Retourne une forme stable consommable par le frontend :
 *   { localResults: { movies, series }, tmdbResults: { results: [...] } }
 * Chaque résultat TMDB est taggé media_type ∈ 'movie' | 'tv' (plus de 'person').
 */
export const searchMulti = async (query: string, page: number = 1, language?: string) => {
  const regex = new RegExp(query, 'i');

  const [localMovies, localSeries, moviesResp, tvResp] = await Promise.all([
    Movie.find({ titre: regex }).limit(5).lean().catch(() => []),
    Serie.find({ titre: regex }).limit(5).lean().catch(() => []),
    tmdbClient
      .get('/search/movie', { params: { query, page, language: toTMDBLanguage(language) } })
      .then(r => r.data)
      .catch(() => ({ results: [] })),
    tmdbClient
      .get('/search/tv', { params: { query, page, language: toTMDBLanguage(language) } })
      .then(r => r.data)
      .catch(() => ({ results: [] })),
  ]);

  const movieTop = ((moviesResp.results || []) as any[]).slice(0, 8);
  const tvTop = ((tvResp.results || []) as any[]).slice(0, 8);

  const [movieDetails, tvDetails] = await Promise.all([
    Promise.all(movieTop.map(m => fetchDetails('movie', m.id, language))),
    Promise.all(tvTop.map(t => fetchDetails('tv', t.id, language))),
  ]);

  // Merge : le résultat de base (list) fournit les champs de ranking,
  // le détail hydraté fournit poster/overview/cast/trailer.
  const tmdbResults = {
    results: [
      ...movieTop.map((m, i) => ({
        ...(movieDetails[i] || {}),
        ...m,
        media_type: 'movie' as const,
      })),
      ...tvTop.map((t, i) => ({
        ...(tvDetails[i] || {}),
        ...t,
        media_type: 'tv' as const,
      })),
    ],
  };

  return {
    localResults: { movies: localMovies, series: localSeries },
    tmdbResults,
  };
};