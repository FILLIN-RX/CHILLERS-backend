/**
 * torrents.service.ts — orchestration côté TorrServer.
 *
 * add → attente des métadonnées (paires P2P) → détection du fichier
 * vidéo principal → préchargement des pièces.
 */

import axios from 'axios';
import { TORRSERVER_URL } from './config';
import { TorrentFile, pickVideoFile, errMessage } from './torrents.utils';

const ADD_TIMEOUT = 30000;
const POLL_TIMEOUT = 10000;

export interface TorrentFileInfo {
  index: number;
  filename: string;
  length: number;
}

export type TorrentSource = { kind: 'link'; data: string } | { kind: 'file'; data: string };

/** Ajoute le torrent (magnet ou fichier .torrent base64) et retourne son hash. */
export async function addTorrent(source: TorrentSource, title: string): Promise<string> {
  const payload: Record<string, unknown> = {
    action: 'add',
    title: title || 'Chillers Stream',
    save_to_db: true,
  };
  if (source.kind === 'file') {
    payload.file = source.data;
  } else {
    payload.link = source.data;
  }

  const res = await axios.post(`${TORRSERVER_URL}/torrents`, payload, { timeout: ADD_TIMEOUT });
  const hash = res.data?.hash;
  if (!hash) throw new Error('TorrServer: hash introuvable dans la réponse');
  return hash;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Attend que TorrServer expose les métadonnées du torrent puis sélectionne
 * le fichier vidéo (SxxExx si épisode demandé, sinon le plus gros).
 */
export async function waitForFileInfo(
  hash: string,
  opts: { season?: number; episode?: number },
  maxRetries = 20
): Promise<TorrentFileInfo | null> {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(1000);
    try {
      const res = await axios.post(
        `${TORRSERVER_URL}/torrents`,
        { action: 'get', hash },
        { timeout: POLL_TIMEOUT }
      );
      const torrent = res.data;
      if (torrent?.file_stats?.length) {
        const info = pickVideoFile(torrent.file_stats as TorrentFile[], opts.season, opts.episode);
        if (info) return info;
      }
    } catch (err: unknown) {
      if (i === maxRetries - 1) {
        console.warn(`[Torrents] Poll métadonnées ${hash} échoué: ${errMessage(err)}`);
      }
    }
  }
  return null;
}

/**
 * Warm-up P2P : lit le début du flux TorrServer pendant quelques secondes.
 * L'action "preload" n'existe pas dans toutes les versions de TorrServer
 * (400) — mais un GET /stream démarre le torrent et précharge les pièces
 * autour de la position. Non bloquant en cas d'échec.
 */
export async function warmUpTorrent(hash: string, index: number): Promise<void> {
  try {
    const res = await axios.get(`${TORRSERVER_URL}/stream?link=${hash}&index=${index}&play`, {
      responseType: 'stream',
      timeout: 10000,
    });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        res.data.destroy();
        resolve();
      }, 5000);
      res.data.once('data', () => {
        clearTimeout(timer);
        res.data.destroy();
        resolve();
      });
      res.data.once('end', () => {
        clearTimeout(timer);
        resolve();
      });
      res.data.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    console.log(`[Torrents] Warm-up P2P effectué pour ${hash} (fichier ${index})`);
  } catch (err: unknown) {
    console.warn(`[Torrents] Warm-up ignoré (non bloquant): ${errMessage(err)}`);
  }
}

/** URL same-origin du flux transcode (consommée par le <video> du frontend). */
export function buildStreamUrl(hash: string, index: number): string {
  return `/api/torrents/stream?hash=${encodeURIComponent(hash)}&index=${index}`;
}
