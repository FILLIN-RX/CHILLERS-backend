/**
 * stream-cache.ts
 * Cache LRU en mémoire pour les résultats de résolution de stream.
 *
 * - 500 entrées max (films/épisodes les plus récemment demandés)
 * - TTL 10 minutes : suffisant pour une session de visionnage type
 * - Thread-safe (Node.js single-threaded event loop)
 *
 * En production multi-instance → remplacer par Redis (ioredis).
 */
import { LRUCache } from 'lru-cache';

export interface CachedStream {
  embedUrl: string;
  provider: string;
}

const STREAM_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export const streamCache = new LRUCache<string, CachedStream>({
  max: 500,
  ttl: STREAM_CACHE_TTL,
});

/** Génère une clé de cache déterministe selon le type de media. */
export function getCacheKey(
  type: 'movie' | 'episode',
  tmdbId: number,
  season?: number,
  episode?: number,
): string {
  if (type === 'movie') return `movie:${tmdbId}`;
  return `ep:${tmdbId}:${season ?? 0}:${episode ?? 0}`;
}

/** Invalide le cache pour un film/épisode (après re-scrape par ex.). */
export function invalidateCache(key: string): void {
  streamCache.delete(key);
  console.log(`[StreamCache] Cache invalidated for key: ${key}`);
}
