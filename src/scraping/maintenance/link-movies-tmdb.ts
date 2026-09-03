import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import fs from 'fs';
import tmdbClient from '../../config/tmdb';
import { connectDB } from '../../config/db';
import Movie from '../../models/Movie';

const ERROR_LOG_PATH = path.join(__dirname, '../../tmdb-movie-link-errors.log');

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
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
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

  // 1. Levenshtein ratio
  const maxLen = Math.max(normA.length, normB.length);
  const levScore = 1.0 - (levenshteinDistance(normA, normB) / maxLen);

  // 2. Token Jaccard index
  const wordsA = new Set(normA.split(' ').filter(w => w.length > 0));
  const wordsB = new Set(normB.split(' ').filter(w => w.length > 0));
  let intersect = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersect++;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccardScore = union > 0 ? intersect / union : 0;

  // 3. Extraction et vérification des chiffres / numéros de suite
  const numRegex = /\b(\d+|i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/g;
  const numsA = (normA.match(numRegex) || []).join(' ');
  const numsB = (normB.match(numRegex) || []).join(' ');
  let numPenalty = 0;
  if (numsA !== numsB) {
    numPenalty = 0.30;
  }

  const baseScore = levScore * 0.5 + jaccardScore * 0.5;
  return Math.max(0, baseScore - numPenalty);
}

export function cleanMovieTitle(rawTitle: string): { title: string; year?: number; searchQueries: string[] } {
  let cleaned = rawTitle
    .replace(/[\(\[\{]?(?:VF|VOSTFR|VOST|TRUEFRENCH|FRENCH|MULTI|MULTI-VF|HD|4K|1080p|720p|HDRip|WEBRip|BDRip|BluRay|AMZN|NF|x264|x265|H264|H265)[\)\]\}]?/gi, ' ')
    .replace(/[\(\[\{](?:19|20)\d{2}[\)\]\}]/g, (match) => ` ${match.replace(/[^0-9]/g, '')} `)
    .replace(/\s+/g, ' ')
    .trim();

  // Extraction de l'année si présente dans le titre
  let year: number | undefined;
  const yearMatch = cleaned.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    const parsed = parseInt(yearMatch[1], 10);
    if (parsed >= 1920 && parsed <= 2030) {
      year = parsed;
      cleaned = cleaned.replace(yearMatch[0], '').replace(/\s+/g, ' ').trim();
    }
  }

  // Nettoyage des ponctuations de fin
  cleaned = cleaned.replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();

  const queries = new Set<string>();
  if (cleaned.length > 0) queries.add(cleaned);

  // Titre sans ponctuations (ex: "Saints and Soldiers : L'Honneur des paras" → "Saints and Soldiers L'Honneur des paras")
  const noPunct = cleaned.replace(/[:–—-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (noPunct.length > 3 && noPunct !== cleaned) {
    queries.add(noPunct);
  }

  // Titre principal avant le sous-titre (ex: "Avatar : La Voie de l'eau" → "Avatar")
  const subMatch = cleaned.split(/[:–—-]/);
  if (subMatch.length > 1 && subMatch[0].trim().length >= 3) {
    queries.add(subMatch[0].trim());
    if (subMatch[1]?.trim().length >= 4) {
      queries.add(subMatch[1].trim());
    }
  }

  // Titre sans les articles français en début (ex: "Le Parrain" → "Parrain")
  const withoutArticles = cleaned.replace(/^(?:le|la|les|l'|un|une|des|the)\s+/i, '').trim();
  if (withoutArticles.length >= 3 && withoutArticles !== cleaned) {
    queries.add(withoutArticles);
  }

  return {
    title: cleaned,
    year,
    searchQueries: Array.from(queries)
  };
}

async function searchTmdbMovieSmart(rawTitle: string, explicitYear?: number | null): Promise<any[]> {
  const { title: cleanTitle, year: extractedYear, searchQueries } = cleanMovieTitle(rawTitle);
  const targetYear = explicitYear || extractedYear;

  const candidatesMap = new Map<number, any>();

  for (const query of searchQueries) {
    // 1. Recherche FR avec année (si connue)
    try {
      const params: Record<string, any> = { query, language: 'fr-FR', page: 1 };
      if (targetYear) params.year = targetYear;
      const { data } = await tmdbClient.get('/search/movie', { params });
      if (Array.isArray(data?.results)) {
        for (const item of data.results) candidatesMap.set(item.id, item);
      }
    } catch (_) {}

    // Si on a des résultats pertinents, on continue
    if (candidatesMap.size >= 5) break;

    // 2. Recherche FR sans contrainte d'année exacte
    if (targetYear) {
      try {
        const { data } = await tmdbClient.get('/search/movie', {
          params: { query, language: 'fr-FR', page: 1 }
        });
        if (Array.isArray(data?.results)) {
          for (const item of data.results) candidatesMap.set(item.id, item);
        }
      } catch (_) {}
    }

    // 3. Recherche internationale (en-US)
    try {
      const params: Record<string, any> = { query, language: 'en-US', page: 1 };
      if (targetYear) params.year = targetYear;
      const { data } = await tmdbClient.get('/search/movie', { params });
      if (Array.isArray(data?.results)) {
        for (const item of data.results) candidatesMap.set(item.id, item);
      }
    } catch (_) {}
  }

  // 4. Fallback multi-search si toujours aucun résultat
  if (candidatesMap.size === 0 && cleanTitle.length > 2) {
    try {
      const { data } = await tmdbClient.get('/search/multi', {
        params: { query: cleanTitle, language: 'fr-FR', page: 1 }
      });
      if (Array.isArray(data?.results)) {
        for (const item of data.results) {
          if (item.media_type === 'movie' || item.media_type === 'tv') {
            candidatesMap.set(item.id, item);
          }
        }
      }
    } catch (_) {}
  }

  return Array.from(candidatesMap.values());
}

function scoreMovieCandidate(rawTitle: string, targetYear: number | undefined | null, candidate: any): number {
  const { title: cleanTitle, year: extractedYear } = cleanMovieTitle(rawTitle);
  const year = targetYear || extractedYear;

  const candidateTitle = candidate.title || candidate.name || '';
  const candidateOrigTitle = candidate.original_title || candidate.original_name || '';

  const simFR = stringSimilarity(cleanTitle, candidateTitle);
  const simOrig = stringSimilarity(cleanTitle, candidateOrigTitle);
  let bestSim = Math.max(simFR, simOrig);

  // Bonus/malus d'année
  let yearBonus = 0;
  if (candidate.release_date || candidate.first_air_date) {
    const candYear = new Date(candidate.release_date || candidate.first_air_date).getFullYear();
    if (year && !isNaN(candYear)) {
      const diff = Math.abs(candYear - year);
      if (diff === 0) yearBonus = 0.20;
      else if (diff === 1) yearBonus = 0.10;
      else if (diff > 4 && bestSim < 0.95) yearBonus = -0.15;
    }
  }

  // Léger bonus de popularité TMDB pour départager les homonymes
  const popBonus = Math.min(0.06, Math.log10((candidate.popularity || 1) + 1) * 0.02);

  return bestSim + yearBonus + popBonus;
}

/**
 * Lie un film MongoDB à son ID TMDB avec algorithme de matching intelligent.
 */
export async function linkMovieTmdb(movieId: string): Promise<{ ok: boolean; tmdbId?: number; reason?: string }> {
  try {
    const movie: any = await Movie.findById(movieId).select('titre tmdbId year').lean();
    if (!movie) return { ok: false, reason: 'not_found' };
    if (movie.tmdbId) return { ok: true, tmdbId: movie.tmdbId };

    const results = await searchTmdbMovieSmart(movie.titre, movie.year);
    if (results.length === 0) return { ok: false, reason: 'no_tmdb_results' };

    let bestCandidate: any = null;
    let highestScore = -1;

    for (const candidate of results) {
      const score = scoreMovieCandidate(movie.titre, movie.year, candidate);
      if (score > highestScore) {
        highestScore = score;
        bestCandidate = candidate;
      }
    }

    // Seuil de confiance adaptatif : >= 0.70 (ou >= 0.58 si l'année correspond)
    const hasYearMatch = movie.year && bestCandidate?.release_date && Math.abs(new Date(bestCandidate.release_date).getFullYear() - movie.year) <= 1;
    const minThreshold = hasYearMatch ? 0.58 : 0.68;

    if (bestCandidate && highestScore >= minThreshold) {
      await Movie.updateOne({ _id: movie._id }, { $set: { tmdbId: bestCandidate.id } });
      console.log(`[TMDB-AUTO] Movie "${movie.titre}" → tmdbId=${bestCandidate.id} ("${bestCandidate.title || bestCandidate.name}", score=${highestScore.toFixed(2)})`);
      return { ok: true, tmdbId: bestCandidate.id };
    }

    return { ok: false, reason: 'no_confident_match' };
  } catch (err: any) {
    console.error(`[TMDB-AUTO] Movie ${movieId} failed:`, err.message);
    return { ok: false, reason: 'exception' };
  }
}

async function main() {
  await connectDB();

  const toLink = await Movie.find({ tmdbId: { $exists: false } })
    .select('titre lien tmdbId year createdAt')
    .lean();

  if (toLink.length === 0) {
    console.log('Aucun film à lier (tous ont déjà un tmdbId).');
    return;
  }

  console.log(`${toLink.length} films sans TMDB à traiter\n`);

  let linked = 0;
  let failed = 0;
  const errors: string[] = [];
  const total = toLink.length;

  for (let idx = 0; idx < total; idx++) {
    const movie: any = toLink[idx];
    const res = await linkMovieTmdb(String(movie._id));
    if (res.ok && res.tmdbId) {
      linked++;
    } else {
      failed++;
      errors.push(`[NO MATCH] "${movie.titre}" (reason: ${res.reason || 'unknown'})`);
    }
  }

  console.log(`\n=== RÉSULTAT ===`);
  console.log(`✅ Liés: ${linked}`);
  console.log(`❌ Échecs: ${failed}`);
  console.log(`📊 Total traités: ${total}`);

  if (errors.length > 0) {
    const logContent = errors.join('\n') + '\n';
    fs.appendFileSync(ERROR_LOG_PATH, logContent, 'utf-8');
    console.log(`\nErreurs logguées dans tmdb-movie-link-errors.log`);
  }
}

if (require.main === module) {
  main().catch(err => console.error('[FATAL]', err));
}