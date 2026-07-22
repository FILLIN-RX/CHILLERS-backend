import fs from 'fs';
import path from 'path';

const UPLOADED_PATH = path.join(__dirname, '../../src/scraping/core/uploaded.json');

interface UploadEntry {
  titre: string;
  fileCode: string;
  lien: string;
  tmdbId?: number;
  year?: number | null;
}

const ASCII_TITLE_RE = /^[A-Za-z0-9 :.\-']+$/;

function loadEntries(): UploadEntry[] {
  const raw = JSON.parse(fs.readFileSync(UPLOADED_PATH, 'utf-8'));
  return Object.values(raw) as UploadEntry[];
}

function isAsciiSimple(title: string): boolean {
  return ASCII_TITLE_RE.test(title) && title.length > 1;
}

export function pickRandomUploadedFilm(): { title: string; tmdbId: number } {
  const all = loadEntries();

  const eligible = all
    .filter((e) => e.tmdbId && e.lien && isAsciiSimple(e.titre))
    .slice(0, 50);

  if (eligible.length === 0) {
    throw new Error('No eligible film found in uploaded.json (first 50)');
  }

  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  return { title: picked.titre, tmdbId: picked.tmdbId! };
}
