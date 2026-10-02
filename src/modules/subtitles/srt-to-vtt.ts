/**
 * srt-to-vtt.ts — conversion SRT → WebVTT.
 *
 * La balise <track> des lecteurs HTML5 (dont Video.js) ne supporte que le
 * WebVTT : on transforme le .srt d'OpenSubtitles en .vtt à la volée.
 */

export function srtToVtt(srt: string): string {
  const cleaned = srt
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const body = cleaned
    .split('\n')
    .map((line) => line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'))
    .join('\n');

  return `WEBVTT\n\n${body.replace(/^\s*(\d+)\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
