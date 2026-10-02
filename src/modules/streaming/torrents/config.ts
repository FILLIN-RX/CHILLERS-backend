/**
 * Config du module torrents (Prowlarr + TorrServer + FFmpeg).
 *
 * Le module est un fallback de secours : il ne s'active que si
 * PROWLARR_API_KEY est définie (env de prod Render / self-hosted).
 * Sans clé, isTorrentsConfigured() renvoie false et le provider
 * est automatiquement neutralisé.
 */

export const PROWLARR_URL = (process.env.PROWLARR_URL || 'http://localhost:9696').replace(/\/+$/, '');
export const PROWLARR_API_KEY = (process.env.PROWLARR_API_KEY || '').trim();
export const TORRSERVER_URL = (process.env.TORRSERVER_URL || 'http://localhost:8090').replace(/\/+$/, '');
export const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

export function isTorrentsConfigured(): boolean {
  return !!PROWLARR_API_KEY;
}
