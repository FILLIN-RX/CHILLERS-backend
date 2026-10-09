/**
 * torrents.controller.ts — routes HTTP du module torrents.
 *
 * - /health   : état Prowlarr + TorrServer (utilisé par Docker/Render)
 * - /stream   : transcodage FFmpeg à la volée → MP4 fragmenté
 * - /download : téléchargement direct proxy depuis TorrServer
 */

import { Request, Response } from 'express';
import axios from 'axios';
import { spawn } from 'child_process';
import {
  PROWLARR_URL,
  PROWLARR_API_KEY,
  TORRSERVER_URL,
  FFMPEG_PATH,
  isTorrentsConfigured,
} from './config';
import { errMessage } from './utils/torrents.utils';
import { verifyTorrentToken } from './utils/stream-token';

const HASH_RE = /^[0-9a-f]{40}$/i;

/** Un transcode = un process FFmpeg + un attachement P2P : trois suffisent par conteneur. */
const MAX_CONCURRENT_TRANSCODES = 3;
let activeTranscodes = 0;

/**
 * Contrôle une requête de flux torrent.
 *
 * Le hash n'est légitime que s'il sort du ProviderManager : `buildStreamUrl`
 * signe (hash, index) avec JWT_SECRET. Sans ce contrôle, la route était un
 * relais P2P anonyme — n'importe quel visiteur pouvait faire télécharger et
 * transcoder l'info_hash de son choix par l'IP du serveur.
 */
function readTorrentTarget(req: Request, res: Response): { hash: string; index: number } | null {
  const hash = String(req.query.hash || '');
  const index = Number(String(req.query.index ?? '0'));

  if (!HASH_RE.test(hash)) {
    res.status(400).send('Hash de torrent invalide');
    return null;
  }
  if (!Number.isInteger(index) || index < 0 || index > 9999) {
    res.status(400).send('Index de fichier invalide');
    return null;
  }
  if (!verifyTorrentToken(req.query.t as string | undefined, { hash, index })) {
    res.status(403).json({ success: false, message: 'Jeton de flux invalide ou expiré' });
    return null;
  }

  return { hash, index };
}

export async function healthCheck(_req: Request, res: Response) {
  if (!isTorrentsConfigured()) {
    res.json({
      success: true,
      enabled: false,
      checks: { prowlarr: false, torrserver: false },
      message: 'Module torrents désactivé (PROWLARR_API_KEY manquante)',
    });
    return;
  }

  const checks = { prowlarr: false, torrserver: false };

  try {
    await axios.get(`${PROWLARR_URL}/api/v1/system/status`, {
      headers: { 'X-Api-Key': PROWLARR_API_KEY },
      timeout: 4000,
    });
    checks.prowlarr = true;
  } catch (err: unknown) {
    console.warn(`[Torrents] Prowlarr injoignable: ${errMessage(err)}`);
  }

  try {
    await axios.post(`${TORRSERVER_URL}/torrents`, { action: 'list' }, { timeout: 4000 });
    checks.torrserver = true;
  } catch (err: unknown) {
    console.warn(`[Torrents] TorrServer injoignable: ${errMessage(err)}`);
  }

  res.json({ success: true, enabled: true, checks });
}

/**
 * Débit cible de sortie (video + audio, en bit/s) — fixé pour que le flux
 * transcodé ait un débit quasi constant. C'est lui qui permet de mapper une
 * requête `Range: bytes=N-` du navigateur vers une position temporelle
 * (seek = bytes ÷ débit). On l'utilise aussi hors seek pour garder un
 * flux homogène d'un seek à l'autre.
 */
const TARGET_BITRATE_BPS = (2500 + 128) * 1000;
const VIDEO_BITRATE = '2500k';

/** Extrait l'offset de départ d'un header Range simple (`bytes=START-`). */
function parseRangeStart(range: string | undefined): number | null {
  if (!range) return null;
  const m = /^bytes=(\d+)-/i.exec(range.trim());
  if (!m) return null;
  return parseInt(m[1], 10);
}

function ffmpegArgs(inputUrl: string, seekSeconds?: number): string[] {
  const seek = seekSeconds && seekSeconds > 0 ? ['-ss', String(seekSeconds)] : [];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...seek,
    '-i', inputUrl,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', VIDEO_BITRATE,
    '-maxrate', VIDEO_BITRATE,
    '-bufsize', '5000k',
    '-g', '48',
    '-keyint_min', '24',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
}

/** Transcode le flux TorrServer en MP4 fragmenté compatible <video>, avec seek. */
export async function streamFile(req: Request, res: Response) {
  const target = readTorrentTarget(req, res);
  if (!target) return;
  const { hash, index } = target;

  if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
    res.status(503).json({ success: false, message: 'Transcode torrents saturé, réessayez' });
    return;
  }
  activeTranscodes++;

  const rangeStart = parseRangeStart(req.headers.range);

  // Seek : le navigateur demande `bytes=START-`. On convertit l'offset en
  // secondes via le débit cible et on relance FFmpeg à cette position.
  // La durée totale d'un flux P2P étant inconnue, Content-Range reste ouvert.
  const seekSeconds = rangeStart ? Math.floor(rangeStart / (TARGET_BITRATE_BPS / 8)) : undefined;

  const inputUrl = `${TORRSERVER_URL}/stream?link=${hash}&index=${index}&play` +
    (seekSeconds !== undefined ? `&pos=${rangeStart}` : '');

  console.log(
    `[Torrents][FFmpeg] Transcodage à la volée: ${hash} (fichier ${index})` +
      (seekSeconds !== undefined ? ` — seek à ${seekSeconds}s (range ${rangeStart})` : ''),
  );

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');

  if (rangeStart !== null) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${rangeStart}-*/*`);
  }

  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs(inputUrl, seekSeconds));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeTranscodes = Math.max(0, activeTranscodes - 1);
  };

  ffmpeg.stdout.pipe(res);

  ffmpeg.on('error', (err) => {
    release();
    console.error('[Torrents][FFmpeg] Erreur:', err.message);
    if (!res.headersSent) res.status(500).send('FFmpeg indisponible sur le serveur');
  });

  ffmpeg.on('close', (code) => {
    release();
    console.log(`[Torrents][FFmpeg] Processus terminé (code ${code})`);
    if (!res.headersSent && code !== 0) {
      res.status(502).json({ success: false, message: 'Flux P2P indisponible ou interrompu' });
      return;
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    release();
    ffmpeg.kill('SIGKILL');
  });
}

/** Téléchargement direct du fichier (proxy du flux TorrServer). */
export async function downloadFile(req: Request, res: Response) {
  const target = readTorrentTarget(req, res);
  if (!target) return;
  const { hash, index } = target;
  const name = req.query.name as string | undefined;

  console.log(`[Torrents][Download] "${name || hash}"`);

  try {
    const response = await axios({
      method: 'get',
      url: `${TORRSERVER_URL}/stream?link=${hash}&index=${index}&play`,
      responseType: 'stream',
      timeout: 0,
    });

    const fileName = name || `video-${hash}.mkv`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    response.data.pipe(res);
  } catch (err: unknown) {
    console.error(`[Torrents][Download] Erreur: ${errMessage(err)}`);
    if (!res.headersSent) res.status(500).send('Échec du téléchargement.');
  }
}
