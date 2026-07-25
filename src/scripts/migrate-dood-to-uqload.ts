/**
 * Migration DoodStream → Uqload
 *
 * Parcourt les films et épisodes qui ont une source DoodStream (fileCode ou
 * lien hébergé sur DoodStream) mais PAS encore de source Uqload
 * (`uqloadCode`/`uqloadLink` absents), et lance leur upload distant vers
 * Uqload. On ne stocke que le `uqloadCode` (avec `uqloadLink=null`) : la
 * résolution du lien direct se fait ensuite via `npm run upload-uqload:verify`
 * (le script de vérification existant récupère les items `uqloadCode != null`
 * et `uqloadLink == null`).
 *
 * Usage:
 *   npx tsx src/scripts/migrate-dood-to-uqload.ts [options]
 *
 * Options:
 *   --dry-run        N'upload rien, affiche seulement ce qui serait migré.
 *   --limit=N        Nombre max d'items à traiter (défaut: 100).
 *   --movies-only    Ne traite que les films.
 *   --series-only    Ne traite que les épisodes de séries.
 */
import { UqloadClient } from '../modules/uqload/uqload.client';
import Movie from '../models/Movie';
import Serie from '../models/Serie';
import { connectDB } from '../config/db';
import { getFileDownloadUrl, getDirectDownloadUrl } from '../modules/doodstream/doodstream.service';

const DOODSTREAM_RE =
  /doodstream\.com|dood\.(?:to|sh|so|cx|la|wf|pm)|playmogo\.com|d000d\.com|d0000d\.com/i;
const DOOD_PAGE_RE = /(?:doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\//i;

interface Args {
  dryRun: boolean;
  limit: number;
  moviesOnly: boolean;
  seriesOnly: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const limitArg = argv.find(a => a.startsWith('--limit='));
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 100) : 100,
    moviesOnly: argv.includes('--movies-only'),
    seriesOnly: argv.includes('--series-only'),
  };
}

function hasDoodstream(fileCode?: string | null, lien?: string | null): boolean {
  return !!(fileCode && fileCode.trim()) || (!!lien && DOODSTREAM_RE.test(lien));
}

function hasUqload(uqloadCode?: string | null, uqloadLink?: string | null): boolean {
  return !!(uqloadCode && uqloadCode.trim()) || !!(uqloadLink && uqloadLink.trim());
}

/**
 * Détermine une URL téléchargeable à passer à l'upload distant Uqload.
 * - Si `lien` est déjà un lien direct (pas une page DoodStream /e/ ou /d/), on
 *   l'utilise tel quel.
 * - Sinon, on tente de résoudre une URL directe via l'API DoodStream à partir
 *   du fileCode.
 */
async function resolveSourceUrl(fileCode?: string | null, lien?: string | null): Promise<string | null> {
  if (lien && !DOOD_PAGE_RE.test(lien)) {
    return lien;
  }
  if (fileCode && fileCode.trim()) {
    try {
      const protectedUrl = await getFileDownloadUrl(fileCode);
      if (protectedUrl) return protectedUrl;
    } catch {
      // ignore
    }
    try {
      const directUrl = await getDirectDownloadUrl(fileCode);
      if (directUrl) return directUrl;
    } catch {
      // ignore
    }
  }
  return null;
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

  console.log(
    `▶ Migration DoodStream → Uqload (limit=${args.limit}${args.dryRun ? ', dry-run' : ''})`
  );

  let processed = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  // ── Films ────────────────────────────────────────────────────────────────
  if (!args.seriesOnly) {
    const movies = await Movie.find({
      $and: [
        { $or: [{ uqloadCode: { $in: [null, ''] } }, { uqloadCode: { $exists: false } }] },
        { $or: [{ uqloadLink: { $in: [null, ''] } }, { uqloadLink: { $exists: false } }] },
      ],
    }).lean();

    const candidates = movies.filter(m => hasDoodstream(m.fileCode, m.lien) && !hasUqload(m.uqloadCode, m.uqloadLink));
    console.log(`\n📽  ${candidates.length} film(s) DoodStream sans Uqload`);

    for (const m of candidates) {
      if (processed >= args.limit) break;
      processed++;
      const src = await resolveSourceUrl(m.fileCode, m.lien);
      if (!src) {
        console.log(`  ⏭  ${m.titre}: pas d'URL source exploitable (DoodStream ne fournit pas de lien direct)`);
        skipped++;
        continue;
      }
      if (args.dryRun) {
        console.log(`  ○ ${m.titre} ← ${src.slice(0, 70)}`);
        migrated++;
        continue;
      }
      try {
        const fileCode = await client.uploadByUrl(src, m.titre);
        await Movie.updateOne({ _id: m._id }, { $set: { uqloadCode: fileCode, uqloadLink: null } });
        console.log(`  ✅ ${m.titre} → ${fileCode}`);
        migrated++;
      } catch (e: any) {
        console.log(`  ❌ ${m.titre}: ${e.message}`);
        failed++;
      }
    }
  }

  // ── Épisodes de séries ─────────────────────────────────────────────────────
  if (!args.moviesOnly) {
    const series = await Serie.find({}).lean();
    let candidateCount = 0;
    for (const s of series) {
      for (const ep of s.episodes || []) {
        if (hasDoodstream(ep.fileCode, ep.lien) && !hasUqload(ep.uqloadCode, ep.uqloadLink)) candidateCount++;
      }
    }
    console.log(`\n📺  ${candidateCount} épisode(s) DoodStream sans Uqload`);

    for (const s of series) {
      if (processed >= args.limit) break;
      const episodes = s.episodes || [];
      for (let idx = 0; idx < episodes.length; idx++) {
        if (processed >= args.limit) break;
        const ep = episodes[idx];
        if (!hasDoodstream(ep.fileCode, ep.lien) || hasUqload(ep.uqloadCode, ep.uqloadLink)) continue;
        processed++;
        const label = `${s.titre} - ${ep.episode}`;
        const src = await resolveSourceUrl(ep.fileCode, ep.lien);
        if (!src) {
          console.log(`  ⏭  ${label}: pas d'URL source exploitable`);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          console.log(`  ○ ${label} ← ${src.slice(0, 70)}`);
          migrated++;
          continue;
        }
        try {
          const fileCode = await client.uploadByUrl(src, label);
          await Serie.updateOne(
            { _id: s._id },
            { $set: { [`episodes.${idx}.uqloadCode`]: fileCode, [`episodes.${idx}.uqloadLink`]: null } }
          );
          console.log(`  ✅ ${label} → ${fileCode}`);
          migrated++;
        } catch (e: any) {
          console.log(`  ❌ ${label}: ${e.message}`);
          failed++;
        }
      }
    }
  }

  console.log(
    `\n─ Terminé: ${migrated} ${args.dryRun ? 'à migrer' : 'migré(s)'}, ${skipped} ignoré(s), ${failed} échec(s) sur ${processed} traité(s).`
  );
  if (!args.dryRun && migrated > 0) {
    console.log('→ Lance ensuite `npm run upload-uqload:verify` pour résoudre les liens directs Uqload.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
