/**
 * Script CLI : liste les fichiers Uqload inactifs depuis plus de N jours.
 *
 * Usage:
 *   npx tsx src/scripts/check-uqload-inactive.ts            (inactif > 50 jours)
 *   npx tsx src/scripts/check-uqload-inactive.ts --days=60  (inactif > 60 jours)
 *   npx tsx src/scripts/check-uqload-inactive.ts --json     (sortie JSON)
 *   npx tsx src/scripts/check-uqload-inactive.ts --watch    (comparaison avec la run précédente)
 */
import { UqloadClient } from '../modules/uqload/uqload.client';
import { UqloadInactiveScanner } from '../modules/uqload/uqload.inactive';

function parseArgs() {
  const argv = process.argv.slice(2);
  const daysArg = argv.find(a => a.startsWith('--days='));
  return {
    days: daysArg ? parseInt(daysArg.split('=')[1], 10) : 50,
    json: argv.includes('--json'),
    watch: argv.includes('--watch'),
  };
}

async function main() {
  const apiKey = process.env.UQLOAD_API_KEY;
  if (!apiKey) {
    console.error('UQLOAD_API_KEY non configurée');
    process.exit(1);
  }

  const { days, json, watch } = parseArgs();
  const client = new UqloadClient(apiKey);
  const scanner = new UqloadInactiveScanner(client);

  console.log(`▶ Scan des fichiers Uqload inactifs depuis > ${days} jours...\n`);

  const inactive = await scanner.findInactive(days);

  if (json) {
    console.log(JSON.stringify(inactive, null, 2));
  } else if (inactive.length === 0) {
    console.log('✅ Aucun fichier inactif trouvé.');
  } else {
    console.log(`⚠️  ${inactive.length} fichier(s) inactif(s) depuis > ${days} jours :`);
    for (const f of inactive) {
      console.log(
        `  • [${f.fileCode}] ${f.title || '(sans titre)'} — inactif ${f.inactiveDays}j ` +
        `(views=${f.views}, dernier DL: ${f.lastDownload || 'jamais'})`
      );
    }
    console.log(`\n→ Uqload supprime les fichiers inactifs depuis ${60} jours.`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
