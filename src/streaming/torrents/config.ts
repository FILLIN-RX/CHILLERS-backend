// @ts-nocheck
export const PROWLARR_URL = (process.env.PROWLARR_URL || 'http://localhost:9696').replace(/\/+$/, '');
export const PROWLARR_API_KEY = (process.env.PROWLARR_API_KEY || '').trim();
export const TORRSERVER_URL = (process.env.TORRSERVER_URL || 'http://localhost:8090').replace(/\/+$/, '');
export const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
export function isTorrentsConfigured() {
    return !!exports.PROWLARR_API_KEY;
}
