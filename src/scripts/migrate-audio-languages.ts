import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import Movie from '../models/Movie';
import Serie from '../models/Serie';
import { detectAudioLanguage } from '../utils/audio-language';

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function runMigration() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ ERREUR: MONGO_URI introuvable dans .env");
    process.exit(1);
  }

  console.log("🔌 Connexion à MongoDB...");
  await mongoose.connect(uri);
  console.log("✅ Connecté.");

  console.log("\n📦 Démarrage de la mise à jour ultra-rapide des langues audio (VF / VOSTFR / VO)...");

  // 1. MIGRATION DES FILMS
  const totalMovies = await Movie.countDocuments();
  console.log(`\n🎬 Traitement de ${totalMovies} films...`);

  const statsMovie: Record<string, number> = {};
  const movieCursor = Movie.find({}).select('titre pageUrl lien lienOriginal uqloadLink').lean().cursor();

  let movieBulkOps: any[] = [];
  let processedMovies = 0;

  for await (const m of movieCursor) {
    const res = detectAudioLanguage(m as any);
    statsMovie[res.langueAudio] = (statsMovie[res.langueAudio] || 0) + 1;

    movieBulkOps.push({
      updateOne: {
        filter: { _id: m._id },
        update: { $set: { langueAudio: res.langueAudio } },
      },
    });

    if (movieBulkOps.length >= 1000) {
      await Movie.bulkWrite(movieBulkOps);
      processedMovies += movieBulkOps.length;
      process.stdout.write(`\r   Films traités : ${processedMovies}/${totalMovies}`);
      movieBulkOps = [];
    }
  }

  if (movieBulkOps.length > 0) {
    await Movie.bulkWrite(movieBulkOps);
    processedMovies += movieBulkOps.length;
    process.stdout.write(`\r   Films traités : ${processedMovies}/${totalMovies}\n`);
  }

  console.log("\n📊 Statistiques des films :");
  console.table(statsMovie);

  // 2. MIGRATION DES SÉRIES
  const totalSeries = await Serie.countDocuments();
  console.log(`\n📺 Traitement de ${totalSeries} séries...`);

  const statsSerie: Record<string, number> = {};
  const serieCursor = Serie.find({}).lean().cursor();

  let serieBulkOps: any[] = [];
  let processedSeries = 0;

  for await (const s of serieCursor) {
    const res = detectAudioLanguage(s as any);
    statsSerie[res.langueAudio] = (statsSerie[res.langueAudio] || 0) + 1;

    const episodes = Array.isArray(s.episodes) ? s.episodes.map((ep: any) => {
      const epRes = detectAudioLanguage({
        lien: ep.lien,
        titre: s.titre,
        pageUrl: s.pageUrl,
        uqloadLink: ep.uqloadLink
      });
      return { ...ep, langueAudio: epRes.langueAudio };
    }) : [];

    serieBulkOps.push({
      updateOne: {
        filter: { _id: s._id },
        update: { $set: { langueAudio: res.langueAudio, episodes } },
      },
    });

    if (serieBulkOps.length >= 500) {
      await Serie.bulkWrite(serieBulkOps);
      processedSeries += serieBulkOps.length;
      process.stdout.write(`\r   Séries traitées : ${processedSeries}/${totalSeries}`);
      serieBulkOps = [];
    }
  }

  if (serieBulkOps.length > 0) {
    await Serie.bulkWrite(serieBulkOps);
    processedSeries += serieBulkOps.length;
    process.stdout.write(`\r   Séries traitées : ${processedSeries}/${totalSeries}\n`);
  }

  console.log("\n📊 Statistiques des séries :");
  console.table(statsSerie);

  console.log("\n✅ Migration terminée avec succès !");
  await mongoose.disconnect();
}

runMigration().catch((err) => {
  console.error("❌ Erreur pendant la migration :", err);
  process.exit(1);
});
