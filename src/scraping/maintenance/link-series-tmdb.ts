import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import fs from 'fs';
import tmdbClient from '../../config/tmdb';
import { connectDB } from '../../config/db';
import Serie from '../../models/Serie';

const ERROR_LOG_PATH = path.join(__dirname, '../../tmdb-link-errors.log');

function parseTitre(titre: string): { seriesName: string; season: number } | null {
  const match = titre.match(/^(.*?)\s*[-–—:]\s*(?:Saison|Season)\s*(\d+)/i);
  if (!match) return null;
  return { seriesName: match[1].trim(), season: parseInt(match[2], 10) };
}

function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a).split(' ').filter(w => w.length > 1));
  const wordsB = new Set(normalize(b).split(' ').filter(w => w.length > 1));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  let intersect = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersect++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersect / union;
}

function extractEpisodeTitleFromFilename(filename: string): string | null {
  const cleaned = filename
    .replace(/\.(?:mkv|mp4|avi|mov)$/i, '')
    .replace(/\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?$/g, '')
    .replace(/\.(?:1080p|720p|480p|2160p|WEB|BLURAY|BRRiP|WEBRiP|HDTV|x264|x265|H264|H265|MULTi|VFF|VOSTFR|FRENCH|TRUEFRENCH|SUPPLY|TyHD|GL0P|d4kid|AMZN|NF|iT|iTA|iNTERNAL|PROPER|REPACK)\..*/gi, '')
    .replace(/[._]/g, ' ')
    .trim();

  const seMatch = cleaned.match(/[sS]\d+[eE]\d+\s+(.+)/);
  if (seMatch) {
    const title = seMatch[1].trim();
    if (title && !/^(?:episode|épisode|ep)\s*\d+$/i.test(title) && title.length > 2) {
      return title;
    }
  }

  return null;
}

async function searchTmdb(query: string): Promise<any[]> {
  try {
    const { data } = await tmdbClient.get('/search/tv', {
      params: { query, page: 1 },
    });
    return data.results || [];
  } catch (err: any) {
    console.error(`[TMDB] Search error for "${query}":`, err.message);
    return [];
  }
}

async function getTvDetails(tmdbId: number): Promise<any | null> {
  try {
    const { data } = await tmdbClient.get(`/tv/${tmdbId}`);
    return data;
  } catch {
    return null;
  }
}

async function getSeasonDetails(tmdbId: number, seasonNumber: number): Promise<any | null> {
  try {
    const { data } = await tmdbClient.get(`/tv/${tmdbId}/season/${seasonNumber}`);
    return data;
  } catch {
    return null;
  }
}

/**
 * Lie une série MongoDB à son ID TMDB. Utilisable depuis un save-site (auto-link)
 * ou depuis le batch main(). Ne lève jamais — retourne un statut structuré.
 *
 * Stratégie de match (du plus précis au plus relâché) :
 *   1) Similarité de titre ≥ 0.5 OU (similarité ≥ 0.3 ET candidat #0)
 *   2) Saison existe dans TMDB
 *   3) Au moins un match de titre d'épisode entre upload et TMDB
 *   4) Nombre exact d'épisodes entre upload et TMDB
 *   5) uploaded ≤ tmdb ET chevauchement sur au moins un numéro d'épisode
 */
export async function linkSeriesTmdb(serieId: string): Promise<{ ok: boolean; tmdbId?: number; reason?: string }> {
  try {
    const serie: any = await Serie.findById(serieId).select('titre episodes tmdbId').lean();
    if (!serie) return { ok: false, reason: 'not_found' };
    if (serie.tmdbId) return { ok: true, tmdbId: serie.tmdbId };

    const parsed = parseTitre(serie.titre);
    if (!parsed) return { ok: false, reason: 'unparseable_titre' };

    const { seriesName, season } = parsed;

    // Reconstituer le "groupe" : pour une Serie unique, c'est juste cette série.
    const group = {
      entries: [serie],
      season,
      maxEpisode: serie.episodes.length > 0
        ? Math.max(...serie.episodes.map((e: any) => e.episodeNumber ?? 0), 0)
        : 0,
    };
    const uploadedCount = group.maxEpisode;

    const results = await searchTmdb(seriesName);
    if (results.length === 0) return { ok: false, reason: 'no_tmdb_results' };

    for (let i = 0; i < Math.min(3, results.length); i++) {
      const candidate = results[i];
      const sim = nameSimilarity(seriesName, candidate.name || '');
      if (sim < 0.3) continue;
      if (sim < 0.5 && i !== 0) continue;

      const details = await getTvDetails(candidate.id);
      if (!details) continue;

      const seasons = details.seasons || [];
      const seasonExists = seasons.some((s: any) => s.season_number === season);
      if (!seasonExists) continue;

      const seasonDetail = await getSeasonDetails(candidate.id, season);
      if (!seasonDetail) continue;

      const tmdbEpisodes = seasonDetail.episodes || [];
      const tmdbCount = tmdbEpisodes.length;

      // Match par titres d'épisodes
      const uploadedEpTitles: { ep: number; title: string | null }[] = [];
      for (const s of group.entries) {
        for (const ep of s.episodes) {
          const filename = (ep.lien || '').split('/').pop()?.split('?')[0] || '';
          uploadedEpTitles.push({ ep: ep.episodeNumber, title: extractEpisodeTitleFromFilename(filename) });
        }
      }
      const titleMatches = uploadedEpTitles.filter(u => {
        if (!u.title) return false;
        const tmdbEp = tmdbEpisodes.find((te: any) => te.episode_number === u.ep);
        if (!tmdbEp || !tmdbEp.name) return false;
        return nameSimilarity(u.title, tmdbEp.name) > 0.4;
      });
      if (titleMatches.length > 0) {
        await Serie.updateMany({ titre: serie.titre }, { $set: { tmdbId: candidate.id } });
        console.log(`[TMDB-AUTO] Series "${serie.titre}" → tmdbId=${candidate.id} (match titres épisodes)`);
        return { ok: true, tmdbId: candidate.id };
      }

      // Fallback : nombre exact d'épisodes
      if (tmdbCount === uploadedCount) {
        await Serie.updateMany({ titre: serie.titre }, { $set: { tmdbId: candidate.id } });
        console.log(`[TMDB-AUTO] Series "${serie.titre}" → tmdbId=${candidate.id} (count match)`);
        return { ok: true, tmdbId: candidate.id };
      }

      // Fallback relâché : uploaded ≤ tmdb + chevauchement d'au moins un numéro d'épisode
      if (uploadedCount <= tmdbCount && uploadedCount > 0) {
        const uploadedEpNumbers = new Set<number>();
        for (const s of group.entries) {
          for (const ep of s.episodes) uploadedEpNumbers.add(ep.episodeNumber);
        }
        const tmdbEpNumbers = new Set(tmdbEpisodes.map((e: any) => e.episode_number));
        const anyNumMatch = [...uploadedEpNumbers].some(n => tmdbEpNumbers.has(n));
        if (anyNumMatch) {
          await Serie.updateMany({ titre: serie.titre }, { $set: { tmdbId: candidate.id } });
          console.log(`[TMDB-AUTO] Series "${serie.titre}" → tmdbId=${candidate.id} (relaxed match)`);
          return { ok: true, tmdbId: candidate.id };
        }
      }
    }

    return { ok: false, reason: 'no_match' };
  } catch (err: any) {
    console.error(`[TMDB-AUTO] Series ${serieId} failed:`, err.message);
    return { ok: false, reason: 'exception' };
  }
}

async function main() {
  await connectDB();

  const allSeries = await Serie.find({ tmdbId: { $exists: false } })
    .select('titre episodes tmdbId')
    .lean();

  if (allSeries.length === 0) {
    console.log('Aucune série à lier (toutes ont déjà un tmdbId).');
    process.exit(0);
  }

  // Group by titre + season (each Serie doc = one season)
  const groups = new Map<string, { entries: typeof allSeries; season: number; maxEpisode: number }>();
  for (const serie of allSeries) {
    const groupKey = serie.titre;
    if (!groups.has(groupKey)) {
      const epNumbers = serie.episodes.map(e => e.episodeNumber);
      const season = Math.min(...epNumbers);
      groups.set(groupKey, { entries: [], season, maxEpisode: 0 });
    }
    const group = groups.get(groupKey)!;
    group.entries.push(serie);
    const epNums = serie.episodes.map(e => e.episodeNumber);
    const hasRealNumbers = epNums.some(n => typeof n === 'number' && n > 0);
    const maxEp = hasRealNumbers
      ? Math.max(...epNums.filter((n): n is number => typeof n === 'number'), 0)
      : serie.episodes.length;
    if (maxEp > group.maxEpisode) group.maxEpisode = maxEp;
  }

  let linked = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const [titre, group] of groups) {
    const parsed = parseTitre(titre);
    if (!parsed) {
      errors.push(`[PARSE] Cannot parse titre: "${titre}"`);
      failed++;
      continue;
    }

    const { seriesName, season } = parsed;
    const uploadedCount = group.maxEpisode;
    console.log(`\n--- ${seriesName} S${season} (${uploadedCount} épisodes) ---`);

    const results = await searchTmdb(seriesName);
    if (results.length === 0) {
      errors.push(`[SEARCH] No TMDB results for "${seriesName}"`);
      failed++;
      continue;
    }

    let matched = false;
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const candidate = results[i];
      console.log(`  Candidat ${i + 1}: "${candidate.name}" (id: ${candidate.id})`);

      const sim = nameSimilarity(seriesName, candidate.name);
      if (sim < 0.3) {
        console.log(`    ❌ Similarité: ${sim.toFixed(2)} — ignoré`);
        continue;
      }
      console.log(`    ✅ Similarité: ${sim.toFixed(2)}`);

      const details = await getTvDetails(candidate.id);
      if (!details) {
        console.log(`    → Impossible de récupérer les détails`);
        continue;
      }

      const seasons = details.seasons || [];
      const seasonExists = seasons.some((s: any) => s.season_number === season);
      if (!seasonExists) {
        console.log(`    → Saison ${season} introuvable`);
        continue;
      }
      console.log(`    ✅ Saison ${season} existe`);

      const seasonDetail = await getSeasonDetails(candidate.id, season);
      if (!seasonDetail) {
        console.log(`    → Impossible de récupérer les épisodes S${season}`);
        continue;
      }

      const tmdbEpisodes = seasonDetail.episodes || [];
      const tmdbCount = tmdbEpisodes.length;

      // Try title-based matching
      const uploadedEpTitles: { ep: number; title: string | null }[] = [];
      for (const serie of group.entries) {
        for (const ep of serie.episodes) {
          const filename = (ep.lien || '').split('/').pop()?.split('?')[0] || '';
          uploadedEpTitles.push({ ep: ep.episodeNumber, title: extractEpisodeTitleFromFilename(filename) });
        }
      }
      const titleMatches = uploadedEpTitles.filter(u => {
        if (!u.title) return false;
        const tmdbEp = tmdbEpisodes.find((te: any) => te.episode_number === u.ep);
        if (!tmdbEp || !tmdbEp.name) return false;
        return nameSimilarity(u.title, tmdbEp.name) > 0.4;
      });

      if (titleMatches.length > 0) {
        console.log(`    ✅ Match par titres d'épisodes (ex: "${titleMatches[0].title}")`);
        const firstMatch = tmdbEpisodes.find((te: any) => te.episode_number === titleMatches[0].ep);
        console.log(`    ✅ LIEN RÉUSSI → tmdbId=${candidate.id}`);
        await Serie.updateMany({ titre }, { $set: { tmdbId: candidate.id } });
        linked++;
        matched = true;
        break;
      }

      // Fallback: exact episode count
      if (tmdbCount === uploadedCount) {
        console.log(`    ⚠ Nombre exact d'épisodes: ${tmdbCount}`);
        console.log(`    ✅ LIEN RÉUSSI → tmdbId=${candidate.id}`);
        await Serie.updateMany({ titre }, { $set: { tmdbId: candidate.id } });
        linked++;
        matched = true;
        break;
      }

      // Relaxed: uploaded <= TMDB + episode number overlap
      if (uploadedCount <= tmdbCount) {
        const uploadedEpNumbers = new Set<number>();
        for (const serie of group.entries) {
          for (const ep of serie.episodes) uploadedEpNumbers.add(ep.episodeNumber);
        }
        const tmdbEpNumbers = new Set(tmdbEpisodes.map((e: any) => e.episode_number));
        const anyNumMatch = [...uploadedEpNumbers].some(n => tmdbEpNumbers.has(n));

        if (anyNumMatch) {
          console.log(`    ⚠ Match relâché: TMDB=${tmdbCount}, uploadés=${uploadedCount}`);
          console.log(`    ✅ LIEN RÉUSSI → tmdbId=${candidate.id}`);
          await Serie.updateMany({ titre }, { $set: { tmdbId: candidate.id } });
          linked++;
          matched = true;
          break;
        }
      }

      console.log(`    ❌ TMDB: ${tmdbCount} épisodes, uploadés: ${uploadedCount}`);
    }

    if (!matched) {
      errors.push(`[NO MATCH] ${seriesName} S${season} — ${uploadedCount} épisodes`);
      failed++;
    }
  }

  console.log(`\n=== RÉSULTAT ===`);
  console.log(`✅ Liés: ${linked}`);
  console.log(`⏭️  Déjà liés (ignorés): ${skipped}`);
  console.log(`❌ Échecs: ${failed}`);

  if (errors.length > 0) {
    const logContent = errors.join('\n') + '\n';
    fs.appendFileSync(ERROR_LOG_PATH, logContent + '\n', 'utf-8');
    console.log(`\nErreurs logguées dans tmdb-link-errors.log`);
  }

  process.exit(0);
}

// Exécuter main() uniquement si le script est lancé directement (pas en import).
if (require.main === module) {
  main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
}