import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import fs from 'fs';
import tmdbClient from '../../config/tmdb';
import { connectDB } from '../../config/db';
import Serie from '../../models/Serie';

const ERROR_LOG_PATH = path.join(__dirname, '../../tmdb-link-errors.log');

export function normalizeText(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

export function stringSimilarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const maxLen = Math.max(normA.length, normB.length);
  const levScore = 1.0 - (levenshteinDistance(normA, normB) / maxLen);

  const wordsA = new Set(normA.split(' ').filter(w => w.length > 0));
  const wordsB = new Set(normB.split(' ').filter(w => w.length > 0));
  let intersect = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersect++;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccardScore = union > 0 ? intersect / union : 0;

  let subScore = 0;
  if (normA.includes(normB) || normB.includes(normA)) {
    const minLen = Math.min(normA.length, normB.length);
    subScore = minLen / maxLen;
  }

  return Math.max(levScore * 0.5 + jaccardScore * 0.5, subScore, jaccardScore);
}

export function parseSeriesTitle(rawTitle: string): { seriesName: string; season: number; year?: number; searchQueries: string[] } {
  let cleaned = rawTitle
    .replace(/[\(\[\{]?(?:VF|VOSTFR|VOST|TRUEFRENCH|FRENCH|MULTI|MULTI-VF|HD|4K|1080p|720p|HDRip|WEBRip|BDRip|BluRay|AMZN|NF)[\)\]\}]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extraction de la saison (Saison 1, Season 02, S03, Partie 1, etc.)
  let season = 1;
  const seasonMatch = cleaned.match(/(?:[-–—:]\s*)?(?:Saison|Season|S|Partie|Part|Cour)\s*(\d+)/i);
  if (seasonMatch) {
    season = parseInt(seasonMatch[1], 10);
    cleaned = cleaned.replace(seasonMatch[0], ' ').trim();
  }

  // Extraction de l'année
  let year: number | undefined;
  const yearMatch = cleaned.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    const parsed = parseInt(yearMatch[1], 10);
    if (parsed >= 1950 && parsed <= 2030) {
      year = parsed;
      cleaned = cleaned.replace(yearMatch[0], ' ').trim();
    }
  }

  cleaned = cleaned.replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();

  const queries = new Set<string>();
  if (cleaned.length > 0) queries.add(cleaned);

  // Variante avant le séparateur (ex: "Demon Slayer : Kimetsu no Yaiba" → "Demon Slayer")
  const parts = cleaned.split(/[:–—-]/);
  if (parts.length > 1 && parts[0].trim().length >= 3) {
    queries.add(parts[0].trim());
  }

  // Variante sans les articles
  const withoutArticles = cleaned.replace(/^(?:le|la|les|l'|un|une|des|the)\s+/i, '').trim();
  if (withoutArticles.length >= 3 && withoutArticles !== cleaned) {
    queries.add(withoutArticles);
  }

  return {
    seriesName: cleaned,
    season,
    year,
    searchQueries: Array.from(queries)
  };
}

async function searchTmdbSeriesSmart(rawTitle: string, explicitYear?: number | null): Promise<any[]> {
  const { seriesName, year: extractedYear, searchQueries } = parseSeriesTitle(rawTitle);
  const targetYear = explicitYear || extractedYear;

  const candidatesMap = new Map<number, any>();

  for (const query of searchQueries) {
    // 1. Recherche FR
    try {
      const params: Record<string, any> = { query, language: 'fr-FR', page: 1 };
      if (targetYear) params.first_air_date_year = targetYear;
      const { data } = await tmdbClient.get('/search/tv', { params });
      if (Array.isArray(data?.results)) {
        for (const item of data.results) candidatesMap.set(item.id, item);
      }
    } catch (_) {}

    if (candidatesMap.size >= 5) break;

    // 2. Recherche FR sans année stricte
    if (targetYear) {
      try {
        const { data } = await tmdbClient.get('/search/tv', {
          params: { query, language: 'fr-FR', page: 1 }
        });
        if (Array.isArray(data?.results)) {
          for (const item of data.results) candidatesMap.set(item.id, item);
        }
      } catch (_) {}
    }

    // 3. Recherche internationale (en-US / original)
    try {
      const params: Record<string, any> = { query, language: 'en-US', page: 1 };
      const { data } = await tmdbClient.get('/search/tv', { params });
      if (Array.isArray(data?.results)) {
        for (const item of data.results) candidatesMap.set(item.id, item);
      }
    } catch (_) {}
  }

  // 4. Fallback multi-search
  if (candidatesMap.size === 0 && seriesName.length > 2) {
    try {
      const { data } = await tmdbClient.get('/search/multi', {
        params: { query: seriesName, language: 'fr-FR', page: 1 }
      });
      if (Array.isArray(data?.results)) {
        for (const item of data.results) {
          if (item.media_type === 'tv' || item.media_type === 'movie') {
            candidatesMap.set(item.id, item);
          }
        }
      }
    } catch (_) {}
  }

  return Array.from(candidatesMap.values());
}

function scoreSeriesCandidate(rawTitle: string, targetYear: number | undefined | null, candidate: any): number {
  const { seriesName, year: extractedYear } = parseSeriesTitle(rawTitle);
  const year = targetYear || extractedYear;

  const candidateName = candidate.name || candidate.title || '';
  const candidateOrigName = candidate.original_name || candidate.original_title || '';

  const simFR = stringSimilarity(seriesName, candidateName);
  const simOrig = stringSimilarity(seriesName, candidateOrigName);
  let bestSim = Math.max(simFR, simOrig);

  let yearBonus = 0;
  if (candidate.first_air_date || candidate.release_date) {
    const candYear = new Date(candidate.first_air_date || candidate.release_date).getFullYear();
    if (year && !isNaN(candYear)) {
      const diff = Math.abs(candYear - year);
      if (diff === 0) yearBonus = 0.20;
      else if (diff <= 2) yearBonus = 0.10;
      else if (diff > 5 && bestSim < 0.95) yearBonus = -0.15;
    }
  }

  const popBonus = Math.min(0.06, Math.log10((candidate.popularity || 1) + 1) * 0.02);

  return bestSim + yearBonus + popBonus;
}

/**
 * Lie une série MongoDB à son ID TMDB avec matching intelligent.
 */
export async function linkSeriesTmdb(serieId: string): Promise<{ ok: boolean; tmdbId?: number; reason?: string }> {
  try {
    const serie: any = await Serie.findById(serieId).select('titre episodes tmdbId year').lean();
    if (!serie) return { ok: false, reason: 'not_found' };
    if (serie.tmdbId) return { ok: true, tmdbId: serie.tmdbId };

    const results = await searchTmdbSeriesSmart(serie.titre, serie.year);
    if (results.length === 0) return { ok: false, reason: 'no_tmdb_results' };

    let bestCandidate: any = null;
    let highestScore = -1;

    for (const candidate of results) {
      const score = scoreSeriesCandidate(serie.titre, serie.year, candidate);
      if (score > highestScore) {
        highestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate && highestScore >= 0.45) {
      await Serie.updateOne({ _id: serie._id }, { $set: { tmdbId: bestCandidate.id } });
      console.log(`[TMDB-AUTO] Serie "${serie.titre}" → tmdbId=${bestCandidate.id} ("${bestCandidate.name || bestCandidate.title}", score=${highestScore.toFixed(2)})`);
      return { ok: true, tmdbId: bestCandidate.id };
    }

    return { ok: false, reason: 'no_confident_match' };
  } catch (err: any) {
    console.error(`[TMDB-AUTO] Serie ${serieId} failed:`, err.message);
    return { ok: false, reason: 'exception' };
  }
}

async function main() {
  await connectDB();

  const toLink = await Serie.find({ tmdbId: { $exists: false } })
    .select('titre episodes tmdbId year')
    .lean();

  if (toLink.length === 0) {
    console.log('Aucune série à lier (toutes ont déjà un tmdbId).');
    return;
  }

  console.log(`${toLink.length} séries sans TMDB à traiter\n`);

  let linked = 0;
  let failed = 0;
  const errors: string[] = [];
  const total = toLink.length;

  for (let idx = 0; idx < total; idx++) {
    const s: any = toLink[idx];
    const res = await linkSeriesTmdb(String(s._id));
    if (res.ok && res.tmdbId) {
      linked++;
    } else {
      failed++;
      errors.push(`[NO MATCH] "${s.titre}" (reason: ${res.reason || 'unknown'})`);
    }
  }

  console.log(`\n=== RÉSULTAT SÉRIES ===`);
  console.log(`✅ Liées: ${linked}`);
  console.log(`❌ Échecs: ${failed}`);
  console.log(`📊 Total traitées: ${total}`);

  if (errors.length > 0) {
    const logContent = errors.join('\n') + '\n';
    fs.appendFileSync(ERROR_LOG_PATH, logContent, 'utf-8');
    console.log(`\nErreurs logguées dans tmdb-link-errors.log`);
  }
}

if (require.main === module) {
  main().catch(err => console.error('[FATAL]', err));
}