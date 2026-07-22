import fs from 'fs';
import path from 'path';

const UPLOADED_PATH = path.join(__dirname, '../../uploaded.json');
const SERIES_OUTPUT_PATH = path.join(__dirname, '../../series-output.json');

function getUploadedFiles(): Record<string, any> {
  const all: Record<string, any> = {};
  if (fs.existsSync(UPLOADED_PATH)) {
    Object.assign(all, JSON.parse(fs.readFileSync(UPLOADED_PATH, 'utf-8')));
  }
  if (fs.existsSync(SERIES_OUTPUT_PATH)) {
    Object.assign(all, JSON.parse(fs.readFileSync(SERIES_OUTPUT_PATH, 'utf-8')));
  }
  return all;
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function findByTitle(title: string, season?: number, episode?: number): { fileCode: string; info: any } | null {
  const uploaded = getUploadedFiles();
  const search = normalize(title);
  console.log(`  normalized search: "${search}"`);

  for (const key of Object.keys(uploaded)) {
    const file = uploaded[key];
    const fileTitle = normalize(file.titre || '');
    if (fileTitle === search || fileTitle.includes(search) || search.includes(fileTitle)) {
      if (season !== undefined && episode !== undefined) {
        console.log(`  matched key "${key}" titre="${file.titre}" fileTitle="${fileTitle}" S${file.season}E${file.episode}`);
        if (file.season === season && file.episode === episode) {
          return { fileCode: file.fileCode, info: file };
        }
        continue;
      }
      if (!file.season && !file.episode) {
        return { fileCode: file.fileCode, info: file };
      }
    }
  }
  return null;
}

console.log("=== Test 1: The Chi - Saison 8, S08E01 ===");
const r1 = findByTitle("The Chi", 8, 1);
console.log("Result:", r1 ? `FOUND: ${r1.fileCode}` : "NOT FOUND");

console.log("\n=== Test 2: The Chi - titre exact ===");
const r2 = findByTitle("The Chi - Saison 8", 8, 1);
console.log("Result:", r2 ? `FOUND: ${r2.fileCode}` : "NOT FOUND");

console.log("\n=== Test 3: Normalize test ===");
console.log(`  "The Chi" → "${normalize("The Chi")}"`);
console.log(`  "The Chi - Saison 8" → "${normalize("The Chi - Saison 8")}"`);
console.log(`  includes? ${normalize("The Chi - Saison 8").includes(normalize("The Chi"))}`);

console.log("\n=== Test 4: Search all keys for 'chi' match ===");
const uploaded = getUploadedFiles();
let chiCount = 0;
for (const key of Object.keys(uploaded)) {
  const file = uploaded[key];
  const fileTitle = normalize(file.titre || '');
  if (fileTitle.includes('chi')) {
    chiCount++;
    if (chiCount <= 3) {
      console.log(`  key="${key}" titre="${file.titre}" season=${file.season} episode=${file.episode}`);
    }
  }
}
console.log(`  Total 'chi' matches: ${chiCount}`);

console.log("\n=== Test 5: Simulate frontend 'getStreamUrl' call ===");
// Frontend passes TMDB title like "The Chi", season 8, episode 1
const queryTitle = "The Chi";
const querySeason = 8;
const queryEpisode = 1;
const r5 = findByTitle(queryTitle, querySeason, queryEpisode);
console.log(`Query: title="${queryTitle}" S${querySeason}E${queryEpisode}`);
console.log("Result:", r5 ? `FOUND: ${r5.fileCode} lien=${r5.info.lien?.slice(0, 50)}...` : "NOT FOUND");
