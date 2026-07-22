import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface Episode {
  episode: string;
  lien: string;
  season: number;
  episodeNumber: number;
  uqloadCode?: string;
  uqloadLink?: string;
}

interface SerieEntry {
  titre: string;
  tmdbId: number;
  episodes: Episode[];
}

let cached: SerieEntry[] | null = null;

async function ensureConnected() {
  if (mongoose.connection.readyState !== 1) {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27111/chillers';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  }
}

async function loadSeries(): Promise<SerieEntry[]> {
  if (cached) return cached;

  await ensureConnected();

  const db = mongoose.connection.db;
  const series = await db.collection('series')
    .find({
      tmdbId: { $exists: true, $ne: null },
      episodes: { $exists: true, $ne: [] },
    })
    .project({ titre: 1, tmdbId: 1, episodes: 1 })
    .limit(50)
    .toArray();

  const eligible: SerieEntry[] = [];
  for (const s of series) {
    const episodes = (s.episodes || []).filter(
      (ep: any) => ep.lien && ep.lien !== '#' && ep.lien.startsWith('http'),
    );
    if (episodes.length > 0 && s.tmdbId) {
      eligible.push({
        titre: s.titre,
        tmdbId: s.tmdbId,
        episodes,
      });
    }
  }

  cached = eligible;
  return eligible;
}

export async function pickRandomSerie(): Promise<{ titre: string; tmdbId: number; episode: Episode }> {
  const all = await loadSeries();
  const picked = all[Math.floor(Math.random() * all.length)];
  const ep = picked.episodes[Math.floor(Math.random() * picked.episodes.length)];
  return { titre: picked.titre, tmdbId: picked.tmdbId, episode: ep };
}
