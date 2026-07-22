// Backfill script: pour chaque épisode qui a un `uqloadCode` mais pas de
// `uqloadLink`, on appelle l'API Uqload /file/direct_link pour récupérer
// l'URL directe et on persiste. Lancé manuellement après le fix de
// reupload.ts (les anciens uploads n'ont pas reçu le uqloadLink parce
// qu'on lisait le mauvais champ dans le payload).

import "dotenv/config";
import mongoose from "mongoose";
import { UqloadClient } from "../src/modules/uqload/uqload.client";
import Serie from "../src/models/Serie";

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);

  const uqloadKey = process.env.UQLOAD_API_KEY;
  if (!uqloadKey) {
    console.error("[Backfill] UQLOAD_API_KEY manquant — abort");
    process.exit(1);
  }
  const uqload = new UqloadClient(uqloadKey);

  // Trouve tous les épisodes qui ont un uqloadCode mais pas de uqloadLink.
  // (Note: MongoDB ne sait pas indexer sur "champ existe mais est vide"
  // directement — on filtre en mémoire après le fetch.)
  const cursor = Serie.find({
    "episodes.uqloadCode": { $exists: true, $ne: null },
  })
    .select("titre episodes")
    .lean()
    .cursor();

  let total = 0;
  let updated = 0;
  let failed = 0;

  for await (const serie of cursor) {
    const updates: Array<Record<string, any>> = [];
    for (let i = 0; i < (serie.episodes || []).length; i++) {
      const ep = serie.episodes[i];
      if (!ep.uqloadCode) continue;
      if (ep.uqloadLink) continue; // déjà bon

      total++;
      try {
        const res = await uqload.getDirectLink(ep.uqloadCode);
        const versions = (res.result as any)?.versions as
          | Array<{ url: string; name: string }>
          | undefined;
        const best = versions?.find((v) => v.name === "n") ?? versions?.[0];
        const direct = best?.url ?? (res.result as any)?.hls_direct;
        if (!direct) {
          failed++;
          console.log(
            `[Backfill] ${serie.titre} ${ep.episode}: pas de versions`,
          );
          continue;
        }
        updates.push({
          index: i,
          filter: { season: ep.season, episodeNumber: ep.episodeNumber },
          link: direct,
        });
      } catch (e: any) {
        failed++;
        console.log(
          `[Backfill] ${serie.titre} ${ep.episode}: ${e.message}`,
        );
      }
    }

    // Persist par update atomique pour éviter de marcher sur les updates
    // concurrents du mainteneur / scraper.
    for (const u of updates) {
      const r = await Serie.updateOne(
        {
          _id: serie._id,
          "episodes.season": u.filter.season,
          "episodes.episodeNumber": u.filter.episodeNumber,
        },
        { $set: { "episodes.$.uqloadLink": u.link } },
      );
      if (r.matchedCount > 0) updated++;
      else
        console.log(
          `[Backfill] ⚠ Pas de match pour ${serie.titre} S${u.filter.season}E${u.filter.episodeNumber}`,
        );
    }
  }

  console.log(
    `[Backfill] Terminé. total=${total} updated=${updated} failed=${failed}`,
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
