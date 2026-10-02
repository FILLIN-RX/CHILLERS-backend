/**
 * Config du module sous-titres (OpenSubtitles API v2).
 *
 * Le module ne s'active que si OPENSUBTITLES_USER + OPENSUBTITLES_PASS
 * sont définies (compte gratuit api.opensubtitles.com).
 */

export const OPENSUBTITLES_USER = (process.env.OPENSUBTITLES_USER || '').trim();
export const OPENSUBTITLES_PASS = (process.env.OPENSUBTITLES_PASS || '').trim();

export function isOpenSubtitlesConfigured(): boolean {
  return !!OPENSUBTITLES_USER && !!OPENSUBTITLES_PASS;
}
