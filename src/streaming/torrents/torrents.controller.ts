// @ts-nocheck
import axios_1 from "axios";
import * as child_process_1 from "child_process";
import * as config_1 from "./config";
import * as torrents_utils_1 from "./torrents.utils";
export async function healthCheck(_req, res) {
    if (!(0, config_1.isTorrentsConfigured)()) {
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
        await axios_1.get(`${config_1.PROWLARR_URL}/api/v1/system/status`, {
            headers: { 'X-Api-Key': config_1.PROWLARR_API_KEY },
            timeout: 4000,
        });
        checks.prowlarr = true;
    }
    catch (err) {
        console.warn(`[Torrents] Prowlarr injoignable: ${(0, torrents_utils_1.errMessage)(err)}`);
    }
    try {
        await axios_1.post(`${config_1.TORRSERVER_URL}/torrents`, { action: 'list' }, { timeout: 4000 });
        checks.torrserver = true;
    }
    catch (err) {
        console.warn(`[Torrents] TorrServer injoignable: ${(0, torrents_utils_1.errMessage)(err)}`);
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
function parseRangeStart(range) {
    if (!range)
        return null;
    const m = /^bytes=(\d+)-/i.exec(range.trim());
    if (!m)
        return null;
    return parseInt(m[1], 10);
}
function ffmpegArgs(inputUrl, seekSeconds) {
    const seek = seekSeconds && seekSeconds > 0 ? ['-ss', String(seekSeconds)] : [];
    return [
        '-hide_banner',
        '-loglevel', 'error',
        ...seek,
        '-re',
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
export async function streamFile(req, res) {
    const hash = req.query.hash;
    const index = req.query.index;
    if (!hash) {
        res.status(400).send('Hash requis');
        return;
    }
    const rangeStart = parseRangeStart(req.headers.range);
    // Seek : le navigateur demande `bytes=START-`. On convertit l'offset en
    // secondes via le débit cible et on relance FFmpeg à cette position.
    // La durée totale d'un flux P2P étant inconnue, Content-Range reste ouvert.
    const seekSeconds = rangeStart ? Math.floor(rangeStart / (TARGET_BITRATE_BPS / 8)) : undefined;
    const inputUrl = `${config_1.TORRSERVER_URL}/stream?link=${hash}&index=${index || 0}&play` +
        (seekSeconds !== undefined ? `&pos=${rangeStart}` : '');
    console.log(`[Torrents][FFmpeg] Transcodage à la volée: ${hash} (fichier ${index || 0})` +
        (seekSeconds !== undefined ? ` — seek à ${seekSeconds}s (range ${rangeStart})` : ''));
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    if (rangeStart !== null) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${rangeStart}-*/*`);
    }
    const ffmpeg = (0, child_process_1.spawn)(config_1.FFMPEG_PATH, ffmpegArgs(inputUrl, seekSeconds));
    ffmpeg.stdout.pipe(res);
    ffmpeg.on('error', (err) => {
        console.error('[Torrents][FFmpeg] Erreur:', err.message);
        if (!res.headersSent)
            res.status(500).send('FFmpeg indisponible sur le serveur');
    });
    ffmpeg.on('close', (code) => {
        console.log(`[Torrents][FFmpeg] Processus terminé (code ${code})`);
        if (!res.writableEnded)
            res.end();
    });
    req.on('close', () => {
        ffmpeg.kill('SIGKILL');
    });
}
/** Téléchargement direct du fichier (proxy du flux TorrServer). */
export async function downloadFile(req, res) {
    const hash = req.query.hash;
    const index = req.query.index;
    const name = req.query.name;
    if (!hash) {
        res.status(400).send('Hash requis');
        return;
    }
    console.log(`[Torrents][Download] "${name || hash}"`);
    try {
        const response = await axios_1({
            method: 'get',
            url: `${config_1.TORRSERVER_URL}/stream?link=${hash}&index=${index || 0}&play`,
            responseType: 'stream',
            timeout: 0,
        });
        const fileName = name || `video-${hash}.mkv`;
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        response.data.pipe(res);
    }
    catch (err) {
        console.error(`[Torrents][Download] Erreur: ${(0, torrents_utils_1.errMessage)(err)}`);
        if (!res.headersSent)
            res.status(500).send('Échec du téléchargement.');
    }
}
