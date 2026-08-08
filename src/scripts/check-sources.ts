import Movie from '../models/Movie';
import Serie from '../models/Serie';
import { connectDB } from '../config/db';

function has(val?: string | null): boolean {
  return !!val && val.trim().length > 0;
}

async function main() {
  await connectDB();

  console.log('═══════════════════════════════════════');
  console.log('  VÉRIFICATION DES SOURCES VIDÉO');
  console.log('═══════════════════════════════════════\n');

  // ── Films ────────────────────────────────────────
  const totalMovies = await Movie.countDocuments();
  const movies = await Movie.find({}).lean();

  const withUqload = movies.filter(m => has(m.uqloadCode) || has(m.uqloadLink));
  const withStreamtape = movies.filter(m => has(m.streamtapeCode) || has(m.streamtapeLink));
  const withDood = movies.filter(m => has(m.fileCode) || has(m.lien));
  const anySource = movies.filter(m => has(m.uqloadCode) || has(m.uqloadLink) || has(m.streamtapeCode) || has(m.streamtapeLink) || has(m.fileCode) || has(m.lien));
  const noSource = movies.filter(m => !has(m.uqloadCode) && !has(m.uqloadLink) && !has(m.streamtapeCode) && !has(m.streamtapeLink) && !has(m.fileCode) && !has(m.lien));
  const doodWithoutUqload = movies.filter(m => has(m.fileCode) && !has(m.uqloadCode) && !has(m.uqloadLink));
  const uqloadWithoutStreamtape = movies.filter(m => (has(m.uqloadCode) || has(m.uqloadLink)) && !has(m.streamtapeCode) && !has(m.streamtapeLink));
  const uqloadWithStreamtape = movies.filter(m => (has(m.uqloadCode) || has(m.uqloadLink)) && (has(m.streamtapeCode) || has(m.streamtapeLink)));

  console.log('📽  FILMS');
  console.log(`     Total:                     ${totalMovies}`);
  console.log(`     ✅ Avec source:            ${anySource.length}`);
  console.log(`     ❌ Sans aucune source:     ${noSource.length}`);
  console.log(`     ─────────────────────────────────`);
  console.log(`     Uqload:                    ${withUqload.length}`);
  console.log(`     Streamtape:                ${withStreamtape.length}`);
  console.log(`     DoodStream:                ${withDood.length}`);
  console.log(`     ─────────────────────────────────`);
  console.log(`     DoodStream sans Uqload:    ${doodWithoutUqload.length}`);
  console.log(`     Uqload sans Streamtape:    ${uqloadWithoutStreamtape.length}`);
  console.log(`     Uqload + Streamtape:       ${uqloadWithStreamtape.length}`);

  if (uqloadWithoutStreamtape.length > 0) {
    console.log('');
    for (const m of uqloadWithoutStreamtape.slice(0, 20)) {
      console.log(`       ${m.titre}  (uqloadCode: ${m.uqloadCode || '?'})`);
    }
    if (uqloadWithoutStreamtape.length > 20) {
      console.log(`       … et ${uqloadWithoutStreamtape.length - 20} autres`);
    }
  }

  // ── Séries ──────────────────────────────────────
  const totalSeries = await Serie.countDocuments();
  const series = await Serie.find({}).lean();

  let totalEpisodes = 0;
  let epWithUqload = 0;
  let epWithStreamtape = 0;
  let epWithDood = 0;
  let epAnySource = 0;
  let epNoSource = 0;
  let epDoodWithoutUqload = 0;
  let epUqloadWithoutStreamtape = 0;
  let epUqloadWithStreamtape = 0;

  for (const s of series) {
    for (const ep of s.episodes || []) {
      totalEpisodes++;
      const hasUq = has(ep.uqloadCode) || has(ep.uqloadLink);
      const hasSt = has(ep.streamtapeCode) || has(ep.streamtapeLink);
      const hasDood = has(ep.fileCode) || has(ep.lien);

      if (hasUq) epWithUqload++;
      if (hasSt) epWithStreamtape++;
      if (hasDood) epWithDood++;
      if (hasUq || hasSt || hasDood) epAnySource++;
      if (!hasUq && !hasSt && !hasDood) epNoSource++;
      if (hasDood && !hasUq) epDoodWithoutUqload++;
      if (hasUq && !hasSt) epUqloadWithoutStreamtape++;
      if (hasUq && hasSt) epUqloadWithStreamtape++;
    }
  }

  console.log('\n📺  SÉRIES');
  console.log(`     Séries totales:            ${totalSeries}`);
  console.log(`     Épisodes totaux:           ${totalEpisodes}`);
  console.log(`     ✅ Avec source:            ${epAnySource}`);
  console.log(`     ❌ Sans aucune source:     ${epNoSource}`);
  console.log(`     ─────────────────────────────────`);
  console.log(`     Uqload:                    ${epWithUqload}`);
  console.log(`     Streamtape:                ${epWithStreamtape}`);
  console.log(`     DoodStream:                ${epWithDood}`);
  console.log(`     ─────────────────────────────────`);
  console.log(`     DoodStream sans Uqload:    ${epDoodWithoutUqload}`);
  console.log(`     Uqload sans Streamtape:    ${epUqloadWithoutStreamtape}`);
  console.log(`     Uqload + Streamtape:       ${epUqloadWithStreamtape}`);

  // ── Résumé actionable ───────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log('  ACTIONS RECOMMANDÉES');
  console.log('═══════════════════════════════════════');

  if (doodWithoutUqload.length > 0) {
    console.log(`\n  ▶  Lancer la migration DoodStream → Uqload :`);
    console.log(`     npx tsx src/scripts/migrate-dood-to-uqload.ts --limit=${doodWithoutUqload.length}`);
  }
  if (uqloadWithoutStreamtape.length > 0) {
    console.log(`\n  ▶  ${uqloadWithoutStreamtape.length} film(s) Uqload sans Streamtape —`);
    console.log(`     le fallback Streamtape n'est pas encore uploadé pour ces films.`);
  }
  if (noSource.length > 0 || epNoSource > 0) {
    console.log(`\n  ▶  ${noSource.length} film(s) et ${epNoSource} épisode(s) sans aucune source vidéo.`);
    console.log('     Ils doivent être rescrapés ou uploadés manuellement.');
  }

  console.log('\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
