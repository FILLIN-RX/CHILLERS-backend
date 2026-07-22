import { UqloadClient } from '../modules/uqload/uqload.client';
import Movie from '../models/Movie';
import Serie from '../models/Serie';
import { connectDB } from '../config/db';

const BATCH = 100;

async function main() {
  const apiKey = process.env.UQLOAD_API_KEY;
  if (!apiKey) {
    console.error('UQLOAD_API_KEY non configurée');
    process.exit(1);
  }

  await connectDB();
  const client = new UqloadClient(apiKey);
  const mode = process.argv.includes('--verify') ? 'verify' : 'upload';

  if (mode === 'verify') {
    await verifyPending(client);
  } else {
    await uploadPending(client);
  }

  process.exit(0);
}

async function uploadPending(client: UqloadClient) {
  const movies = await Movie.find({
    uqloadCode: { $exists: false },
    $or: [{ fileCode: { $exists: false } }, { fileCode: null }],
  })
    .limit(BATCH)
    .lean();

  if (movies.length > 0) {
    console.log(`\n📽 Upload de ${movies.length} films vers Uqload (async)...`);
    for (const m of movies) {
      try {
        const fileCode = await client.uploadByUrlAsync(m.lien, m.titre);
        await Movie.updateOne({ _id: m._id }, { $set: { uqloadCode: fileCode, uqloadLink: null } });
        console.log(`  ✅ ${m.titre} → ${fileCode}`);
      } catch (e: any) {
        console.log(`  ❌ ${m.titre}: ${e.message}`);
      }
    }
  } else {
    console.log('📽 Aucun film à uploader');
  }

  const series = await Serie.find({ 'episodes.uqloadCode': { $exists: false }, 'episodes.fileCode': { $exists: false } })
    .limit(BATCH)
    .lean();

  let epCount = 0;
  for (const s of series) {
    for (const ep of s.episodes || []) {
      if (!ep.uqloadCode && !ep.fileCode) epCount++;
    }
  }

  if (epCount > 0) {
    console.log(`\n📺 Upload de ${Math.min(epCount, BATCH)} épisodes vers Uqload (async)...`);
    let done = 0;
    for (const s of series) {
      for (let idx = 0; idx < (s.episodes || []).length; idx++) {
        if (done >= BATCH) break;
        const ep = s.episodes[idx];
        if (ep.uqloadCode || ep.fileCode) continue;
        try {
          const label = `${s.titre} - ${ep.episode}`;
          const fileCode = await client.uploadByUrlAsync(ep.lien, label);
          await Serie.updateOne(
            { _id: s._id },
            { $set: { [`episodes.${idx}.uqloadCode`]: fileCode, [`episodes.${idx}.uqloadLink`]: null } }
          );
          console.log(`  ✅ ${label} → ${fileCode}`);
          done++;
        } catch (e: any) {
          console.log(`  ❌ ${s.titre} ${ep.episode}: ${e.message}`);
        }
      }
    }
  } else {
    console.log('📺 Aucun épisode à uploader');
  }
}

async function verifyPending(client: UqloadClient) {
  const movies = await Movie.find({ uqloadCode: { $ne: null }, uqloadLink: null })
    .limit(BATCH)
    .lean();

  if (movies.length > 0) {
    console.log(`\n📽 Vérification de ${movies.length} films...`);
    for (const m of movies) {
      if (!m.uqloadCode) continue;
      try {
        const info = await client.getFileInfo(m.uqloadCode);
        if (info.result?.[0]?.status === 200) {
          const dl = await client.getDirectLink(m.uqloadCode);
          const best = dl.result?.versions?.find((v: any) => v.name === 'n') || dl.result?.versions?.[0];
          await Movie.updateOne(
            { _id: m._id },
            {
              $set: {
                uqloadLink: best?.url || null,
                uqloadQualities: dl.result?.versions || [],
                uqloadHls: dl.result?.hls_direct || null,
              },
            }
          );
          console.log(`  ✅ ${m.titre} → lien prêt`);
        } else {
          console.log(`  ⏳ ${m.titre} toujours en traitement`);
        }
      } catch {
        console.log(`  ⏳ ${m.titre} vérification échouée (réessayer plus tard)`);
      }
    }
  } else {
    console.log('📽 Aucun film en attente de vérification');
  }

  const series = await Serie.find({ 'episodes.uqloadCode': { $ne: null }, 'episodes.uqloadLink': null })
    .limit(BATCH)
    .lean();

  let epCount = 0;
  for (const s of series) {
    for (const ep of s.episodes || []) {
      if (ep.uqloadCode && !ep.uqloadLink) epCount++;
    }
  }

  if (epCount > 0) {
    console.log(`\n📺 Vérification de ${Math.min(epCount, BATCH)} épisodes...`);
    let done = 0;
    for (const s of series) {
      for (let idx = 0; idx < (s.episodes || []).length; idx++) {
        if (done >= BATCH) break;
        const ep = s.episodes[idx];
        if (!ep.uqloadCode || ep.uqloadLink) continue;
        try {
          const info = await client.getFileInfo(ep.uqloadCode);
          if (info.result?.[0]?.status === 200) {
            const dl = await client.getDirectLink(ep.uqloadCode);
            const best = dl.result?.versions?.find((v: any) => v.name === 'n') || dl.result?.versions?.[0];
            await Serie.updateOne(
              { _id: s._id },
              {
                $set: {
                  [`episodes.${idx}.uqloadLink`]: best?.url || null,
                },
              }
            );
            console.log(`  ✅ ${s.titre} ${ep.episode} → lien prêt`);
            done++;
          } else {
            console.log(`  ⏳ ${s.titre} ${ep.episode} toujours en traitement`);
          }
        } catch {
          console.log(`  ⏳ ${s.titre} ${ep.episode} vérification échouée`);
        }
      }
    }
  } else {
    console.log('📺 Aucun épisode en attente de vérification');
  }
}

main().catch(console.error);
