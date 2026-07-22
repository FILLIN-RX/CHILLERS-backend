import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import fs from 'fs';
import tmdbClient from '../../config/tmdb';
import { connectDB } from '../../config/db';
import Movie from '../../models/Movie';

const ERROR_LOG_PATH = path.join(__dirname, '../../tmdb-movie-link-errors.log');

function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a).split(' ').filter(w => w.length > 1));
  const wordsB = new Set(normalize(b).split(' ').filter(w => w.length > 1));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  let intersect = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersect++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersect / union;
}

async function searchTmdbMovie(query: string, year?: number | null): Promise<any[]> {
  try {
    const params: Record<string, any> = { query, page: 1 };
    if (year) params.year = year;
    const { data } = await tmdbClient.get('/search/movie', { params });
    return data.results || [];
  } catch (err: any) {
    console.error(`[TMDB] Search error for "${query}":`, err.message);
    return [];
  }
}

async function main() {
  await connectDB();

  const toLink = await Movie.find({ tmdbId: { $exists: false } })
    .select('titre lien tmdbId createdAt')
    .lean();

  if (toLink.length === 0) {
    console.log('Aucun film à lier (tous ont déjà un tmdbId).');
    return;
  }

  console.log(`${toLink.length} films sans TMDB à traiter\n`);

  let linked = 0;
  let failed = 0;
  const errors: string[] = [];
  const total = toLink.length;

  for (let idx = 0; idx < total; idx++) {
    const movie = toLink[idx];
    const title = movie.titre;

    console.log(`[${idx + 1}/${total}] "${title}"`);

    const results = await searchTmdbMovie(title);
    if (results.length === 0) {
      errors.push(`[SEARCH] No TMDB results for "${title}"`);
      failed++;
      continue;
    }

    let matched = false;
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const candidate = results[i];
      const candidateTitle = candidate.title || candidate.name || '';
      const candidateYear = candidate.release_date
        ? new Date(candidate.release_date).getFullYear()
        : null;

      console.log(`  Candidat ${i + 1}: "${candidateTitle}" (id: ${candidate.id})`);

      const sim = nameSimilarity(title, candidateTitle);
      if (sim < 0.3) {
        console.log(`    ❌ Similarité: ${sim.toFixed(2)} — ignoré`);
        continue;
      }
      console.log(`    ✅ Similarité: ${sim.toFixed(2)}`);

      if (sim >= 0.5 || (sim >= 0.3 && i === 0)) {
        console.log(`    ✅ LIEN RÉUSSI → tmdbId=${candidate.id}`);
        await Movie.updateOne({ _id: movie._id }, { $set: { tmdbId: candidate.id } });
        linked++;
        matched = true;
        break;
      }
    }

    if (!matched) {
      errors.push(`[NO MATCH] "${title}" — aucun candidat TMDB valide`);
      failed++;
    }
  }

  console.log(`\n=== RÉSULTAT ===`);
  console.log(`✅ Liés: ${linked}`);
  console.log(`❌ Échecs: ${failed}`);
  console.log(`📊 Total traités: ${total}`);

  if (errors.length > 0) {
    const logContent = errors.join('\n') + '\n';
    fs.appendFileSync(ERROR_LOG_PATH, logContent + '\n', 'utf-8');
    console.log(`\nErreurs logguées dans tmdb-movie-link-errors.log`);
  }
}

main().catch(err => console.error('[FATAL]', err));
