import axios from 'axios';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

const BASE_URL = 'https://www.open-otaku.me';

let scrapeInProgress = false;

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function toDownloadUrl(url: string): string {
  if (!url) return '';
  if (url.includes('vidzy.')) return url.replace('/embed-', '/d/').replace('.html', '_n.html');
  if (url.includes('luluvid.')) return url.replace('/embed-', '/d/').replace('.html', '');
  return url;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, params: any, retries = 3, delayMs = 3000): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(url, {
        params,
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      return data;
    } catch (err: any) {
      const is429 = err?.response?.status === 429 || err?.message?.includes('429');
      if (is429 && attempt < retries) {
        const wait = delayMs * attempt;
        console.log(`[Otaku Service] [429 RateLimit] Pause ${wait / 1000}s avant retry...`);
        await sleep(wait);
        continue;
      }
      if (attempt === retries) throw err;
      await sleep(1000 * attempt);
    }
  }
  return null;
}

async function getDirectLink(embedUrl: string): Promise<string | null> {
  try {
    const dlUrl = toDownloadUrl(embedUrl);
    if (!dlUrl) return null;
    const data = await fetchWithRetry(`${BASE_URL}/api/dl`, { url: dlUrl });
    return data?.success && data?.downloadUrl ? data.downloadUrl : null;
  } catch {
    return null;
  }
}

export interface OtakuResult {
  titre: string;
  lien: string;
  source: 'otaku';
}

export async function searchOtaku(title: string, type: 'movie' | 'series' = 'movie'): Promise<OtakuResult | null> {
  try {
    console.log(`[Otaku Direct API] Searching "${title}" (type: ${type})`);
    
    // 1. Recherche directe via l'API interne d'OpenOtaku
    const data = await fetchWithRetry(`${BASE_URL}/api/fs-search`, { q: title });

    const results: Array<{ id: string; title: string; poster?: string }> = data?.results || [];
    if (results.length === 0) {
      console.log(`[Otaku] Aucun résultat trouvé pour "${title}"`);
      return null;
    }

    // 2. Trouver la meilleure correspondance de titre
    let bestItem = results[0];
    let bestScore = 0;
    const searchNorm = normalize(title);

    for (const item of results) {
      const itemNorm = normalize(item.title || '');
      if (itemNorm === searchNorm || itemNorm.includes(searchNorm) || searchNorm.includes(itemNorm)) {
        bestItem = item;
        bestScore = 1;
        break;
      }
      if (itemNorm.slice(0, 10) === searchNorm.slice(0, 10)) {
        bestItem = item;
        bestScore = 0.5;
      }
    }

    if (bestScore === 0) {
      console.log(`[Otaku] Pas de correspondance exacte pour "${title}", premier résultat utilisé : ${bestItem.title}`);
    }

    // 3. Récupérer les détails de visionnage (players / épisodes)
    const watch = await fetchWithRetry(`${BASE_URL}/api/fs-watch`, { id: bestItem.id });

    const detailTitle = watch?.meta?.title || bestItem.title || title;

    if (type === 'series') {
      const rawEps = watch?.episodes || {};
      const vfMap = rawEps.vf || {};
      const vostfrMap = rawEps.vostfr || {};
      const version = Object.keys(vfMap).length > 0 ? vfMap : vostfrMap;
      const firstEpKey = Object.keys(version)[0] || '1';
      const players = version[firstEpKey] || {};
      const embedUrl = players.vidzy || players.luluvid || (Object.values(players)[0] as string) || '';
      
      if (embedUrl) {
        const link = await getDirectLink(embedUrl);
        if (link) {
          return { titre: detailTitle, lien: link, source: 'otaku' };
        }
      }
    } else {
      const players = watch?.players || {};
      const embedUrl =
        players.vidzy?.default ||
        players.vidzy?.vff ||
        players.vidzy?.vf ||
        players.vidzy?.vostfr ||
        players.premium?.default ||
        (Object.values(players)[0] as any)?.default ||
        '';

      if (embedUrl) {
        const link = await getDirectLink(embedUrl);
        if (link) {
          return { titre: detailTitle, lien: link, source: 'otaku' };
        }
      }
    }

    console.log(`[Otaku] Lien direct non trouvé pour "${title}"`);
    return null;
  } catch (err: any) {
    console.error(`[Otaku] Erreur recherche API pour "${title}":`, err.message);
    return null;
  }
}

export async function getSpecificEpisodeLink(
  page: any,
  episodeNumber: string,
  previousLink?: string | null,
  seriesIdOrTitle?: string
): Promise<string | null> {
  try {
    const targetTitle = seriesIdOrTitle || (page?.url ? new URL(page.url()).searchParams.get('watch_fs') : null);
    if (!targetTitle) return null;

    let fsId = targetTitle;
    if (isNaN(Number(targetTitle))) {
      const { data } = await axios.get(`${BASE_URL}/api/fs-search`, {
        params: { q: targetTitle },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      fsId = data?.results?.[0]?.id;
    }

    if (!fsId) return null;

    const { data: watch } = await axios.get(`${BASE_URL}/api/fs-watch`, {
      params: { id: fsId },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const rawEps = watch?.episodes || {};
    const vfMap = rawEps.vf || {};
    const vostfrMap = rawEps.vostfr || {};
    const version = Object.keys(vfMap).length > 0 ? vfMap : vostfrMap;
    const epNumOnly = episodeNumber.replace(/\D/g, '') || '1';
    const players = version[epNumOnly] || Object.values(version)[0] || {};
    const embedUrl = (players as any).vidzy || (players as any).luluvid || (Object.values(players)[0] as string) || '';

    if (embedUrl) {
      return await getDirectLink(embedUrl);
    }
    return null;
  } catch (err: any) {
    console.error(`[Otaku] Erreur getSpecificEpisodeLink:`, err.message);
    return null;
  }
}

export async function searchAndNavigateToSeries(page: any, title: string): Promise<boolean> {
  return true;
}

export async function searchAndCache(
  title: string,
  type: 'movie' | 'series' = 'movie'
): Promise<OtakuResult | null> {
  if (scrapeInProgress) {
    console.log(`[Otaku] Scrape déjà en cours, skip "${title}"`);
    return null;
  }

  scrapeInProgress = true;
  try {
    const result = await searchOtaku(title, type);
    if (result) {
      if (type === 'series') {
        const existing = await Serie.findOne({ titre: result.titre });
        if (!existing) {
          await Serie.create({
            titre: result.titre,
            pageUrl: '',
            episodes: [{ episode: 'Ép 1', lien: result.lien }]
          });
          console.log(`[Otaku] Série mise en cache : ${result.titre}`);
        }
      } else {
        const existing = await Movie.findOne({ titre: result.titre });
        if (!existing) {
          await Movie.create({
            titre: result.titre,
            pageUrl: '',
            lien: result.lien
          });
          console.log(`[Otaku] Film mis en cache : ${result.titre}`);
        }
      }
    }
    return result;
  } finally {
    scrapeInProgress = false;
  }
}

