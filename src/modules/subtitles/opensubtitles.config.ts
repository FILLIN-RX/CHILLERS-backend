// @ts-nocheck
export const OPENSUBTITLES_USER = (process.env.OPENSUBTITLES_USER || '').trim();
export const OPENSUBTITLES_PASS = (process.env.OPENSUBTITLES_PASS || '').trim();
export function isOpenSubtitlesConfigured() {
    return !!exports.OPENSUBTITLES_USER && !!exports.OPENSUBTITLES_PASS;
}
