/**
 * prowlarr.service.ts — recherche intelligente via Prowlarr.
 *
 * - Recherche par requêtes successives (Titre S01E02 → Titre (Année) → Titre)
 * - Scoring + tri (voir torrents.utils.ts)
 * - Résolution des liens d'indexeur (redirections → magnet ou .torrent)
 */

import axios from 'axios';
import { PROWLARR_URL, PROWLARR_API_KEY } from './config';
import { TorrentCandidate, sortTorrents, buildSearchQueries, errMessage } from './torrents.utils';

const SEARCH_TIMEOUT = 12000;

interface ProwlarrSearchItem {
  title: string;
  indexer?: string;
  size?: number;
  seeders?: number;
  magnetUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  guid?: string;
}

export interface SearchOptions {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  limit?: number;
}

/** Recherche Prowlarr avec fallback de requêtes de plus en plus larges. */
export async function searchTorrents(opts: SearchOptions): Promise<TorrentCandidate[]> {
  if (!PROWLARR_API_KEY) return [];

  const queries = buildSearchQueries(opts);

  for (const query of queries) {
    try {
      const items = await searchOnce(query);
      if (items.length > 0) {
        const sorted = sortTorrents(items);
        console.log(`[Torrents] "${query}" → ${sorted.length} résultats, meilleur score ${scoreLabel(sorted[0])}`);
        return sorted.slice(0, opts.limit ?? 10);
      }
    } catch (err: unknown) {
      console.warn(`[Torrents] Recherche "${query}" échouée: ${errMessage(err)}`);
    }
  }

  console.log(`[Torrents] Aucun résultat pour "${opts.title}"`);
  return [];
}

function scoreLabel(item: TorrentCandidate): string {
  const sizeGB = item.size > 0 ? (item.size / 1024 ** 3).toFixed(2) : '?';
  return `"${item.title}" (${item.seeders} seeds, ${sizeGB} GB, ${item.indexer})`;
}

async function searchOnce(query: string): Promise<TorrentCandidate[]> {
  const response = await axios.get(`${PROWLARR_URL}/api/v1/search`, {
    // Tableau → sérialisé en "categories=2000&categories=5000" (format requis
    // par l'API Prowlarr : une chaîne "2000,5000" renvoie un 400).
    params: { query, categories: [2000, 5000], limit: 50 },
    headers: { 'X-Api-Key': PROWLARR_API_KEY },
    timeout: SEARCH_TIMEOUT,
  });

  const raw = (response.data || []) as ProwlarrSearchItem[];

  return raw
    .filter((item) => (item.magnetUrl || item.downloadUrl) && (item.seeders ?? 0) > 0)
    .map((item) => ({
      title: item.title,
      indexer: item.indexer || 'Inconnu',
      size: item.size || 0,
      seeders: item.seeders || 0,
      magnet: item.magnetUrl,
      downloadUrl: item.downloadUrl,
      infoHash: item.infoHash || String(item.guid || '').split(':').pop(),
    }));
}

/** Ajoute la clé API Prowlarr à une URL d'indexeur (liens protégés). */
export function fixProwlarrUrl(url: string): string {
  if (url.startsWith('http') && !url.includes('apikey=')) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}apikey=${PROWLARR_API_KEY}`;
  }
  return url;
}

/**
 * Résout le lien d'un résultat : suit les redirections de l'indexeur
 * jusqu'à obtenir un magnet (streaming) ou le fichier .torrent en base64.
 *
 * Attention : Prowlarr renvoie parfois `magnetUrl` sous forme d'URL HTTP
 * (proxy de téléchargement du .torrent) — seul un vrai "magnet:" est
 * traité comme lien direct.
 */
export async function resolveTorrentLink(
  item: TorrentCandidate,
  redirects = 5
): Promise<{ kind: 'link' | 'file'; data: string }> {
  if (item.magnet && item.magnet.startsWith('magnet:')) {
    return { kind: 'link', data: item.magnet };
  }
  const url = item.magnet || item.downloadUrl;
  if (!url) throw new Error('Résultat sans lien téléchargeable');
  if (redirects <= 0) throw new Error('Trop de redirections pour résoudre le lien');

  const response = await axios.get(fixProwlarrUrl(url), {
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
    responseType: 'arraybuffer',
    timeout: 15000,
  });

  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    const location = String(response.headers.location);
    if (location.startsWith('magnet:')) return { kind: 'link', data: location };
    return resolveTorrentLink({ ...item, magnet: location, downloadUrl: undefined }, redirects - 1);
  }

  return { kind: 'file', data: Buffer.from(response.data).toString('base64') };
}
