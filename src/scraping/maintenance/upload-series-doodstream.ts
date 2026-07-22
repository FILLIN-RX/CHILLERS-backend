import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { SERIES_PATH, SERIES_OUTPUT_PATH } from '../../config/data-paths';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const API_KEY = process.env.DOODSTREAM_API_KEY;
const BASE_URL = 'https://doodapi.co/api';

const SAISON_PATTERN = /[Ss]aison\s*(\d+)/;
const EP_PATTERN = /[ÉEé]p\s*[\.:]?\s*(\d+)/;

function parseSeason(titre: string): number {
  const match = titre.match(SAISON_PATTERN);
  return match ? parseInt(match[1], 10) : 1;
}

function parseEpisodeNum(epStr: string): number {
  const match = epStr.match(EP_PATTERN);
  if (match) return parseInt(match[1], 10);
  const num = parseInt(epStr, 10);
  return isNaN(num) ? 1 : num;
}

function normalizeKey(titre: string): string {
  return titre.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function loadOutput(): Record<string, any> {
  if (fs.existsSync(SERIES_OUTPUT_PATH)) {
    return JSON.parse(fs.readFileSync(SERIES_OUTPUT_PATH, 'utf-8'));
  }
  return {};
}

function saveOutput(data: Record<string, any>) {
  fs.writeFileSync(SERIES_OUTPUT_PATH, JSON.stringify(data, null, 2));
}

async function uploadToDoodStream(title: string, directUrl: string) {
  const { data } = await axios.get(`${BASE_URL}/upload/url`, {
    params: { key: API_KEY, url: directUrl, new_title: title },
    timeout: 30000,
  });
  return data;
}

async function main() {
  if (!API_KEY) {
    console.error('[ERROR] DOODSTREAM_API_KEY manquant dans .env');
    process.exit(1);
  }

  if (!fs.existsSync(SERIES_PATH)) {
    console.error(`[ERROR] ${SERIES_PATH} introuvable`);
    process.exit(1);
  }

  const allSeries: any[] = JSON.parse(fs.readFileSync(SERIES_PATH, 'utf-8'));
  const output = loadOutput();

  let totalEpisodes = 0;
  for (const series of allSeries) {
    totalEpisodes += series.episodes?.length || 0;
  }
  console.log(`[UPLOAD] ${allSeries.length} séries, ${totalEpisodes} épisodes dans ${SERIES_PATH}`);
  console.log(`[OUTPUT] ${SERIES_OUTPUT_PATH}\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  const timestamps: number[] = [];
  const RATE_LIMIT = 9;
  const TIME_WINDOW = 1000;

  for (const series of allSeries) {
    const titre = series.titre;
    const season = parseSeason(titre);
    const baseKey = normalizeKey(titre);

    for (const ep of (series.episodes || [])) {
      const episodeNum = parseEpisodeNum(ep.episode);
      const key = `${baseKey}_S${String(season).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
      const label = `${titre} — ${ep.episode}`;

      const existingKey = Object.keys(output).find(k =>
        output[k].titre === titre &&
        output[k].season === season &&
        output[k].episode === episodeNum
      );

      if (existingKey) {
        console.log(`[SKIP] ${label} — déjà uploadé (code: ${output[existingKey].fileCode})`);
        skipped++;
        continue;
      }

      // Rate limiting
      const now = Date.now();
      while (timestamps.length > 0 && timestamps[0] <= now - TIME_WINDOW) {
        timestamps.shift();
      }

      if (timestamps.length >= RATE_LIMIT) {
        const waitTime = timestamps[0] + TIME_WINDOW - now;
        console.log(`[RATE] Limite atteinte, attente de ${Math.round(waitTime)}ms...`);
        await sleep(waitTime);
      }

      const uploadTitle = `${titre} - S${String(season).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
      console.log(`[UPLOAD] ${label}...`);

      try {
        const result = await uploadToDoodStream(uploadTitle, ep.lien);
        timestamps.push(Date.now());

        if (result.status === 200) {
          const fileCode = result.result.filecode;

          output[key] = {
            titre,
            fileCode,
            lien: ep.lien,
            season,
            episode: episodeNum,
            totalSlots: result.total_slots,
            usedSlots: result.used_slots,
            uploadedAt: new Date().toISOString(),
          };
          saveOutput(output);
          console.log(`[OK] ${label} → fileCode: ${fileCode}`);
          success++;
        } else {
          console.error(`[FAIL] ${label} — status ${result.status}: ${result.msg}`);
          failed++;
        }
      } catch (err: any) {
        const msg = err.response?.data?.msg || err.message;
        console.error(`[FAIL] ${label} — ${msg}`);
        failed++;
      }
    }
  }

  console.log(`\n[DONE] ${success} uploadés, ${skipped} déjà faits, ${failed} échoués`);
  console.log(`[FILE] ${SERIES_OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
