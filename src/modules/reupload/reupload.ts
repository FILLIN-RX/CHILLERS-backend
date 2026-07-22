import axios from 'axios';
import { UqloadClient } from '../uqload/uqload.client';
import { createBackup } from '../../scraping/core/backup';
import Serie, { type IEpisode } from '../../models/Serie';

const DOOD_BASE_URL = 'https://doodapi.co/api';

/**
 * A single episode (or movie — same shape on the IEpisode contract) that
 * may or may not be mirrored to Uqload / Doodstream. The caller supplies
 * the original `lien` (the new one, freshly scraped or repaired) so we
 * always upload from a known-good source.
 */
export interface ReuploadTarget {
    _serieId?: string;        // optional — present for episodes, absent for movies
    episodeIndex?: number;    // index into serie.episodes (positional $ update)
    title: string;            // human label used as the upload title
    lien: string;             // direct mp4 URL to upload from
    fileCode?: string;        // existing Doodstream fileCode, if any
    uqloadCode?: string;      // existing Uqload fileCode, if any
    uqloadLink?: string;      // existing Uqload direct link, if any
}

export interface ReuploadResult {
    fileCode?: string;
    uqloadCode?: string;
    uqloadLink?: string;
    uploadedDoodstream: boolean;
    uploadedUqload: boolean;
    errors: string[];
}

/**
 * Lazily build a UqloadClient. We pull the key from the env on every call
 * so a config reload (rare) takes effect without restarting the process.
 */
function getUqloadClient(): UqloadClient | null {
    const key = process.env.UQLOAD_API_KEY;
    if (!key) return null;
    return new UqloadClient(key);
}

/**
 * Upload the direct URL to Doodstream and return the filecode. The api
 * returns `{ status, result: { filecode, ... } }`.
 */
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
            console.log(`[Reupload] Doodstream a renvoyé un payload inattendu: ${JSON.stringify(data).slice(0, 200)}`);
            return null;
        }
        return data.result.filecode;
    } catch (e: any) {
        console.log(`[Reupload] Doodstream upload échoué pour "${title}": ${e.message}`);
        return null;
    }
}

/**
 * Mirror a freshly-repaired (or freshly-scraped) episode to Doodstream AND
 * Uqload, but only the platforms that don't already have a copy. We
 * deliberately do NOT re-upload if the fileCode/uqloadCode is already
 * present — the assumption is that if a previous pass uploaded it, the
 * file is still good. (If the file is dead on the host's side, the host
 * health is a separate concern handled by the providers.)
 *
 * For episodes (the only call site today), we persist the new fileCodes
 * back into MongoDB in-place via a positional update.
 */
export async function reuploadEpisode(
    serieId: string,
    episode: IEpisode,
    episodeIndex: number,
): Promise<ReuploadResult> {
    const result: ReuploadResult = {
        uploadedDoodstream: false,
        uploadedUqload: false,
        errors: [],
    };

    const uploadTitle = `${episode.episode || `Ép ${episode.episodeNumber}`} - ${episode.lien.slice(-40)}`;

    // --- Doodstream ---
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

    // --- Uqload ---
    const uqload = getUqloadClient();
    if (!episode.uqloadCode && uqload) {
        try {
            const { fileCode: uqCode, directLink } = await uqload.uploadByUrlAndGetLink(
                episode.lien,
                uploadTitle,
            );
            result.uqloadCode = uqCode;
            result.uploadedUqload = true;
            // UqloadDirectLinkResult shape is `{ versions: [{ url, name, size }] }`
            // (see uqload.types.ts). Prefer the 'n' (normal) version, then
            // the first one as a fallback.
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

    // --- Persist any newly-acquired fileCodes back to MongoDB ---
    const $set: Record<string, any> = {};
    if (result.uploadedDoodstream && result.fileCode) {
        $set["episodes.$.fileCode"] = result.fileCode;
        $set["episodes.$.uploadedAt"] = new Date();
    }
    if (result.uploadedUqload) {
        if (result.uqloadCode) $set["episodes.$.uqloadCode"] = result.uqloadCode;
        if (result.uqloadLink) $set["episodes.$.uqloadLink"] = result.uqloadLink;
    }
    if (Object.keys($set).length > 0) {
        try {
            const upd = await Serie.updateOne(
                { _id: serieId, "episodes.season": episode.season, "episodes.episodeNumber": episode.episodeNumber },
                { $set },
            );
            if (upd.matchedCount === 0) {
                // Fallback to positional by index — covers the case where two
                // episodes in the same season share the same episodeNumber
                // (shouldn't happen, but the schema doesn't forbid it).
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

// Re-export so callers can wire this in cron jobs / scrapers without
// pulling multiple paths.
export { createBackup };
