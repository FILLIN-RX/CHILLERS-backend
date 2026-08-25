// @ts-nocheck
import axios_1 from "axios";
import * as opensubtitles_config_1 from "./opensubtitles.config";
import * as opensubtitles_service_1 from "./opensubtitles.service";
import * as srt_to_vtt_1 from "./srt-to-vtt";
import * as torrents_utils_1 from "../../streaming/torrents/torrents.utils";
export async function findSubs(req, res) {
    if (!(0, opensubtitles_config_1.isOpenSubtitlesConfigured)()) {
        res.status(503).json({ success: false, subtitles: [], message: 'Module sous-titres désactivé (OPENSUBTITLES_USER/PASS manquantes)' });
        return;
    }
    const title = String(req.query.title || '').trim();
    if (!title) {
        res.status(400).json({ success: false, subtitles: [], message: 'Paramètre "title" requis' });
        return;
    }
    const year = parseInt(String(req.query.year || ''), 10) || undefined;
    const season = parseInt(String(req.query.season || ''), 10) || undefined;
    const episode = parseInt(String(req.query.episode || ''), 10) || undefined;
    const type = String(req.query.type || 'movie');
    const langs = String(req.query.langs || 'fr,en')
        .split(',')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean);
    try {
        const subtitles = await (0, opensubtitles_service_1.searchSubtitles)({
            title,
            year,
            type: type === 'tv' || type === 'series' ? 'episode' : 'movie',
            season,
            episode,
            langs,
        });
        res.json({ success: true, subtitles, message: null });
    }
    catch (err) {
        console.error(`[Subtitles] Erreur recherche "${title}": ${(0, torrents_utils_1.errMessage)(err)}`);
        res.status(500).json({ success: false, subtitles: [], message: 'Erreur lors de la recherche de sous-titres' });
    }
}
export async function getSubFile(req, res) {
    if (!(0, opensubtitles_config_1.isOpenSubtitlesConfigured)()) {
        res.status(503).send('Module sous-titres désactivé');
        return;
    }
    const fileId = parseInt(String(req.params.fileId), 10);
    if (!Number.isFinite(fileId)) {
        res.status(400).send('fileId invalide');
        return;
    }
    try {
        const file = await (0, opensubtitles_service_1.downloadSubtitle)(fileId);
        if (!file) {
            res.status(404).send('Sous-titre introuvable');
            return;
        }
        const vtt = file.format === 'vtt' ? file.buffer.toString('utf8') : (0, srt_to_vtt_1.srtToVtt)(file.buffer.toString('utf8'));
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Disposition', 'inline; filename="subtitle.vtt"');
        res.send(vtt);
    }
    catch (err) {
        if (axios_1.isAxiosError(err) && err.response?.status === 401) {
            // Token expiré → un seul renouvellement, puis abandon.
            try {
                await (0, opensubtitles_service_1.refreshToken)();
                const file = await (0, opensubtitles_service_1.downloadSubtitle)(fileId);
                if (!file) {
                    res.status(404).send('Sous-titre introuvable');
                    return;
                }
                const vtt = file.format === 'vtt' ? file.buffer.toString('utf8') : (0, srt_to_vtt_1.srtToVtt)(file.buffer.toString('utf8'));
                res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.send(vtt);
                return;
            }
            catch (retryErr) {
                console.error(`[Subtitles] Erreur après refresh token (${fileId}): ${(0, torrents_utils_1.errMessage)(retryErr)}`);
            }
        }
        if (axios_1.isAxiosError(err) && err.response?.status === 429) {
            res.status(429).send('Limite OpenSubtitles atteinte — réessaie dans quelques minutes');
            return;
        }
        console.error(`[Subtitles] Erreur téléchargement (${fileId}): ${(0, torrents_utils_1.errMessage)(err)}`);
        res.status(502).send('Échec du téléchargement du sous-titre');
    }
}
