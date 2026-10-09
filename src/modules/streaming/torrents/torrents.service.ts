/**
 * torrents.service.ts — orchestration côté TorrServer.
 *
 * add → attente des métadonnées (paires P2P) → détection du fichier
 * vidéo principal → préchargement des pièces.
 */

import axios from 'axios';
import { TORRSERVER_URL } from './config';
import { TorrentFile, pickVideoFile, errMessage } from './utils/torrents.utils';
import { signTorrentToken } from './utils/stream-token';

const ADD_TIMEOUT = 30000;
const POLL_TIMEOUT = 10000;

export interface TorrentFileInfo {
  index: number;
  filename: string;
  length: number;
}

export type TorrentSource = string;

/** Temps restant avant le budget du provider ; sert à ne jamais démarrer une étape vouée à l'abort. */
function leftMs(deadlineAt?: number): number {
  return deadlineAt ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
}

/** Ajoute le torrent (lien magnet ou URL) dans TorrServer et retourne son hash. */
export async function addTorrent(
  source: TorrentSource,
  title: string,
  deadlineAt?: number
): Promise<string> {
  const left = leftMs(deadlineAt);
  if (left < 2000) throw new Error('TorrServer: budget écoulé avant l’ajout du torrent');

  const payload: Record<string, unknown> = {
    action: 'add',
    link: source,
    title: title || 'Chillers Stream',
    save_to_db: true,
  };

  try {
    const res = await axios.post(`${TORRSERVER_URL}/torrents`, payload, {
      timeout: Math.min(ADD_TIMEOUT, left),
    });
    const hash = res.data?.hash;
    if (!hash) {
      if (res.data?.error) {
        throw new Error(`TorrServer: ${res.data.error}`);
      }
      throw new Error('TorrServer: hash introuvable dans la réponse');
    }
    return hash;
  } catch (err: any) {
    if (err.response?.status === 404 && err.response?.data?.message === 'Route not found') {
      console.error(
        `[TorrServer] ⚠️ CONFIGURATION ERROR: TORRSERVER_URL (${TORRSERVER_URL}) pointe vers une instance Express au lieu du binaire TorrServer ! Dans Railway, le service 'torrserver' doit déployer l'image Docker 'ghcr.io/yourok/torrserver:latest' (port 8090) et non le repository GitHub du backend.`
      );
      throw new Error(`TorrServer 404: ${TORRSERVER_URL} est un backend Express ("Route not found"), pas TorrServer`);
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Attend que TorrServer expose les métadonnées du torrent puis sélectionne
 * le fichier vidéo (SxxExx si épisode demandé, sinon le plus gros).
 *
 * L'attente est bornée par le budget du provider : chaque tentative coûte
 * ~1 s de sleep + le poll, mieux vaut échouer vite et proprement que de
 * faire avorter toute la chaîne par ProviderManager en cours de route.
 */
export async function waitForFileInfo(
  hash: string,
  opts: { season?: number; episode?: number },
  deadlineAt?: number
): Promise<TorrentFileInfo | null> {
  const maxRetries = Math.max(3, Math.min(20, Math.floor(leftMs(deadlineAt) / 2500)));

  for (let i = 0; i < maxRetries; i++) {
    if (leftMs(deadlineAt) < 2500) {
      console.warn(`[Torrents] Budget écoulé après ${i} tentative(s) de métadonnées pour ${hash}`);
      return null;
    }
    await sleep(1000);
    try {
      const res = await axios.post(
        `${TORRSERVER_URL}/torrents`,
        { action: 'get', hash },
        { timeout: Math.min(POLL_TIMEOUT, Math.max(1000, leftMs(deadlineAt))) }
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
export async function warmUpTorrent(hash: string, index: number, deadlineAt?: number): Promise<void> {
  // Moins de 8 s restants : le warm-up avalerait le budget du premier segment.
  if (leftMs(deadlineAt) < 8000) return;

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
  const token = signTorrentToken({ hash, index });
  return `/api/torrents/stream?hash=${encodeURIComponent(hash)}&index=${index}&t=${token}`;
}
