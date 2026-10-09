/**
 * prowlarr.service.ts — recherche intelligente via Prowlarr.
 *
 * - Recherche par requêtes successives (Titre S01E02 → Titre (Année) → Titre)
 * - Scoring + tri (voir torrents.utils.ts)
 * - Résolution des liens d'indexeur (redirections → magnet ou .torrent)
 */

import axios from 'axios';
import { PROWLARR_URL, PROWLARR_API_KEY } from './config';
import {
  TorrentCandidate,
  sortTorrents,
  buildSearchQueries,
  isEpisodeRelease,
  errMessage,
} from './utils/torrents.utils';

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

/**
 * @param deadlineAt butoir absolu (Date.now() + ms). Le budget global du provider
 *        torrents est borné par ProviderManager (TORRENT_TIMEOUT) : sans coup de
 *        pouce ici, la 3e ou 4e requête de fallback mange tout le temps réservé
 *        à addTorrent + attente des métadonnées, et l'abort laisse le joueur
 *        sans rien alors que le torrent existait.
 */
export async function searchTorrents(
  opts: SearchOptions,
  deadlineAt?: number
): Promise<TorrentCandidate[]> {
  if (!PROWLARR_API_KEY) return [];

  const queries = buildSearchQueries(opts);

  for (const query of queries) {
    const left = deadlineAt ? deadlineAt - Date.now() : SEARCH_TIMEOUT;
    if (left < 1500) {
      console.warn(`[Torrents] Budget écoulé avant « ${query} », on s'arrête là.`);
      break;
    }

    try {
      const items = await searchOnce(query, Math.min(SEARCH_TIMEOUT, left));
      let sorted = sortTorrents(items);

      // Un résultat sans marque de saison est un film homonyme : « Naruto » seul
      // remonte le film de 2012, que pickVideoFile servirait comme S01E01.
      if (opts.season != null) {
        sorted = sorted.filter((it) => isEpisodeRelease(it.title, opts.season as number, opts.episode));
      }

      if (sorted.length > 0) {
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

async function searchOnce(query: string, timeoutMs = SEARCH_TIMEOUT): Promise<TorrentCandidate[]> {
  const response = await axios.get(`${PROWLARR_URL}/api/v1/search`, {
    // Tableau → sérialisé en "categories=2000&categories=5000" (format requis
    // par l'API Prowlarr : une chaîne "2000,5000" renvoie un 400).
    params: { query, categories: [2000, 5000], limit: 50 },
    headers: { 'X-Api-Key': PROWLARR_API_KEY },
    timeout: timeoutMs,
  });

  const raw = (response.data || []) as ProwlarrSearchItem[];

  return raw
    // NB : chez YTS, Prowlarr remonte la santé du torrent en pourcentage dans
    // `seeders` (100 = « santé pleine », pas 100 pairs) — ce filtre écarte les
    // indexeurs muets, pas les torrents morts. Le vrai test reste le warm-up P2P.
    .filter((item) => (item.magnetUrl || item.downloadUrl || item.infoHash) && (item.seeders ?? 0) > 0)
    .map((item) => {
      let infoHash = item.infoHash;
      if (!infoHash && item.guid) {
        const hashMatch = String(item.guid).match(/([0-9a-fA-F]{40})/);
        if (hashMatch) infoHash = hashMatch[1];
      }
      if (!infoHash && (item.magnetUrl || item.downloadUrl)) {
        const m = (item.magnetUrl || item.downloadUrl || '').match(/btih:([0-9a-fA-F]{40})/i);
        if (m) infoHash = m[1];
      }
      return {
        title: item.title,
        indexer: item.indexer || 'Inconnu',
        size: item.size || 0,
        seeders: item.seeders || 0,
        magnet: item.magnetUrl,
        downloadUrl: item.downloadUrl,
        infoHash,
      };
    });
}

const DEFAULT_TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://glotorrents.pw:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://torrent.gresille.org:80/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
];

export function buildMagnetFromHash(infoHash: string, title?: string): string {
  const tr = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}${title ? `&dn=${encodeURIComponent(title)}` : ''}${tr}`;
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
 * En cas d'échec de téléchargement du .torrent (404/timeout), repli automatique
 * sur un lien magnet direct construit depuis infoHash.
 */
export async function resolveTorrentLink(
  item: TorrentCandidate,
  redirects = 5
): Promise<{ kind: 'link' | 'file'; data: string }> {
  // 1. Si on a déjà un magnet natif
  if (item.magnet && item.magnet.startsWith('magnet:')) {
    return { kind: 'link', data: item.magnet };
  }

  // 2. Préférer le téléchargement du fichier .torrent via downloadUrl
  // (Prowlarr fournit un lien HTTP de download valide vers le tracker avec le fichier binaire)
  const url = item.downloadUrl || (item.magnet && item.magnet.startsWith('http') ? item.magnet : undefined);

  if (url) {
    try {
      const response = await axios.get(fixProwlarrUrl(url), {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        responseType: 'arraybuffer',
        timeout: 15000,
      });

      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        const location = String(response.headers.location);
        if (location.startsWith('magnet:')) return { kind: 'link', data: location };
        return resolveTorrentLink({ ...item, downloadUrl: location, magnet: undefined }, redirects - 1);
      }

      const contentType = String(response.headers['content-type'] || '');
      if (
        response.data &&
        response.data.byteLength > 0 &&
        !contentType.includes('application/json') &&
        !contentType.includes('text/html')
      ) {
        return { kind: 'file', data: Buffer.from(response.data).toString('base64') };
      }
    } catch (err: any) {
      console.warn(`[Torrents] Échec téléchargement .torrent (${err?.message || err})`);
    }
  }

  // 3. Fallback immédiat et inconditionnel : si on a un infoHash, construire le lien magnet direct
  if (item.infoHash && /^[0-9a-f]{40}$/i.test(item.infoHash)) {
    console.log(`[Torrents] ✅ Utilisation du lien magnet direct depuis infoHash: ${item.infoHash}`);
    return { kind: 'link', data: buildMagnetFromHash(item.infoHash, item.title) };
  }

  throw new Error('Résultat sans lien téléchargeable ni infoHash');
}
