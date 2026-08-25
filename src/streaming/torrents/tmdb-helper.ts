// @ts-nocheck
import tmdb_1 from "../../config/tmdb";
import * as torrents_utils_1 from "./torrents.utils";
export async function resolveTmdbYear(query) {
    if (!query.tmdbId)
        return undefined;
    try {
        const type = query.type === 'tv' || query.type === 'anime' ? 'tv' : 'movie';
        const res = await tmdb_1.get(`/${type}/${query.tmdbId}`);
        const raw = res.data?.release_date || res.data?.first_air_date;
        const year = raw ? Number(String(raw).slice(0, 4)) : undefined;
        return Number.isFinite(year) && year > 1900 ? year : undefined;
    }
    catch (err) {
        console.warn(`[Torrents] Année TMDB indisponible pour ${query.tmdbId}: ${(0, torrents_utils_1.errMessage)(err)}`);
        return undefined;
    }
}
