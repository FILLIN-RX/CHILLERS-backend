import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from '../../config/db';
import Movie from '../../models/Movie';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const API_KEY = process.env.DOODSTREAM_API_KEY;
const BASE_URL = 'https://doodapi.co/api';
const FOLDER_ID = '0';

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function uploadToDoodStream(title: string, directUrl: string) {
  const params: Record<string, string> = {
    key: API_KEY!,
    url: directUrl,
    new_title: title,
  };
  if (FOLDER_ID !== '0') params.fld_id = FOLDER_ID;

  const { data } = await axios.get(`${BASE_URL}/upload/url`, { params, timeout: 30000 });
  return data;
}

async function main() {
  if (!API_KEY) {
    console.error('[ERROR] DOODSTREAM_API_KEY manquant dans .env');
    process.exit(1);
  }

  await connectDB();

  // On cherche les films qui n'ont pas encore de 'fileCode' dans la DB
  const films = await Movie.find({ fileCode: { $exists: false } });

  console.log(`[UPLOAD] ${films.length} films à traiter.`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  const timestamps: number[] = [];
  const RATE_LIMIT = 9;
  const TIME_WINDOW = 1000;

  for (const film of films) {
    console.log(`[UPLOAD] ${film.titre}...`);

    // Rate limiting
    const now = Date.now();
    while (timestamps.length > 0 && timestamps[0] <= now - TIME_WINDOW) {
      timestamps.shift();
    }
    if (timestamps.length >= RATE_LIMIT) {
      await sleep(timestamps[0] + TIME_WINDOW - now);
    }

    try {
      const result = await uploadToDoodStream(film.titre, film.lien);
      timestamps.push(Date.now());

      if (result.status === 200) {
        const fileCode = result.result.filecode;
        const doodUrl = `https://doodstream.com/e/${fileCode}`;

        // Mise à jour MongoDB
        const update: any = { lien: doodUrl, fileCode, uploadedAt: new Date() };
        if (!film.lienOriginal) update.lienOriginal = film.lien;
        await Movie.updateOne({ _id: film._id }, { $set: update });

        console.log(`[OK] ${film.titre} → ${doodUrl}`);
        success++;
      } else {
        console.error(`[FAIL] ${film.titre} — status ${result.status}: ${result.msg}`);
        failed++;
      }
    } catch (err: any) {
      const msg = err.response?.data?.msg || err.message;
      console.error(`[FAIL] ${film.titre} — ${msg}`);
      failed++;
    }
  }

  console.log(`\n[DONE] ${success} uploadés, ${failed} échoués`);
  process.exit(0);
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
