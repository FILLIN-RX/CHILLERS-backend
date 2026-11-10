import axios from 'axios';
import querystring from 'querystring';
import Movie from '../../models/Movie';
import { DirectScraper } from '../streaming/providers/direct-scraper';
import { isLanguageCompatible } from '../../utils/audio-language';

const BASE_URL = 'https://french-stream.net';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FrenchStreamSearchResult {
  title: string;
  url: string;
  poster: string;
}

export interface FrenchStreamVersion {
  label: string; // TRUEFRENCH, FRENCH, VOSTFR
  embedUrl: string;
}

export interface FrenchStreamDirectResult {
  title: string;
  quality: string;
  fileSize: string;
  streamUrl: string;
  embedUrl?: string;
  pagePath?: string;
  source: 'frenchstream';
}

export function toRelativePath(urlOrPath: string): string {
  try {
    if (urlOrPath.startsWith('http')) {
      const parsed = new URL(urlOrPath);
      return parsed.pathname + parsed.search;
    }
  } catch {}
  return urlOrPath.startsWith('/') ? urlOrPath : `/${urlOrPath}`;
}

function normalize(str: string): string {
  if (!str) return '';
  // Supprime l'année entre parenthèses comme (2026), (2025), etc.
  const withoutYear = str.replace(/\s*\(\s*\d{4}\s*\)\s*$/i, '');
  return withoutYear
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function cleanSearchQuery(q: string): string {
  if (!q) return '';
  return q
    .replace(/[?!,;:#~"'\(\)\[\]{}*_\\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recherche un film sur French-Stream via l'endpoint AJAX interne
 */
export async function searchFrenchStream(query: string): Promise<FrenchStreamSearchResult[]> {
  try {
    const cleaned = cleanSearchQuery(query);
    const postData = querystring.stringify({ query: cleaned || query });
    const { data } = await axios.post(
      `${BASE_URL}/engine/ajax/controller.php?mod=search`,
      postData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/`
        },
        timeout: 10000
      }
    );

    if (!data || typeof data !== 'string') return [];

    const items: FrenchStreamSearchResult[] = [];
    const regex = /location\.href='([^']+)'[\s\S]*?<img src='([^']*)'[\s\S]*?<div class='search-title'>([\s\S]*?)<\/div>/gi;
    let match;

    while ((match = regex.exec(data)) !== null) {
      const relUrl = match[1];
      const poster = match[2];
      const title = match[3].replace(/\\'/g, "'").replace(/&amp;/g, '&').trim();
      items.push({
        url: relUrl.startsWith('http') ? relUrl : `${BASE_URL}${relUrl}`,
        poster,
        title
      });
    }

    return items;
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur recherche "${query}":`, error.message);
    return [];
  }
}

/**
 * Extrait les liens de lecteurs Vidzy (TRUEFRENCH, FRENCH, VOSTFR) depuis la page du film
 */
export async function extractEmbedVersions(pageUrl: string): Promise<{
  title: string;
  versions: FrenchStreamVersion[];
  directors?: string[];
  actors?: string[];
}> {
  try {
    const { data: html } = await axios.get(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${BASE_URL}/`
      },
      timeout: 15000
    });

    const titleMatch = html.match(/<h1[^>]*id="s-title"[^>]*>([\s\S]*?)<\/h1>/i);
    const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const versions: FrenchStreamVersion[] = [];

    // 1. Recherche par sélecteurs classiques (div.option, div.select-option, etc.)
    const optionRegex = /<(?:div|li|a|span|button)[^>]+(?:data-url|data-src|data-link)="([^"]+)"[^>]*>([\s\S]*?)<\/(?:div|li|a|span|button)>/gi;
    let match;

    while ((match = optionRegex.exec(html)) !== null) {
      const embedUrl = match[1];
      const rawText = match[2].replace(/<[^>]+>/g, '').replace(/Télécharger en /i, '').trim();
      const label = rawText || 'Lecteur';
      versions.push({ label, embedUrl });
    }

    // 2. Recherche d'iframes directes dans le HTML
    const iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
    let ifrMatch;
    while ((ifrMatch = iframeRegex.exec(html)) !== null) {
      const ifrSrc = ifrMatch[1];
      if (/vidzy|uqload|dood|voe|streamtape|filmoon/i.test(ifrSrc)) {
        if (!versions.some(v => v.embedUrl === ifrSrc)) {
          versions.push({ label: 'Lecteur Principal', embedUrl: ifrSrc });
        }
      }
    }

    // 3. Si aucune version trouvée en HTML statique, interroger l'API interne film_api.php
    if (versions.length === 0) {
      const newsIdMatch = pageUrl.match(/\/(\d+)-/i) || html.match(/dle_news_id\s*=\s*['"](\d+)['"]/i);
      const isPageVostfr = /-vostfr\.html/i.test(pageUrl) || /\bVOSTFR\b/i.test(rawTitle);

      if (newsIdMatch && newsIdMatch[1]) {
        try {
          const apiUrl = `${BASE_URL}/engine/ajax/film_api.php?id=${newsIdMatch[1]}`;
          const { data: apiData } = await axios.get(apiUrl, {
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': pageUrl
            },
            timeout: 10000
          });

          if (apiData?.players && typeof apiData.players === 'object') {
            const preferredHosts = ['vidzy', 'uqload', 'premium', 'dood', 'voe', 'filmoon'];
            const allHosts = Object.keys(apiData.players).sort((a, b) => {
              const idxA = preferredHosts.indexOf(a.toLowerCase());
              const idxB = preferredHosts.indexOf(b.toLowerCase());
              const scoreA = idxA === -1 ? 99 : idxA;
              const scoreB = idxB === -1 ? 99 : idxB;
              return scoreA - scoreB;
            });

            for (const host of allHosts) {
              const playerData = apiData.players[host];
              if (!playerData || typeof playerData !== 'object') continue;

              const variants = [
                { key: 'vff', label: `${host.toUpperCase()} (TRUEFRENCH)` },
                { key: 'vf', label: `${host.toUpperCase()} (VF)` },
                { key: 'vfq', label: `${host.toUpperCase()} (VFQ)` },
                { key: 'default', label: isPageVostfr && !playerData.vf && !playerData.vff ? `${host.toUpperCase()} (VOSTFR)` : `${host.toUpperCase()} (FRENCH)` },
                { key: 'vostfr', label: `${host.toUpperCase()} (VOSTFR)` },
              ];

              const addedUrls = new Set<string>();
              for (const v of variants) {
                const url = playerData[v.key];
                if (url && typeof url === 'string' && !addedUrls.has(url)) {
                  addedUrls.add(url);
                  versions.push({ label: v.label, embedUrl: url });
                }
              }
            }
          }
        } catch (apiErr: any) {
          console.error(`[FrenchStream] Erreur appel film_api.php pour id=${newsIdMatch[1]}:`, apiErr.message);
        }
      }
    }

    // 4. Regex générique de secours pour tous les liens d'embeds connus dans le HTML
    if (versions.length === 0) {
      const genericHostRegex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:uqload\.[a-z]+|vidzy\.[a-z]+|dood\.[a-z]+|doodstream\.[a-z]+|voe\.[a-z]+|streamtape\.[a-z]+)\/(?:embed-|e\/|d\/)[a-zA-Z0-9_-]+(?:\.html)?/gi;
      let hostMatch;
      const seen = new Set<string>();
      while ((hostMatch = genericHostRegex.exec(html)) !== null) {
        const foundUrl = hostMatch[0];
        if (!seen.has(foundUrl)) {
          seen.add(foundUrl);
          versions.push({ label: 'Lecteur Détecté', embedUrl: foundUrl });
        }
      }
    }
    let candidateDirectors: string[] = [];
    let candidateActors: string[] = [];

    // Extraction robuste depuis les balises HTML de FrenchStream
    const actorsMatch = html.match(/<span>Acteurs:\s*<\/span>([\s\S]*?)<\/li>/i);
    if (actorsMatch) {
      candidateActors = (actorsMatch[1].match(/<a[^>]*>([^<]+)<\/a>/gi) || [])
        .map((a: string) => a.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean);
    }
    const dirMatch = html.match(/<span>(?:Réalisateur|Réalisé par):\s*<\/span>([\s\S]*?)<\/li>/i);
    if (dirMatch) {
      candidateDirectors = (dirMatch[1].match(/<a[^>]*>([^<]+)<\/a>/gi) || [])
        .map((a: string) => a.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean);
    }

    // Fallback regex sur les métadonnées JSON-LD (sans JSON.parse fragile)
    if (candidateDirectors.length === 0) {
      const dSection = html.match(/"director":\s*\[([\s\S]*?)\]/i)?.[1] || '';
      candidateDirectors = (dSection.match(/"name":\s*"([^"]+)"/g) || [])
        .map((m: string) => m.replace(/"name":\s*"/, '').replace(/"$/, '').trim())
        .filter(Boolean);
    }
    if (candidateActors.length === 0) {
      const aSection = html.match(/"actor":\s*\[([\s\S]*?)\]/i)?.[1] || '';
      candidateActors = (aSection.match(/"name":\s*"([^"]+)"/g) || [])
        .map((m: string) => m.replace(/"name":\s*"/, '').replace(/"$/, '').trim())
        .filter(Boolean);
    }

    return { title: rawTitle, versions, directors: candidateDirectors, actors: candidateActors };
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur extraction ${pageUrl}:`, error.message);
    return { title: '', versions: [] };
  }
}

/**
 * Résout le lien direct MP4 1080p (Full HD) à partir de l'embed Vidzy
 */
export async function resolveVidzyDirectStream(embedUrl: string): Promise<{ streamUrl: string; fileSize: string } | null> {
  try {
    const directScraped = await DirectScraper.resolve(embedUrl);
    if (directScraped?.directUrl) {
      return {
        streamUrl: directScraped.directUrl,
        fileSize: '1080p Full HD',
      };
    }

    const dlPageUrl = embedUrl.replace('/embed-', '/d/').replace('.html', '_n.html');
    const { data: html } = await axios.get(dlPageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${BASE_URL}/`
      },
      timeout: 8000
    });

    const titleMatch = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const fileSize = titleMatch ? titleMatch[1].trim() : '1080p Full HD';

    const opMatch = html.match(/name="op" value="([^"]+)"/);
    const idMatch = html.match(/name="id" value="([^"]+)"/);
    const modeMatch = html.match(/name="mode" value="([^"]+)"/);
    const hashMatch = html.match(/name="hash" value="([^"]+)"/);

    if (!hashMatch) return null;

    const form = {
      op: opMatch ? opMatch[1] : 'download_orig',
      id: idMatch ? idMatch[1] : '',
      mode: modeMatch ? modeMatch[1] : 'o',
      hash: hashMatch[1]
    };

    let origin = 'https://vidzy.cc';
    try {
      const u = new URL(embedUrl);
      origin = `${u.protocol}//${u.host}`;
    } catch {}

    const postData = querystring.stringify(form);
    const postRes = await axios.post(dlPageUrl, postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': USER_AGENT,
        'Referer': dlPageUrl,
        'Origin': origin
      },
      timeout: 15000
    });

    const directLinks = postRes.data.match(/https?:\/\/[^"'\s\)]+\.(?:mp4|m3u8)[^"'\s\)]*/gi);
    if (directLinks && directLinks[0]) {
      return {
        streamUrl: directLinks[0],
        fileSize
      };
    }

    // Recherche via href dans balise <a> ou window.open
    const aMatch = postRes.data.match(/href="([^"]+\.mp4[^"]*)"/i);
    if (aMatch && aMatch[1]) {
      return {
        streamUrl: aMatch[1],
        fileSize
      };
    }

    return null;
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur résolution Vidzy ${embedUrl}:`, error.message);
    return null;
  }
}

function extractYear(str: string): number | null {
  const m = str.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Sur French-Stream, une page de série porte toujours « Saison N » dans son titre
 * ou son URL ; les films n'en portent jamais. La recherche « Bleach » remonte le
 * film live-action de 2018 avant la série : sans ce tri, c'est son fichier qui
 * est servi comme épisode.
 */
const SAISON_RE = /saison[\s.-]*(\d{1,2})/i;

function saisonOf(text: string): number | null {
  const m = text.match(SAISON_RE);
  return m ? parseInt(m[1], 10) : null;
}

function isSeriesPage(item: { title: string; url: string }): boolean {
  return SAISON_RE.test(item.title) || SAISON_RE.test(item.url);
}

function isCandidateMatching(candidateTitle: string, titles: string[]): boolean {
  const normCand = normalize(candidateTitle);
  if (!normCand) return false;
  for (const t of titles) {
    const norm = normalize(t);
    if (!norm) continue;
    if (normCand === norm) return true;
    if (normCand.startsWith(norm) || norm.startsWith(normCand)) return true;
    if (normCand.includes(norm) || norm.includes(normCand)) return true;
  }
  return false;
}

function rankCandidates(
  results: FrenchStreamSearchResult[],
  searchTitle: string,
  targetYear?: number,
  originalTitle?: string,
  frenchTitle?: string
): FrenchStreamSearchResult[] {
  const titlesToMatch = [frenchTitle, searchTitle, originalTitle].filter(Boolean) as string[];
  const searchNorms = titlesToMatch.map(t => normalize(t)).filter(Boolean);

  return [...results].sort((a, b) => {
    const normA = normalize(a.title);
    const normB = normalize(b.title);

    let scoreA = 0;
    let scoreB = 0;

    // Correspondance textuelle
    for (const searchNorm of searchNorms) {
      if (normA === searchNorm) scoreA = Math.max(scoreA, 100);
      else if (normA.startsWith(searchNorm) || searchNorm.startsWith(normA)) scoreA = Math.max(scoreA, 50);
      else if (normA.includes(searchNorm) || searchNorm.includes(normA)) scoreA = Math.max(scoreA, 40);
      else scoreA = Math.max(scoreA, 10);

      if (normB === searchNorm) scoreB = Math.max(scoreB, 100);
      else if (normB.startsWith(searchNorm) || searchNorm.startsWith(normB)) scoreB = Math.max(scoreB, 50);
      else if (normB.includes(searchNorm) || searchNorm.includes(normB)) scoreB = Math.max(scoreB, 40);
      else scoreB = Math.max(scoreB, 10);
    }

    // Correspondance d'année si spécifiée
    if (targetYear) {
      const yearA = extractYear(a.title);
      const yearB = extractYear(b.title);

      if (yearA) {
        const diffA = Math.abs(yearA - targetYear);
        if (diffA === 0) scoreA += 250; // Match exact
        else if (diffA === 1) scoreA += 100; // Tolérance 1 an
        else scoreA -= 150; // Mauvaise année (autre remake ou opus)
      }

      if (yearB) {
        const diffB = Math.abs(yearB - targetYear);
        if (diffB === 0) scoreB += 250;
        else if (diffB === 1) scoreB += 100;
        else scoreB -= 150;
      }
    }

    return scoreB - scoreA;
  });
}

/**
 * Recherche et résout directement un film en Haute Résolution (1080p)
 */
export async function getFrenchStreamMovie(
  title: string,
  preferredLang: 'fr' | 'vostfr' | 'en' | 'vo' = 'fr',
  targetYear?: number,
  knownPagePath?: string,
  originalTitle?: string,
  directors?: string[],
  mainActors?: string[],
  frenchTitle?: string
): Promise<FrenchStreamDirectResult | null> {
  try {
    let bestUrl = '';
    let bestTitle = title;
    let versions: FrenchStreamVersion[] = [];
    let resolvedTitle = '';

    // 1. Tenter l'accès direct via pagePath connu en DB si disponible
    if (knownPagePath) {
      const fullKnownUrl = knownPagePath.startsWith('http')
        ? knownPagePath
        : `${BASE_URL}${knownPagePath.startsWith('/') ? '' : '/'}${knownPagePath}`;
      console.log(`[FrenchStream HQ] [Direct Cache] Tentative directe sur page mémorisée: ${fullKnownUrl}`);
      try {
        const directExtracted = await extractEmbedVersions(fullKnownUrl);
        if (directExtracted.versions.length > 0) {
          const candDirs = directExtracted.directors || [];
          const candActs = directExtracted.actors || [];
          if ((candDirs.length > 0 || candActs.length > 0) && ((directors && directors.length > 0) || (mainActors && mainActors.length > 0))) {
            const matchDir = directors?.some(d => candDirs.some(cd => cd.toLowerCase().includes(d.toLowerCase()) || d.toLowerCase().includes(cd.toLowerCase())));
            const matchAct = mainActors?.some(a => candActs.some(ca => ca.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(ca.toLowerCase())));
            if (!matchDir && !matchAct) {
              console.log(`[FrenchStream HQ] [Direct Cache] ⚠️ Page mémorisée rejetée pour "${title}" : homonyme incompatible.`);
              directExtracted.versions = [];
            }
          }
        }
        if (directExtracted.versions.length > 0) {
          bestUrl = fullKnownUrl;
          bestTitle = directExtracted.title || title;
          resolvedTitle = directExtracted.title;
          versions = directExtracted.versions;
          console.log(`[FrenchStream HQ] [Direct Cache] ${versions.length} versions trouvées directement sans recherche !`);
        } else {
          console.log(`[FrenchStream HQ] [Direct Cache] Aucune version sur la page mémorisée, bascule vers recherche globale.`);
        }
      } catch (err: any) {
        console.warn(`[FrenchStream HQ] [Direct Cache] Échec page mémorisée (${err.message}), fallback recherche.`);
      }
    }

    // 2. Si pas de page connue ou si elle n'a rien renvoyé, effectuer la recherche par titre (FR puis EN)
    if (versions.length === 0) {
      const searchQueries = [
        frenchTitle,
        title,
        originalTitle
      ].filter(Boolean) as string[];

      const uniqueQueries: string[] = [];
      const seenNorms = new Set<string>();
      for (const q of searchQueries) {
        const norm = normalize(q);
        if (norm && !seenNorms.has(norm)) {
          seenNorms.add(norm);
          uniqueQueries.push(q);
        }
      }

      console.log(`[FrenchStream HQ] Recherche film 1080p: [${uniqueQueries.map(q => `"${q}"`).join(', ')}] (lang=${preferredLang}, targetYear=${targetYear || 'non spécifiée'})`);

      const titlesToCheck = uniqueQueries;
      let allSearchResults: FrenchStreamSearchResult[] = [];

      for (const queryStr of uniqueQueries) {
        const results = await searchFrenchStream(queryStr);
        if (results.length > 0) {
          allSearchResults = results;
          if (results.some(r => isCandidateMatching(r.title, titlesToCheck))) {
            break;
          }
        }
      }

      if (allSearchResults.length === 0) return null;

      // Classer et prioriser les résultats avec scoring par titre et année
      const rankedResults = rankCandidates(allSearchResults, title, targetYear, originalTitle, frenchTitle);

      // Post-filtre année : éliminer les candidats dont l'année dans le titre
      // est clairement incompatible (ex: "The Odyssey (1997)" quand on cherche 2024).
      // On conserve les candidats sans année visible comme fallback au cas où
      // tous les candidats sont filtrés.
      const yearFilteredResults = targetYear
        ? (() => {
            const compatible = rankedResults.filter((r) => {
              const y = extractYear(r.title);
              if (!y) return true; // pas d'année dans le titre → conserver
              return Math.abs(y - targetYear) <= 1;
            });
            // Si le filtre élimine tout, garder le meilleur scoré (moins pire)
            return compatible.length > 0 ? compatible : rankedResults;
          })()
        : rankedResults;

      const best = yearFilteredResults[0];

      if (!isCandidateMatching(best.title, titlesToCheck)) {
        console.log(`[FrenchStream HQ] Correspondance définitivement rejetée pour [${titlesToCheck.join(', ')}] (trouvé: "${best.title}"), skip.`);
        return null;
      } else {
        console.log(`[FrenchStream HQ] Meilleure page trouvée: ${best.url} (${best.title})`);
        bestUrl = best.url;
        bestTitle = best.title;
        const extracted = await extractEmbedVersions(best.url);

        const candidateDirectors = extracted.directors || [];
        const candidateActors = extracted.actors || [];

        // Protection homonymes : si la page fournit réalisateurs ou acteurs, vérifier la cohérence avec TMDB
        if ((candidateDirectors.length > 0 || candidateActors.length > 0) && ((directors && directors.length > 0) || (mainActors && mainActors.length > 0))) {
          const matchDirector = directors?.some(d => candidateDirectors.some(cd => cd.toLowerCase().includes(d.toLowerCase()) || d.toLowerCase().includes(cd.toLowerCase())));
          const matchActor = mainActors?.some(a => candidateActors.some(ca => ca.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(ca.toLowerCase())));

          if (!matchDirector && !matchActor) {
            console.log(`[FrenchStream HQ] ⚠️ Rejet homonyme pour "${title}" : réalisateurs/acteurs incompatibles (Page: ${candidateDirectors.join(', ')} / ${candidateActors.slice(0, 3).join(', ')} vs Cible: ${(directors || []).join(', ')} / ${(mainActors || []).slice(0, 3).join(', ')}).`);
            return null;
          }
        }

        resolvedTitle = extracted.title;
        versions = extracted.versions;
      }
    }

    if (versions.length === 0) return null;

    let filteredVersions = versions.filter(v =>
      isLanguageCompatible(preferredLang, {
        titre: bestTitle,
        lien: v.embedUrl,
        langueAudio: v.label.includes('VOSTFR') ? 'VOSTFR' : (v.label.includes('VF') || v.label.includes('FRENCH') || v.label.includes('TRUEFRENCH')) ? 'VF' : undefined,
      })
    );

    const strictLang = filteredVersions.length > 0;
    if (!strictLang) {
      console.log(`[FrenchStream HQ] Aucune version compatible avec la langue "${preferredLang}" pour "${title}" (${versions.length} versions rejetées) — repli sur la meilleure version disponible`);
      filteredVersions = versions;
    }

    const isVO = preferredLang === 'vostfr' || preferredLang === 'en' || preferredLang === 'vo';

    // Priorité audio selon la langue demandée :
    // - Si VO / VOSTFR demandé : VOSTFR > MULTI > TRUEFRENCH > FRENCH / VF
    // - Si VF demandé : TRUEFRENCH > FRENCH / VF > VFQ > VOSTFR
    const langRank = (lbl: string) => {
      const u = lbl.toUpperCase();
      if (isVO) {
        if (u.includes('VOSTFR') || u.includes('VO')) return 1;
        if (u.includes('MULTI')) return 2;
        if (u.includes('TRUEFRENCH')) return 3;
        if (u.includes('FRENCH') || u.includes('VF')) return 4;
        return 5;
      }
      if (u.includes('TRUEFRENCH')) return 1;
      if (u.includes('FRENCH')) return 2;
      if (u.includes('VF')) return 3;
      if (u.includes('VFQ')) return 4;
      if (u.includes('VOSTFR')) return 5;
      return 6;
    };

    const savedPagePath = toRelativePath(bestUrl);

    const vidzyVersions = filteredVersions
      .filter(v => v.embedUrl.includes('vidzy'))
      .sort((a, b) => langRank(a.label) - langRank(b.label));

    for (const v of vidzyVersions) {
      const direct = await resolveVidzyDirectStream(v.embedUrl);
      if (direct?.streamUrl) {
        if (strictLang && !isLanguageCompatible(preferredLang, { titre: bestTitle, lien: direct.streamUrl })) {
          console.log(`[FrenchStream HQ] Flux direct ignoré (incompatible avec lang=${preferredLang}): ${direct.streamUrl.slice(0, 70)}...`);
          continue;
        }
        console.log(`[FrenchStream HQ] Flux direct 1080p résolu (${v.label}) [isVO=${isVO}]: ${direct.streamUrl.slice(0, 70)}...`);
        return {
          title: resolvedTitle || bestTitle,
          quality: '1080p',
          fileSize: direct.fileSize,
          streamUrl: direct.streamUrl,
          embedUrl: v.embedUrl,
          pagePath: savedPagePath,
          source: 'frenchstream'
        };
      }
    }

    // 2. Tenter la résolution directe alternative (Uqload HLS / Doodstream) si Vidzy indisponible
    const otherDirectVersions = filteredVersions
      .filter(v => !v.embedUrl.includes('vidzy') && (v.embedUrl.includes('uqload') || v.embedUrl.includes('dood')))
      .sort((a, b) => langRank(a.label) - langRank(b.label));

    for (const v of otherDirectVersions) {
      try {
        const direct = await DirectScraper.resolve(v.embedUrl);
        if (direct?.directUrl) {
          if (strictLang && !isLanguageCompatible(preferredLang, { titre: bestTitle, lien: direct.directUrl })) {
            console.log(`[FrenchStream HQ] Flux direct alternatif ignoré (incompatible avec lang=${preferredLang}): ${direct.directUrl.slice(0, 70)}...`);
            continue;
          }
          console.log(`[FrenchStream HQ] Flux direct alternatif résolu (${v.label}): ${direct.directUrl.slice(0, 70)}...`);
          return {
            title: resolvedTitle || bestTitle,
            quality: '1080p',
            fileSize: '1080p Full HD',
            streamUrl: direct.directUrl,
            embedUrl: v.embedUrl,
            pagePath: savedPagePath,
            source: 'frenchstream'
          };
        }
      } catch (_) {}
    }

    // 3. Hôtes restants (VOE et clones, /e/<code>) : tentative générique —
    //    extraire le lien direct plutôt que de servir le lecteur (et ses pubs).
    const restVersions = filteredVersions
      .filter(v => !v.embedUrl.includes('vidzy') && !v.embedUrl.includes('uqload') && !v.embedUrl.includes('dood'))
      .sort((a, b) => langRank(a.label) - langRank(b.label));

    for (const v of restVersions.slice(0, 3)) {
      try {
        const direct = await DirectScraper.resolve(v.embedUrl);
        if (direct?.directUrl) {
          if (strictLang && !isLanguageCompatible(preferredLang, { titre: `${bestTitle} ${v.label}`, lien: direct.directUrl })) {
            console.log(`[FrenchStream HQ] Lecteur générique ignoré (incompatible avec lang=${preferredLang}): ${direct.directUrl.slice(0, 70)}...`);
            continue;
          }
          console.log(`[FrenchStream HQ] Lecteur générique résolu (${v.label}): ${direct.directUrl.slice(0, 70)}...`);
          return {
            title: resolvedTitle || bestTitle,
            quality: '1080p',
            fileSize: '1080p Full HD',
            streamUrl: direct.directUrl,
            embedUrl: v.embedUrl,
            pagePath: savedPagePath,
            source: 'frenchstream'
          };
        }
      } catch (_) {}
    }

    const sortedVersions = [...filteredVersions].sort((a, b) => langRank(a.label) - langRank(b.label));

    const chosenVersion = sortedVersions[0];
    if (chosenVersion?.embedUrl) {
      console.log(`[FrenchStream HQ] Lecteur embed sélectionné (${chosenVersion.label}): ${chosenVersion.embedUrl}`);
      return {
        title: resolvedTitle || bestTitle,
        quality: '1080p',
        fileSize: '1080p Full HD',
        streamUrl: chosenVersion.embedUrl,
        embedUrl: chosenVersion.embedUrl,
        pagePath: savedPagePath,
        source: 'frenchstream'
      };
    }

    return null;
  } catch (error: any) {
    console.error(`[FrenchStream HQ] Erreur résolution film "${title}":`, error.message);
    return null;
  }
}



/**
 * Extrait les lecteurs pour un épisode spécifique d'une série
 */
export async function extractEpisodeEmbedVersions(
  pageUrl: string,
  targetEpisode: number
): Promise<{ title: string; versions: FrenchStreamVersion[] }> {
  try {
    const { data: html } = await axios.get(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${BASE_URL}/`
      },
      timeout: 15000
    });

    const titleMatch = html.match(/<h1[^>]*id="s-title"[^>]*>([\s\S]*?)<\/h1>/i);
    const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const newsIdMatch = pageUrl.match(/\/(\d+)-/i) || html.match(/dle_news_id\s*=\s*['"](\d+)['"]/i);
    const isPageVostfr = /-vostfr\.html/i.test(pageUrl) || /\bVOSTFR\b/i.test(rawTitle);

    const versions: FrenchStreamVersion[] = [];

    // 1. Interroger en priorité les endpoints de données séries de FrenchStream (/static/series/N.js, /data/eps_N.txt, /ep-data.php)
    if (newsIdMatch && newsIdMatch[1]) {
      const newsId = newsIdMatch[1];
      const preferredHosts = ['vidzy', 'uqload', 'premium', 'dood', 'voe', 'netu', 'filmoon'];
      const candidates = [
        `${BASE_URL}/static/series/${newsId}.js`,
        `${BASE_URL}/data/eps_${newsId}.txt`,
        `${BASE_URL}/ep-data.php?id=${newsId}`
      ];

      let seriesData: any = null;
      for (const candUrl of candidates) {
        try {
          const { data } = await axios.get(candUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Referer': pageUrl },
            timeout: 8000
          });
          if (data) {
            seriesData = typeof data === 'string' ? JSON.parse(data) : data;
            break;
          }
        } catch (_) {}
      }

      if (seriesData && typeof seriesData === 'object') {
        const langKeys = ['vf', 'vostfr', 'vo'];
        for (const lang of langKeys) {
          const epObj = seriesData[lang]?.[String(targetEpisode)] || seriesData[lang]?.[targetEpisode];
          if (epObj && typeof epObj === 'object') {
            const hosts = Object.keys(epObj).sort((a, b) => {
              const idxA = preferredHosts.indexOf(a.toLowerCase());
              const idxB = preferredHosts.indexOf(b.toLowerCase());
              const scoreA = idxA === -1 ? 99 : idxA;
              const scoreB = idxB === -1 ? 99 : idxB;
              return scoreA - scoreB;
            });

            for (const h of hosts) {
              const u = epObj[h];
              if (u && typeof u === 'string') {
                // Le bucket de données est la source de vérité : la clé "vf"
                // contient du VF. isPageVostfr porte sur la page entière (un
                // simple lien VOSTFR suffit à le déclencher) et ne doit donc
                // jamais re-étiqueter les versions VF en VOSTFR.
                const langLabel = lang.toUpperCase();
                versions.push({ label: `${h.toUpperCase()} (${langLabel})`, embedUrl: u });
              }
            }
          }
        }
      }

      // 2. Fallback film_api.php si aucune version trouvée
      if (versions.length === 0) {
        try {
          const apiUrl = `${BASE_URL}/engine/ajax/film_api.php?id=${newsId}&episode=${targetEpisode}`;
          const { data: apiData } = await axios.get(apiUrl, {
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': pageUrl
            },
            timeout: 10000
          });

          if (apiData?.players && typeof apiData.players === 'object') {
            const allHosts = Object.keys(apiData.players).sort((a, b) => {
              const idxA = preferredHosts.indexOf(a.toLowerCase());
              const idxB = preferredHosts.indexOf(b.toLowerCase());
              const scoreA = idxA === -1 ? 99 : idxA;
              const scoreB = idxB === -1 ? 99 : idxB;
              return scoreA - scoreB;
            });

            for (const host of allHosts) {
              const playerData = apiData.players[host];
              if (!playerData || typeof playerData !== 'object') continue;

              const variants = [
                { key: 'vff', label: `${host.toUpperCase()} (TRUEFRENCH)` },
                { key: 'vf', label: `${host.toUpperCase()} (VF)` },
                { key: 'vfq', label: `${host.toUpperCase()} (VFQ)` },
                { key: 'default', label: isPageVostfr && !playerData.vf && !playerData.vff ? `${host.toUpperCase()} (VOSTFR)` : `${host.toUpperCase()} (FRENCH)` },
                { key: 'vostfr', label: `${host.toUpperCase()} (VOSTFR)` },
              ];

              const addedUrls = new Set<string>();
              for (const v of variants) {
                const url = playerData[v.key];
                if (url && typeof url === 'string' && !addedUrls.has(url)) {
                  addedUrls.add(url);
                  versions.push({ label: v.label, embedUrl: url });
                }
              }
            }
          }
        } catch (apiErr: any) {
          console.error(`[FrenchStream] Erreur film_api.php série id=${newsId} ep=${targetEpisode}:`, apiErr.message);
        }
      }
    }

    // 3. Si aucune version trouvée via l'API, chercher dans le HTML les sélecteurs d'options
    if (versions.length === 0) {
      const optionRegex = /<(?:div|li|a|span|button)[^>]+(?:data-url|data-src|data-link)="([^"]+)"[^>]*>([\s\S]*?)<\/(?:div|li|a|span|button)>/gi;
      let match;
      while ((match = optionRegex.exec(html)) !== null) {
        const embedUrl = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, '').replace(/Télécharger en /i, '').trim();
        const label = rawText || `Episode ${targetEpisode}`;
        versions.push({ label, embedUrl });
      }
    }

    // 4. Recherche d'iframes directes dans la page épisode
    if (versions.length === 0) {
      const iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
      let ifrMatch;
      while ((ifrMatch = iframeRegex.exec(html)) !== null) {
        const ifrSrc = ifrMatch[1];
        if (/vidzy|uqload|dood|voe|streamtape|filmoon/i.test(ifrSrc)) {
          if (!versions.some(v => v.embedUrl === ifrSrc)) {
            versions.push({ label: `Episode ${targetEpisode} (Lecteur Direct)`, embedUrl: ifrSrc });
          }
        }
      }
    }

    // 5. Recherche globale d'embeds connus dans le HTML
    if (versions.length === 0) {
      const genericHostRegex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:uqload\.[a-z]+|vidzy\.[a-z]+|dood\.[a-z]+|doodstream\.[a-z]+|voe\.[a-z]+|streamtape\.[a-z]+)\/(?:embed-|e\/|d\/)[a-zA-Z0-9_-]+(?:\.html)?/gi;
      let hostMatch;
      const seen = new Set<string>();
      while ((hostMatch = genericHostRegex.exec(html)) !== null) {
        const foundUrl = hostMatch[0];
        if (!seen.has(foundUrl)) {
          seen.add(foundUrl);
          versions.push({ label: `Episode ${targetEpisode} (Détecté)`, embedUrl: foundUrl });
        }
      }
    }

    return { title: rawTitle, versions };
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur extraction épisode ${pageUrl}:`, error.message);
    return { title: '', versions: [] };
  }
}

/**
 * Recherche et résout directement un épisode de série en Haute Résolution (1080p)
 */
export async function getFrenchStreamEpisode(
  title: string,
  season: number = 1,
  episode: number = 1,
  preferredLang: 'fr' | 'vostfr' | 'en' | 'vo' = 'fr',
  knownPagePath?: string,
  originalTitle?: string,
  frenchTitle?: string
): Promise<FrenchStreamDirectResult | null> {
  try {
    const targetSeason = season > 0 ? season : 1;
    const targetEp = episode > 0 ? episode : 1;

    let bestUrl = '';
    let bestTitle = title;
    let versions: FrenchStreamVersion[] = [];
    let resolvedTitle = '';

    // Une page film mémorisée sur une fiche série (le film « Bleach » 2018 a été
    // gardé comme page de la série) ne doit jamais servir un épisode.
    const cachedPagePath = knownPagePath && SAISON_RE.test(knownPagePath) ? knownPagePath : undefined;
    if (knownPagePath && !cachedPagePath) {
      console.log(`[FrenchStream HQ] [Direct Cache] Page mémorisée « ${knownPagePath} » = film, ignorée pour un épisode.`);
    }

    // 1. Tenter l'accès direct via pagePath connu en DB si disponible
    if (cachedPagePath) {
      const fullKnownUrl = cachedPagePath.startsWith('http')
        ? cachedPagePath
        : `${BASE_URL}${cachedPagePath.startsWith('/') ? '' : '/'}${cachedPagePath}`;
      console.log(`[FrenchStream HQ] [Direct Cache] Tentative directe série sur page mémorisée: ${fullKnownUrl} Ep ${targetEp}`);
      try {
        const directExtracted = await extractEpisodeEmbedVersions(fullKnownUrl, targetEp);
        if (directExtracted.versions.length > 0) {
          bestUrl = fullKnownUrl;
          bestTitle = directExtracted.title || title;
          resolvedTitle = directExtracted.title;
          versions = directExtracted.versions;
          console.log(`[FrenchStream HQ] [Direct Cache] ${versions.length} versions série trouvées directement sans recherche !`);
        } else {
          console.log(`[FrenchStream HQ] [Direct Cache] Aucune version série sur la page mémorisée, bascule vers recherche.`);
        }
      } catch (err: any) {
        console.warn(`[FrenchStream HQ] [Direct Cache] Échec page mémorisée série (${err.message}), fallback recherche.`);
      }
    }

    // 2. Si pas de page connue ou si elle n'a rien renvoyé, effectuer la recherche par titre (FR puis EN)
    if (versions.length === 0) {
      const seriesQueries = [
        frenchTitle,
        title,
        originalTitle
      ].filter(Boolean) as string[];

      const uniqueSeriesQueries: string[] = [];
      const seen = new Set<string>();
      for (const q of seriesQueries) {
        const norm = normalize(q);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          uniqueSeriesQueries.push(q);
        }
      }

      console.log(`[FrenchStream HQ] Recherche série 1080p: [${uniqueSeriesQueries.map(q => `"${q}"`).join(', ')}] S${targetSeason}E${targetEp} (lang=${preferredLang})`);

      let seriesResults: FrenchStreamSearchResult[] = [];

      for (const sTitle of uniqueSeriesQueries) {
        const seasonQuery = `${sTitle} Saison ${targetSeason}`;
        let searchResults = await searchFrenchStream(seasonQuery);
        if (!searchResults.some(isSeriesPage)) {
          searchResults = [...searchResults, ...(await searchFrenchStream(sTitle))];
        }
        const filtered = searchResults.filter(isSeriesPage);
        if (filtered.length > 0) {
          seriesResults = filtered;
          break;
        }
      }

      if (seriesResults.length === 0) {
        console.log(`[FrenchStream HQ] Aucune page série pour [${uniqueSeriesQueries.join(', ')}] sur FrenchStream.`);
        return null;
      }

      const relevant = seriesResults.filter((it) => {
        return uniqueSeriesQueries.some(q => isCandidateMatching(it.title, [q]));
      });
      const pool = relevant.length > 0 ? relevant : seriesResults;

      // Saison annoncée exacte d'abord, sinon la page de saison la plus proche :
      // les animés sont découpés en arcs « Saison N » qui ne suivent pas la
      // numérotation TMDB.
      const best =
        pool.find((it) => saisonOf(it.title) === targetSeason || saisonOf(it.url) === targetSeason) ??
        pool.reduce(
          (a, b) =>
            Math.abs((saisonOf(b.title ?? '') ?? 0) - targetSeason) <
            Math.abs((saisonOf(a.title ?? '') ?? 0) - targetSeason)
              ? b
              : a,
          pool[0]
        );

      console.log(`[FrenchStream HQ] Page série trouvée: ${best.url} (${best.title})`);
      bestUrl = best.url;
      bestTitle = best.title;
      const extracted = await extractEpisodeEmbedVersions(best.url, targetEp);
      resolvedTitle = extracted.title;
      versions = extracted.versions;
    }

    if (versions.length === 0) {
      console.log(`[FrenchStream HQ] Aucune version pour "${title}" S${targetSeason}E${targetEp}`);
      return null;
    }

    let filteredVersions = versions.filter(v =>
      isLanguageCompatible(preferredLang, {
        titre: bestTitle,
        lien: v.embedUrl,
        langueAudio: v.label.includes('VOSTFR') ? 'VOSTFR' : (v.label.includes('VF') || v.label.includes('FRENCH') || v.label.includes('TRUEFRENCH')) ? 'VF' : undefined,
      })
    );

    const strictLang = filteredVersions.length > 0;
    if (!strictLang) {
      console.log(`[FrenchStream HQ] Aucune version série compatible avec la langue "${preferredLang}" pour "${title}" S${targetSeason}E${targetEp} — repli sur la meilleure version disponible (${versions.length} trouvée(s))`);
      filteredVersions = versions;
    }

    const isVO = preferredLang === 'vostfr' || preferredLang === 'en' || preferredLang === 'vo';
    const langRank = (lbl: string) => {
      const u = lbl.toUpperCase();
      if (isVO) {
        if (u.includes('VOSTFR') || u.includes('VO')) return 1;
        if (u.includes('MULTI')) return 2;
        if (u.includes('TRUEFRENCH')) return 3;
        if (u.includes('FRENCH') || u.includes('VF')) return 4;
        return 5;
      }
      if (u.includes('TRUEFRENCH')) return 1;
      if (u.includes('FRENCH')) return 2;
      if (u.includes('VF')) return 3;
      if (u.includes('VFQ')) return 4;
      if (u.includes('VOSTFR')) return 5;
      return 6;
    };

    const savedPagePath = toRelativePath(bestUrl);

    // 1. Tenter la résolution directe haute performance (Vidzy MP4 en priorité, puis Uqload / Dood)
    const directCandidates = filteredVersions
      .filter((v) => v.embedUrl.includes('vidzy') || v.embedUrl.includes('uqload') || v.embedUrl.includes('dood'))
      .sort((a, b) => {
        const hostRank = (u: string) => (u.includes('vidzy') ? 1 : u.includes('uqload') ? 2 : 3);
        const diffHost = hostRank(a.embedUrl) - hostRank(b.embedUrl);
        if (diffHost !== 0) return diffHost;
        return langRank(a.label) - langRank(b.label);
      });

    for (const v of directCandidates) {
      try {
        const direct = await DirectScraper.resolve(v.embedUrl);
        if (direct?.directUrl) {
          if (strictLang && !isLanguageCompatible(preferredLang, { titre: bestTitle, lien: direct.directUrl })) {
            continue;
          }
          console.log(`[FrenchStream HQ] Flux série direct résolu (${v.label}): ${direct.directUrl.slice(0, 70)}...`);
          return {
            title: resolvedTitle || `${bestTitle} S${targetSeason}E${targetEp}`,
            quality: '1080p',
            fileSize: '1080p Full HD',
            streamUrl: direct.directUrl,
            embedUrl: v.embedUrl,
            pagePath: savedPagePath,
            source: 'frenchstream'
          };
        }
      } catch (_) {}
    }

    // 2. Fallback embed si aucune extraction directe n'a abouti
    const sortedVersions = [...filteredVersions].sort((a, b) => langRank(a.label) - langRank(b.label));
    const chosen = sortedVersions[0];
    if (chosen?.embedUrl) {
      console.log(`[FrenchStream HQ] Lecteur embed série sélectionné (${chosen.label}): ${chosen.embedUrl}`);
      return {
        title: resolvedTitle || `${bestTitle} S${targetSeason}E${targetEp}`,
        quality: '1080p',
        fileSize: '1080p Full HD',
        streamUrl: chosen.embedUrl,
        embedUrl: chosen.embedUrl,
        pagePath: savedPagePath,
        source: 'frenchstream'
      };
    }

    return null;
  } catch (error: any) {
    console.error(`[FrenchStream HQ] Erreur série pour "${title}":`, error.message);
    return null;
  }
}
