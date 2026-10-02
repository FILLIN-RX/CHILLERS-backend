/**
 * tmdb-helper.ts — résout l'année d'un film/série depuis le tmdbId.
 *
 * Utilise le client TMDB déjà configuré (cache 5 min inclus).
 * L'année affiné la recherche Prowlarr ("Titre (2023)").
 * Échec non bloquant : retourne undefined.
 */

import tmdbClient from '../../../config/tmdb';
import { StreamQuery } from '../providers/provider.interface';
import { errMessage } from './torrents.utils';

export async function resolveTmdbYear(query: StreamQuery): Promise<number | undefined> {
  if (!query.tmdbId) return undefined;

  try {
    const type = query.type === 'tv' || query.type === 'anime' ? 'tv' : 'movie';
    const res = await tmdbClient.get(`/${type}/${query.tmdbId}`);
    const raw = res.data?.release_date || res.data?.first_air_date;
    const year = raw ? Number(String(raw).slice(0, 4)) : undefined;
    return Number.isFinite(year) && year! > 1900 ? year : undefined;
  } catch (err: unknown) {
    console.warn(`[Torrents] Année TMDB indisponible pour ${query.tmdbId}: ${errMessage(err)}`);
    return undefined;
  }
}
