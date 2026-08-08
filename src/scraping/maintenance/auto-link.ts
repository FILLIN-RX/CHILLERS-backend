/**
 * Auto-link TMDB à chaque nouvel upload.
 *
 * - Fire-and-forget via setImmediate : ne bloque jamais le caller.
 * - Converge toujours : un échec est non-fatal, le batch cron rattrape au prochain passage.
 * - Conçu pour être appelé depuis n'importe quel site de save (scraper, on-demand, admin).
 */

import { linkMovieTmdb } from './link-movies-tmdb';
import { linkSeriesTmdb } from './link-series-tmdb';

export type LinkKind = 'movie' | 'series';

/**
 * Déclenche la liaison TMDB d'un document MongoDB en arrière-plan.
 * Aucun await, aucune exception propagée, aucun impact sur la réponse HTTP caller.
 */
export function autoLink(kind: LinkKind, id: string): void {
  if (!id) return;

  const fn = kind === 'movie' ? linkMovieTmdb : linkSeriesTmdb;

  // setImmediate décale l'exécution au prochain tour de boucle, après que le caller
  // (scraper, route admin, on-demand) ait fini son tour en cours.
  setImmediate(() => {
    fn(id).catch((err: Error) => {
      console.error(`[TMDB-AUTO] ${kind}/${id} crashed:`, err?.message || err);
    });
  });
}