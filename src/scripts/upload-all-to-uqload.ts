/**
 * Upload tous les films et épisodes vers Uqload s'ils ont un lien direct
 * et pas encore de uqloadCode.
 *
 * Usage:
 *   npx tsx src/scripts/upload-all-to-uqload.ts [options]
 *
 * Options:
 *   --dry-run        Affiche seulement ce qui serait uploadé.
 *   --limit=N        Nombre max d'items (défaut: infini).
 *   --movies-only    Films uniquement.
 *   --series-only    Séries uniquement.
 *   --concurrency=N  Uploads simultanés (défaut: 3).
 */
import { UqloadClient } from '../modules/uqload/uqload.client';
import Movie from '../models/Movie';
import Serie from '../models/Serie';
import { connectDB } from '../config/db';

interface Args {
  dryRun: boolean;
  limit: number;
  moviesOnly: boolean;
  seriesOnly: boolean;
  concurrency: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const limitArg = argv.find(a => a.startsWith('--limit='));
  const concArg = argv.find(a => a.startsWith('--concurrency='));
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 999999) : 999999,
    moviesOnly: argv.includes('--movies-only'),
    seriesOnly: argv.includes('--series-only'),
    concurrency: concArg ? Math.max(1, parseInt(concArg.split('=')[1], 10) || 3) : 3,
  };
}

function has(val?: string | null): boolean {
  return !!val && val.trim().length > 0;
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function uploadBatch<T>(
  items: T[],
  label: string,
  labelFn: (item: T) => string,
  lienFn: (item: T) => string | undefined | null,
  saveFn: (item: T, uqloadCode: string) => Promise<void>,
  client: UqloadClient,
  args: Args,
) {
  const total = items.length;
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;

  if (total === 0) {
    console.log(`  Aucun ${label} à uploader.`);
    return;
  }

  console.log(`\n${label} — ${total} à traiter`);

  for (const item of items) {
    const name = labelFn(item);
    const lien = lienFn(item);

    if (!lien) {
      skipped++;
      console.log(`  ⏭  ${name}: pas de lien direct`);
      continue;
    }

    if (args.dryRun) {
      console.log(`  ○ ${name} ← ${lien.slice(0, 80)}`);
      uploaded++;
      continue;
    }

    try {
      const fileCode = await client.uploadByUrl(lien, name);
      await saveFn(item, fileCode);
      console.log(`  ✅ ${name} → ${fileCode}`);
      uploaded++;
    } catch (e: any) {
      console.log(`  ❌ ${name}: ${e.message}`);
      failed++;
    }

    // Uqload rate limit: 100 req/min → attendre 800ms entre chaque appel
    await sleep(800);
  }

  console.log(`  ── ${label}: ${uploaded} uploadé(s), ${skipped} ignoré(s), ${failed} échec(s)`);
}

async function main() {
  const apiKey = process.env.UQLOAD_API_KEY;
  if (!apiKey) {
    console.error('UQLOAD_API_KEY non configurée');
    process.exit(1);
  }

  const args = parseArgs();
  await connectDB();
  const client = new UqloadClient(apiKey);

  console.log(`▶ Upload tous les médias vers Uqload${args.dryRun ? ' (dry-run)' : ''}`);
  console.log(`  Concurrence: ${args.concurrency}, limite: ${args.limit === 999999 ? 'aucune' : args.limit}`);

  let processed = 0;

  // ── Films ────────────────────────────────────────
  if (!args.seriesOnly) {
    const movies = await Movie.find({
      $and: [
        { $or: [{ uqloadCode: { $in: [null, ''] } }, { uqloadCode: { $exists: false } }] },
        { lien: { $exists: true, $ne: '' } },
      ],
    }).lean();

    const toUpload = movies.slice(0, args.limit - processed);
    const count = toUpload.length;
    processed += count;

    await uploadBatch(
      toUpload,
      'Films',
      (m: any) => m.titre || 'Sans titre',
      (m: any) => m.lien,
      async (m: any, fileCode) => { await Movie.updateOne({ _id: m._id }, { $set: { uqloadCode: fileCode } }); },
      client,
      args,
    );
  }

  // ── Épisodes de séries ──────────────────────────
  if (!args.moviesOnly) {
    const series = await Serie.find({}).lean();
    const episodes: { serie: any; idx: number; ep: any }[] = [];

    for (const s of series) {
      for (let idx = 0; idx < (s.episodes || []).length; idx++) {
        const ep = s.episodes[idx];
        if (!has(ep.uqloadCode) && !has(ep.uqloadLink) && has(ep.lien)) {
          episodes.push({ serie: s, idx, ep });
        }
      }
    }

    const toUpload = episodes.slice(0, args.limit - processed);
    const count = toUpload.length;
    processed += count;

    await uploadBatch(
      toUpload,
      'Épisodes',
      (e: any) => `${e.serie.titre || 'Série'} - ${e.ep.episode || 'S' + e.ep.season + 'E' + e.ep.episodeNumber || e.idx}`,
      (e: any) => e.ep.lien,
      async (e: any, fileCode: string) => {
        await Serie.updateOne(
          { _id: e.serie._id },
          { $set: { [`episodes.${e.idx}.uqloadCode`]: fileCode } },
        );
      },
      client,
      args,
    );
  }

  console.log(`\n─ Terminé.`);
  if (!args.dryRun && processed > 0) {
    console.log('→ Lance ensuite `npm run upload-uqload:verify` pour résoudre les liens directs Uqload.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
