import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from '../../config/db';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import DeadLink from '../../models/DeadLink';
import { isLinkDead } from '../core/link-checker';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const CONCURRENCY = 10;

interface LinkEntry {
  titre: string;
  episode: string;
  lien: string;
  type: 'movie' | 'series';
}

async function checkWithConcurrency(entries: LinkEntry[]): Promise<LinkEntry[]> {
  const dead: LinkEntry[] = [];
  let completed = 0;
  const total = entries.length;

  const run = async (i: number) => {
    if (i >= entries.length) return;
    const entry = entries[i];
    try {
      if (await isLinkDead(entry.lien)) {
        dead.push(entry);
      }
    } catch {
      dead.push(entry);
    }
    completed++;
    if (completed % 50 === 0 || completed === total) {
      console.log(`[CheckLinks] ${completed}/${total} vérifiés`);
    }
    await run(i + CONCURRENCY);
  };

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => run(i));
  await Promise.all(workers);
  return dead;
}

async function main() {
  console.log('[CheckLinks] Démarrage de la vérification de tous les liens...');
  await connectDB();

  const movies = await Movie.find({ lien: { $nin: ['#', null, ''] } })
    .select('titre lien')
    .lean();
  const series = await Serie.find({ 'episodes.lien': { $nin: ['#', null, ''] } })
    .select('titre episodes')
    .lean();

  const movieEntries: LinkEntry[] = movies.map(m => ({
    titre: m.titre,
    episode: 'Film',
    lien: m.lien,
    type: 'movie' as const,
  }));

  const seriesEntries: LinkEntry[] = [];
  for (const s of series) {
    for (const ep of s.episodes || []) {
      if (ep.lien && ep.lien !== '#') {
        seriesEntries.push({
          titre: s.titre,
          episode: ep.episode,
          lien: ep.lien,
          type: 'series' as const,
        });
      }
    }
  }

  const allEntries = [...movieEntries, ...seriesEntries];
  console.log(`[CheckLinks] ${movies.length} films, ${series.length} séries (${seriesEntries.length} épisodes) — total ${allEntries.length} liens`);

  const deadEntries = await checkWithConcurrency(allEntries);
  console.log(`[CheckLinks] ${deadEntries.length} liens morts détectés`);

  await DeadLink.deleteMany({});
  if (deadEntries.length > 0) {
    await DeadLink.insertMany(
      deadEntries.map(e => ({ ...e, lastChecked: new Date() }))
    );
  }

  console.log(`[CheckLinks] Terminé. ${deadEntries.length} liens morts enregistrés.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[CheckLinks] FATAL:', err);
  process.exit(1);
});
