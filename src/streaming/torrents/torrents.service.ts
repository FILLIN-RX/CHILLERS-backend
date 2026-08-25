// @ts-nocheck
import axios_1 from "axios";
import * as config_1 from "./config";
import * as torrents_utils_1 from "./torrents.utils";
const ADD_TIMEOUT = 30000;
const POLL_TIMEOUT = 10000;
/** Ajoute le torrent (magnet ou fichier .torrent base64) et retourne son hash. */
export async function addTorrent(source, title) {
    const payload = {
        action: 'add',
        title: title || 'Chillers Stream',
        save_to_db: true,
    };
    if (source.kind === 'file') {
        payload.file = source.data;
    }
    else {
        payload.link = source.data;
    }
    const res = await axios_1.post(`${config_1.TORRSERVER_URL}/torrents`, payload, { timeout: ADD_TIMEOUT });
    const hash = res.data?.hash;
    if (!hash)
        throw new Error('TorrServer: hash introuvable dans la réponse');
    return hash;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Attend que TorrServer expose les métadonnées du torrent puis sélectionne
 * le fichier vidéo (SxxExx si épisode demandé, sinon le plus gros).
 */
export async function waitForFileInfo(hash, opts, maxRetries = 20) {
    for (let i = 0; i < maxRetries; i++) {
        await sleep(1000);
        try {
            const res = await axios_1.post(`${config_1.TORRSERVER_URL}/torrents`, { action: 'get', hash }, { timeout: POLL_TIMEOUT });
            const torrent = res.data;
            if (torrent?.file_stats?.length) {
                const info = (0, torrents_utils_1.pickVideoFile)(torrent.file_stats, opts.season, opts.episode);
                if (info)
                    return info;
            }
        }
        catch (err) {
            if (i === maxRetries - 1) {
                console.warn(`[Torrents] Poll métadonnées ${hash} échoué: ${(0, torrents_utils_1.errMessage)(err)}`);
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
export async function warmUpTorrent(hash, index) {
    try {
        const res = await axios_1.get(`${config_1.TORRSERVER_URL}/stream?link=${hash}&index=${index}&play`, {
            responseType: 'stream',
            timeout: 10000,
        });
        await new Promise((resolve) => {
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
    }
    catch (err) {
        console.warn(`[Torrents] Warm-up ignoré (non bloquant): ${(0, torrents_utils_1.errMessage)(err)}`);
    }
}
/** URL same-origin du flux transcode (consommée par le <video> du frontend). */
export function buildStreamUrl(hash, index) {
    return `/api/torrents/stream?hash=${encodeURIComponent(hash)}&index=${index}`;
}
