import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const API_KEY = process.env.DOODSTREAM_API_KEY;
const BASE_URL = 'https://doodapi.co/api';
const UPLOADED_PATH = path.join(__dirname, '../../uploaded.json');

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!API_KEY) {
    console.error('[ERROR] DOODSTREAM_API_KEY manquant dans .env');
    process.exit(1);
  }

  if (!fs.existsSync(UPLOADED_PATH)) {
    console.error('[ERROR] uploaded.json introuvable — lance d\'abord upload-doodstream.ts');
    process.exit(1);
  }

  const uploaded = JSON.parse(fs.readFileSync(UPLOADED_PATH, 'utf-8'));
  const entries = Object.entries(uploaded);
  console.log(`[STATUS] Vérification de ${entries.length} fichiers...\n`);

  let ready = 0;
  let processing = 0;
  let error = 0;

  for (const [key, info] of entries as [string, any][]) {
    try {
      const { data } = await axios.get(`${BASE_URL}/file/check`, {
        params: { key: API_KEY, file_code: info.fileCode },
        timeout: 15000,
      });

      const status = data.result?.[0]?.status || 'unknown';
      const icon = status === 'Active' ? '✅' : status === 'processing' ? '⏳' : '❌';

      if (status === 'Active') {
        ready++;
        // Récupérer les infos embed/download si pas déjà fait
        if (!info.embedUrl) {
          const { data: infoData } = await axios.get(`${BASE_URL}/file/info`, {
            params: { key: API_KEY, file_code: info.fileCode },
            timeout: 15000,
          });
          const fileInfo = infoData.result?.[0];
          if (fileInfo) {
            info.embedUrl = `https://doodstream.com/e/${fileInfo.protected_embed}`;
            info.downloadUrl = `https://doodstream.com/d/${fileInfo.protected_dl}`;
            info.thumbnail = fileInfo.splash_img;
            info.duration = fileInfo.length;
            info.size = fileInfo.size;
          }
        }
      } else {
        processing++;
      }

      console.log(`${icon} ${info.titre} → ${status}`);
    } catch (err: any) {
      error++;
      const msg = err.response?.data?.msg || err.message;
      console.log(`❌ ${info.titre} → ERREUR: ${msg}`);
    }

    await sleep(200);
  }

  fs.writeFileSync(UPLOADED_PATH, JSON.stringify(uploaded, null, 2));

  console.log(`\n[RÉSUMÉ] ${ready} actifs, ${processing} en cours, ${error} erreurs`);
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
