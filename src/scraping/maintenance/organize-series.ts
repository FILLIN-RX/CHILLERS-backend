import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { SERIES_OUTPUT_PATH } from '../../config/data-paths';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const API_KEY = process.env.DOODSTREAM_API_KEY;
const BASE_URL = 'https://doodapi.co/api';

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function createFolder(name: string, parentId?: string) {
  const params: Record<string, any> = { key: API_KEY, name };
  if (parentId) params.parent_id = parentId;
  const { data } = await axios.get(`${BASE_URL}/folder/create`, { params, timeout: 15000 });
  return data.result;
}

function assertFldId(fldId: string | null, label: string): string {
  if (!fldId) throw new Error(`Folder ID missing: ${label}`);
  return fldId;
}

async function listFolders(fldId: string = '0') {
  const { data } = await axios.get(`${BASE_URL}/folder/list`, {
    params: { key: API_KEY, fld_id: fldId },
    timeout: 15000,
  });
  return data.result;
}

async function moveFile(fileCode: string, fldId: string) {
  const { data } = await axios.get(`${BASE_URL}/file/move`, {
    params: { key: API_KEY, file_code: fileCode, fld_id: fldId },
    timeout: 15000,
  });
  return data;
}

async function main() {
  if (!API_KEY) {
    console.error('[ERROR] DOODSTREAM_API_KEY manquant dans .env');
    process.exit(1);
  }

  if (!fs.existsSync(SERIES_OUTPUT_PATH)) {
    console.error('[ERROR] series-output.json introuvable');
    process.exit(1);
  }

  const uploaded = JSON.parse(fs.readFileSync(SERIES_OUTPUT_PATH, 'utf-8'));
  const episodes = Object.entries(uploaded).filter(
    ([, v]: [string, any]) => v.season && v.episode && !v.fldId
  );

  console.log(`[ORGANIZE] ${episodes.length} épisodes à organiser...\n`);

  // Find or create _SERIES root
  let rootFldId: string | null = null;
  const rootFolders = await listFolders('0');
  const rootList = rootFolders.folders || [];
  for (const f of rootList) {
    if (f.label === '_SERIES' || f.name === '_SERIES') {
      rootFldId = f.fld_id;
      break;
    }
  }
  if (!rootFldId) {
    console.log('[ROOT] Création du dossier _SERIES...');
    const rootFolder = await createFolder('_SERIES');
    rootFldId = rootFolder.fld_id;
  }
  console.log(`[ROOT] _SERIES → ${rootFldId}\n`);

  let moved = 0;
  let failed = 0;
  const rootId = assertFldId(rootFldId, '_SERIES');

  // Group episodes by titre
  const grouped: Record<string, any[]> = {};
  for (const [, info] of episodes as [string, any][]) {
    const key = info.titre || 'unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(info);
  }

  for (const [titre, eps] of Object.entries(grouped)) {
    const baseTitle = titre.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    const tmdbId = eps.find(e => e.tmdbId)?.tmdbId;
    const seriesFolderName = tmdbId ? `${tmdbId}-${baseTitle}` : baseTitle;

    // Find or create series folder (once per series)
    let seriesFldId: string | null = null;
    const seriesFoldersData = await listFolders(rootId);
    const seriesFolders = seriesFoldersData.folders || [];
    for (const f of seriesFolders) {
      if (f.label === seriesFolderName || f.name === seriesFolderName) {
        seriesFldId = f.fld_id;
        break;
      }
    }
    if (!seriesFldId) {
      const seriesFolder = await createFolder(seriesFolderName, rootId);
      seriesFldId = seriesFolder.fld_id;
      console.log(`[SERIES] ${seriesFolderName} → ${seriesFldId}`);
    }

    const seriesId = assertFldId(seriesFldId, seriesFolderName);

    // Group by season within this series
    const bySeason: Record<number, any[]> = {};
    for (const ep of eps) {
      const s = ep.season || 1;
      if (!bySeason[s]) bySeason[s] = [];
      bySeason[s].push(ep);
    }

    for (const [seasonNum, seasonEps] of Object.entries(bySeason)) {
      const seasonFolderName = `Season ${seasonNum}`;

      // Find or create season folder (once per season)
      let seasonFldId: string | null = null;
      const seasonFoldersData = await listFolders(seriesId);
      const seasonFolders = seasonFoldersData.folders || [];
      for (const f of seasonFolders) {
        if (f.label === seasonFolderName || f.name === seasonFolderName) {
          seasonFldId = f.fld_id;
          break;
        }
      }
      if (!seasonFldId) {
        const seasonFolder = await createFolder(seasonFolderName, seriesId);
        seasonFldId = seasonFolder.fld_id;
        console.log(`[SEASON] ${seriesFolderName}/${seasonFolderName} → ${seasonFldId}`);
      }

      const seasonId = assertFldId(seasonFldId, `${seriesFolderName}/${seasonFolderName}`);

      // Move all episodes of this season
      for (const ep of seasonEps) {
        try {
          await moveFile(ep.fileCode, seasonId);
          ep.fldId = seasonId;
          console.log(`  [MOVE] ${titre} S${ep.season}E${ep.episode}`);
          moved++;
        } catch (err: any) {
          const msg = err.response?.data?.msg || err.message;
          console.error(`  [FAIL] ${titre} S${ep.season}E${ep.episode} — ${msg}`);
          failed++;
        }
        await sleep(250);
      }
    }
  }

  fs.writeFileSync(SERIES_OUTPUT_PATH, JSON.stringify(uploaded, null, 2));
  console.log(`\n[DONE] ${moved} déplacés, ${failed} échoués`);
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
