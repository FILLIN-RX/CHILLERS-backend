/**
 * prowlarr.service.ts — recherche intelligente via Prowlarr.
 *
 * - Recherche par requêtes successives (Titre S01E02 → Titre (Année) → Titre)
 * - Scoring + tri (voir torrents.utils.ts)
 * - Résolution des liens d'indexeur (redirections → magnet ou .torrent)
 */

import axios from 'axios';
import crypto from 'crypto';
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
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
];

export function buildMagnetFromHash(infoHash: string, title?: string): string {
  const tr = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}${title ? `&dn=${encodeURIComponent(title)}` : ''}${tr}`;
}

/** Extrait le SHA-1 infoHash d'un buffer .torrent encodé en bencode */
export function extractInfoHashFromTorrentBuffer(buf: Buffer): string | null {
  const marker = Buffer.from('4:info');
  const idx = buf.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  let depth = 0;
  let i = start;
  while (i < buf.length) {
    const char = String.fromCharCode(buf[i]);
    if (char === 'd' || char === 'l') {
      depth++;
      i++;
    } else if (char === 'e') {
      depth--;
      i++;
      if (depth === 0) break;
    } else if (char === 'i') {
      i++;
      while (i < buf.length && String.fromCharCode(buf[i]) !== 'e') i++;
      if (i < buf.length) i++;
    } else if (char >= '0' && char <= '9') {
      let lenStr = '';
      while (i < buf.length && String.fromCharCode(buf[i]) >= '0' && String.fromCharCode(buf[i]) <= '9') {
        lenStr += String.fromCharCode(buf[i]);
        i++;
      }
      if (i < buf.length && String.fromCharCode(buf[i]) === ':') {
        i++;
        const strLen = parseInt(lenStr, 10);
        i += strLen;
      }
    } else {
      i++;
    }
  }
  if (i <= buf.length && depth === 0) {
    const infoSlice = buf.subarray(start, i);
    return crypto.createHash('sha1').update(infoSlice).digest('hex');
  }
  return null;
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
 * Résout le lien d'un résultat en lien magnet directement ingérable par TorrServer.
 *
 * TorrServer attend `action: 'add', link: '<magnet>'`.
 * Si infoHash est déjà connu (YTS, 1337x, etc.), le magnet complet avec trackers
 * est généré instantanément sans requête HTTP externe.
 */
export async function resolveTorrentLink(
  item: TorrentCandidate,
  redirects = 5
): Promise<string> {
  // 1. Si on a déjà un magnet natif
  if (item.magnet && item.magnet.startsWith('magnet:')) {
    return item.magnet;
  }

  // 2. Si on a l'infoHash (40 caractères hex), construction immédiate du magnet avec trackers
  if (item.infoHash && /^[0-9a-f]{40}$/i.test(item.infoHash)) {
    return buildMagnetFromHash(item.infoHash, item.title);
  }

  // 3. Sinon, suivre l'URL HTTP de téléchargement pour récupérer la redirection magnet ou le .torrent
  const url = item.downloadUrl || (item.magnet && item.magnet.startsWith('http') ? item.magnet : undefined);

  if (url && redirects > 0) {
    try {
      const response = await axios.get(fixProwlarrUrl(url), {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        responseType: 'arraybuffer',
        timeout: 10000,
      });

      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        const location = String(response.headers.location);
        if (location.startsWith('magnet:')) return location;
        return resolveTorrentLink({ ...item, downloadUrl: location, magnet: undefined }, redirects - 1);
      }

      if (response.data && response.data.byteLength > 0) {
        const extracted = extractInfoHashFromTorrentBuffer(Buffer.from(response.data));
        if (extracted) {
          return buildMagnetFromHash(extracted, item.title);
        }
      }
    } catch (err: any) {
      console.warn(`[Torrents] Échec résolution URL .torrent (${err?.message || err})`);
    }
  }

  throw new Error(`Torrent "${item.title}" sans infoHash ni lien magnet valide`);
}
