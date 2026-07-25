import axios from 'axios';
import { UqloadClient } from '../uqload/uqload.client';
import { createBackup } from '../../scraping/core/backup';
import { uploadToStreamtape, isUqloadFull } from '../streamtape/streamtape.uploader';
import Serie, { type IEpisode } from '../../models/Serie';
import Movie from '../../models/Movie';

const DOOD_BASE_URL = 'https://doodapi.co/api';

export interface ReuploadResult {
    fileCode?: string;
    uqloadCode?: string;
    uqloadLink?: string;
    streamtapeCode?: string;
    streamtapeLink?: string;
    uploadedDoodstream: boolean;
    uploadedUqload: boolean;
    uploadedStreamtape: boolean;
    errors: string[];
}

function getUqloadClient(): UqloadClient | null {
    const key = process.env.UQLOAD_API_KEY;
    if (!key) return null;
    return new UqloadClient(key);
}

async function uploadToDoodstream(directUrl: string, title: string): Promise<string | null> {
    const apiKey = process.env.DOODSTREAM_API_KEY;
    if (!apiKey) {
        console.log('[Reupload] DOODSTREAM_API_KEY manquant — skip Doodstream');
        return null;
    }
    try {
        const { data } = await axios.get(`${DOOD_BASE_URL}/upload/url`, {
            params: { key: apiKey, url: directUrl, new_title: title },
            timeout: 30000,
        });
        if (data?.status !== 200 || !data?.result?.filecode) {
            console.log(`[Reupload] Doodstream payload inattendu: ${JSON.stringify(data).slice(0, 200)}`);
            return null;
        }
        return data.result.filecode;
    } catch (e: any) {
        console.log(`[Reupload] Doodstream upload échoué pour "${title}": ${e.message}`);
        return null;
    }
}

export async function reuploadEpisode(
    serieId: string,
    episode: IEpisode,
    episodeIndex: number,
): Promise<ReuploadResult> {
    const result: ReuploadResult = {
        uploadedDoodstream: false,
        uploadedUqload: false,
        uploadedStreamtape: false,
        errors: [],
    };

    const uploadTitle = `${episode.episode || `Ép ${episode.episodeNumber}`} - ${episode.lien.slice(-40)}`;

    if (!episode.fileCode) {
        const fileCode = await uploadToDoodstream(episode.lien, uploadTitle);
        if (fileCode) {
            result.fileCode = fileCode;
            result.uploadedDoodstream = true;
        } else {
            result.errors.push('Doodstream upload failed');
        }
    } else {
        result.fileCode = episode.fileCode;
    }

    const uqload = getUqloadClient();
    const uqloadFull = uqload ? await isUqloadFull() : false;

    if (uqloadFull) {
        console.log('[Reupload] Uqload storage full (>=3000GB) — fallback vers Streamtape');
        if (!episode.streamtapeCode) {
            const st = await uploadToStreamtape(episode.lien, uploadTitle);
            if (st) {
                result.streamtapeCode = st.linkId;
                result.streamtapeLink = st.embedUrl;
                result.uploadedStreamtape = true;
            } else {
                result.errors.push('Streamtape upload failed (Uqload fallback)');
            }
        } else {
            result.streamtapeCode = episode.streamtapeCode;
            result.streamtapeLink = episode.streamtapeLink;
        }
    } else if (!episode.uqloadCode && uqload) {
        try {
            const { fileCode: uqCode, directLink } = await uqload.uploadByUrlAndGetLink(
                episode.lien,
                uploadTitle,
            );
            result.uqloadCode = uqCode;
            result.uploadedUqload = true;
            const versions = (directLink as any)?.versions as Array<{ url: string; name: string }> | undefined;
            const best = versions?.find((v) => v.name === "n") ?? versions?.[0];
            if (best?.url) {
                result.uqloadLink = best.url;
            } else if ((directLink as any)?.hls_direct) {
                result.uqloadLink = (directLink as any).hls_direct;
            }
        } catch (e: any) {
            result.errors.push(`Uqload upload failed: ${e.message}`);
            console.log(`[Reupload] Uqload upload échoué: ${e.message}`);
        }
    } else if (episode.uqloadCode) {
        result.uqloadCode = episode.uqloadCode;
        result.uqloadLink = episode.uqloadLink;
    } else if (!uqload) {
        console.log('[Reupload] UQLOAD_API_KEY manquant — skip Uqload');
        result.errors.push('UQLOAD_API_KEY missing');
    }

    const $set: Record<string, any> = {};
    if (result.uploadedDoodstream && result.fileCode) {
        $set["episodes.$.fileCode"] = result.fileCode;
        $set["episodes.$.uploadedAt"] = new Date();
    }
    if (result.uploadedUqload) {
        if (result.uqloadCode) $set["episodes.$.uqloadCode"] = result.uqloadCode;
        if (result.uqloadLink) $set["episodes.$.uqloadLink"] = result.uqloadLink;
    }
    if (result.uploadedStreamtape) {
        if (result.streamtapeCode) $set["episodes.$.streamtapeCode"] = result.streamtapeCode;
        if (result.streamtapeLink) $set["episodes.$.streamtapeLink"] = result.streamtapeLink;
    }
    if (Object.keys($set).length > 0) {
        try {
            const upd = await Serie.updateOne(
                { _id: serieId, "episodes.season": episode.season, "episodes.episodeNumber": episode.episodeNumber },
                { $set },
            );
            if (upd.matchedCount === 0) {
                await Serie.updateOne(
                    { _id: serieId },
                    { $set: Object.fromEntries(Object.entries($set).map(([k, v]) => [k.replace("$.", `.${episodeIndex}.`), v])) },
                );
            }
        } catch (e: any) {
            result.errors.push(`Mongo persist failed: ${e.message}`);
        }
    }

    return result;
}

export async function reuploadMovie(
    movieId: string,
    lien: string,
    titre: string,
): Promise<ReuploadResult> {
    const result: ReuploadResult = {
        uploadedDoodstream: false,
        uploadedUqload: false,
        uploadedStreamtape: false,
        errors: [],
    };

    const uploadTitle = `${titre} - ${lien.slice(-40)}`;

    const uqload = getUqloadClient();
    const uqloadFull = uqload ? await isUqloadFull() : false;

    if (uqloadFull) {
        console.log(`[Reupload] Uqload full — Streamtape pour film "${titre}"`);
        const st = await uploadToStreamtape(lien, uploadTitle);
        if (st) {
            result.streamtapeCode = st.linkId;
            result.streamtapeLink = st.embedUrl;
            result.uploadedStreamtape = true;
            await Movie.updateOne(
                { _id: movieId },
                { $set: { streamtapeCode: st.linkId, streamtapeLink: st.embedUrl } }
            );
        } else {
            result.errors.push('Streamtape upload failed');
        }
    } else if (uqload) {
        try {
            const { fileCode: uqCode, directLink } = await uqload.uploadByUrlAndGetLink(lien, uploadTitle);
            result.uqloadCode = uqCode;
            result.uploadedUqload = true;
            const versions = (directLink as any)?.versions as Array<{ url: string; name: string }> | undefined;
            const best = versions?.find((v) => v.name === "n") ?? versions?.[0];
            if (best?.url) {
                result.uqloadLink = best.url;
            } else if ((directLink as any)?.hls_direct) {
                result.uqloadLink = (directLink as any).hls_direct;
            }
            await Movie.updateOne(
                { _id: movieId },
                { $set: { uqloadCode: uqCode, uqloadLink: result.uqloadLink } }
            );
        } catch (e: any) {
            result.errors.push(`Uqload upload failed: ${e.message}`);
        }
    }

    return result;
}

export { createBackup };
