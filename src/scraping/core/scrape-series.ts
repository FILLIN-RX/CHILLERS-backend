import axios from 'axios';
import mongoose from 'mongoose';
import Serie from '../../models/Serie';
import ScraperState from '../../models/ScraperState';
import { connectDB } from '../../config/db';
import { UqloadClient } from '../../modules/uqload/uqload.client';
import { reuploadEpisode } from '../../modules/reupload/reupload';
import { autoLink } from '../maintenance/auto-link';

const BASE_URL = 'https://www.open-otaku.me';
const MAX_EMPTY_RETRIES = 10;
const CONCURRENCY = 2;

interface FsItem {
    id: string;
    title: string;
    poster?: string;
    quality?: string;
    version?: string;
    description?: string;
}

function parseEpisodeLabel(label: string, defaultSeason = 1): { season: number; episodeNumber: number; canonical: string } {
    const trimmed = label.trim();
    const sxxExx = trimmed.match(/S(\d+)\s*E\s*(\d+)/i);
    if (sxxExx) {
        const season = parseInt(sxxExx[1], 10);
        const num = parseInt(sxxExx[2], 10);
        return { season, episodeNumber: num, canonical: `S${String(season).padStart(2, "0")}E${String(num).padStart(2, "0")}` };
    }
    const epWord = trimmed.match(/(?:Ép|Ep|Episode)\s*\.?\s*(\d+)/i);
    if (epWord) {
        const num = parseInt(epWord[1], 10);
        return { season: defaultSeason, episodeNumber: num, canonical: `S${String(defaultSeason).padStart(2, "0")}E${String(num).padStart(2, "0")}` };
    }
    return { season: defaultSeason, episodeNumber: 0, canonical: trimmed };
}

function toDownloadUrl(url: string): string {
    if (!url) return '';
    if (url.includes('vidzy.')) return url.replace('/embed-', '/d/').replace('.html', '_n.html');
    if (url.includes('luluvid.')) return url.replace('/embed-', '/d/').replace('.html', '');
    return url;
}

async function getDirectLink(embedUrl: string): Promise<string | null> {
    if (!embedUrl) return null;
    const dlUrl = toDownloadUrl(embedUrl);
    try {
        const { data } = await axios.get(`${BASE_URL}/api/dl`, {
            params: { url: dlUrl },
            timeout: 20000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (data?.success && data?.downloadUrl) return data.downloadUrl;
    } catch (_) {}

    if (dlUrl !== embedUrl) {
        try {
            const { data } = await axios.get(`${BASE_URL}/api/dl`, {
                params: { url: embedUrl },
                timeout: 20000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (data?.success && data?.downloadUrl) return data.downloadUrl;
        } catch (_) {}
    }

    return null;
}

async function resolveBestEpisodeLink(players: Record<string, any>): Promise<string | null> {
    if (!players || typeof players !== 'object') return null;

    const candidateUrls: string[] = [];
    const orderedKeys = ['vidzy', 'luluvid', 'premium', 'default', ...Object.keys(players)];
    const seen = new Set<string>();

    for (const key of orderedKeys) {
        const p = players[key];
        if (!p) continue;
        const urls = typeof p === 'string' ? [p] : Object.values(p);
        for (const u of urls) {
            if (typeof u === 'string' && u.startsWith('http') && !seen.has(u)) {
                seen.add(u);
                candidateUrls.push(u);
            }
        }
    }

    // 1. Tenter l'extraction MP4 directe pour chaque lecteur
    for (const u of candidateUrls) {
        const direct = await getDirectLink(u);
        if (direct) return direct;
    }

    // 2. Fallback direct sur l'URL du lecteur vidéo
    if (candidateUrls.length > 0) {
        return candidateUrls[0];
    }

    return null;
}

async function fetchWithRetry(url: string, params: any, retries = 3, delayMs = 3500): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { data } = await axios.get(url, {
                params,
                timeout: 30000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            return data;
        } catch (err: any) {
            const is429 = err?.response?.status === 429 || err?.message?.includes('429');
            if (is429 && attempt < retries) {
                const wait = delayMs * attempt;
                console.log(`[ScrapeSeries] [429 RateLimit] Pause de ${wait / 1000}s avant retry (tentative ${attempt}/${retries})...`);
                await sleep(wait);
                continue;
            }
            if (attempt === retries) {
                throw err;
            }
            await sleep(1500 * attempt);
        }
    }
    return null;
}

async function fetchSeriesPage(page: number): Promise<FsItem[]> {
    try {
        const data = await fetchWithRetry(`${BASE_URL}/api/fs-home`, { category: 'series', page });
        return Array.isArray(data?.items) ? data.items : [];
    } catch (err: any) {
        console.error(`[ScrapeSeries] Erreur fetch page ${page}:`, err.message);
        return [];
    }
}

async function fetchWatchDetails(id: string): Promise<any> {
    try {
        const data = await fetchWithRetry(`${BASE_URL}/api/fs-watch`, { id });
        return data || {};
    } catch (err: any) {
        console.error(`[ScrapeSeries] Erreur fetch fs-watch (${id}):`, err.message);
        return null;
    }
}

async function loadState(): Promise<{ lastPage: number }> {
    try {
        const state = await ScraperState.findOne({ name: 'series' });
        return { lastPage: state?.lastPage || 1 };
    } catch {
        return { lastPage: 1 };
    }
}

async function saveState(lastPage: number) {
    await ScraperState.findOneAndUpdate(
        { name: 'series' },
        { $set: { lastPage, updatedAt: new Date() } },
        { upsert: true }
    );
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function processSerie(item: FsItem, existingSeries: any, uqloadClient: UqloadClient | null): Promise<void> {
    const titre = item.title.trim();
    const ficheUrl = `${BASE_URL}/?watch_fs=${item.id}`;

    try {
        console.log(`[ScrapeSeries] Traitement : ${titre} (ID: ${item.id})`);
        const watch = await fetchWatchDetails(item.id);
        if (!watch) {
            console.log(`[ScrapeSeries] ⚠️ Données introuvables pour : ${titre}`);
            return;
        }

        let year: number | undefined;
        if (watch.meta?.year) {
            const parsed = parseInt(String(watch.meta.year), 10);
            if (parsed > 1900 && parsed < 2100) year = parsed;
        }
        if (!year) {
            const y = titre.match(/(\d{4})/);
            if (y) { const p = parseInt(y[1], 10); if (p > 1900 && p < 2100) year = p; }
        }

        const poster = watch.meta?.poster || item.poster || undefined;
        const rawEps = watch.episodes || {};
        const vfMap = rawEps.vf || {};
        const vostfrMap = rawEps.vostfr || {};
        const version = Object.keys(vfMap).length > 0 ? vfMap : vostfrMap;
        const epNumbers = Object.keys(version).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

        let episodes: Array<{ episode: string; season: number; episodeNumber: number; lien: string }> = [];

        if (existingSeries && existingSeries.episodes && existingSeries.episodes.length > 0) {
            episodes = existingSeries.episodes;
        } else {
            const seasonMatch = titre.match(/Saison\s*(\d+)/i);
            const defaultSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;

            const episodeTasks = epNumbers.map(async (num) => {
                const players = version[num] || {};
                const link = await resolveBestEpisodeLink(players);
                if (link) {
                    const { season, episodeNumber, canonical } = parseEpisodeLabel(`Épisode ${num}`, defaultSeason);
                    return { episode: canonical, season, episodeNumber, lien: link };
                }
                return null;
            });

            const resolved = await Promise.all(episodeTasks);
            episodes = resolved.filter((ep): ep is { episode: string; season: number; episodeNumber: number; lien: string } => Boolean(ep));
            for (const ep of episodes) {
                console.log(`  -> ${ep.episode} : ${ep.lien.slice(0, 70)}...`);
            }
        }

        if (episodes.length === 0) {
            console.log(`[ScrapeSeries] ⚠️ Aucun épisode extrait pour : ${titre}`);
            return;
        }

        const serieData: any = {
            titre,
            pageUrl: ficheUrl,
            episodes,
            ...(year ? { year } : {}),
            ...(poster ? { posterUrl: poster, posterSource: 'tmdb' } : {})
        };

        const saved = await Serie.findOneAndUpdate(
            { titre },
            { $set: serieData },
            { upsert: true, returnDocument: 'after' }
        );

        console.log(`[ScrapeSeries] ✅ Série enregistrée (${episodes.length} ép.) : ${titre}`);

        if (saved) {
            for (let epIdx = 0; epIdx < (saved.episodes || []).length; epIdx++) {
                const ep = saved.episodes[epIdx];
                if (!ep.lien || ep.lien === '#') continue;
                await reuploadEpisode(saved._id.toString(), ep, epIdx);
            }
            autoLink('series', saved._id.toString());
        }
    } catch (e: any) {
        console.error(`[ScrapeSeries] ❌ Erreur sur ${titre}:`, e.message);
    }
}

async function scrapeSeriesDetails() {
    console.log('[START] scrapeSeriesDetails() — connexion MongoDB...');
    await connectDB();
    console.log('[OK] Scraper Séries direct API initialisé.');

    const uqloadKey = process.env.UQLOAD_API_KEY;
    const uqloadClient = uqloadKey ? new UqloadClient(uqloadKey) : null;

    let shuttingDown = false;
    process.on('SIGTERM', async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\n[SIGTERM] Arrêt demandé, déconnexion...');
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
    });

    while (true) {
        let currentPage = (await loadState()).lastPage;
        let hasMorePages = true;

        while (hasMorePages && !shuttingDown) {
            console.log(`\n--- Page Séries ${currentPage} ---`);
            let items = await fetchSeriesPage(currentPage);

            if (items.length === 0) {
                let retries = 0;
                let pageLoaded = false;
                while (retries < MAX_EMPTY_RETRIES) {
                    retries++;
                    console.log(`Page ${currentPage} vide (tentative ${retries}/${MAX_EMPTY_RETRIES}) — attend 5s...`);
                    await sleep(5000);
                    items = await fetchSeriesPage(currentPage);
                    if (items.length > 0) {
                        pageLoaded = true;
                        break;
                    }
                }
                if (!pageLoaded) {
                    console.log(`Page ${currentPage} toujours vide après ${MAX_EMPTY_RETRIES} tentatives — passage à la page suivante : ${currentPage + 1}`);
                    currentPage++;
                    await saveState(currentPage);
                    continue;
                }
            }

            console.log(`Séries trouvées sur la page : ${items.length}`);
            const validItems = items.filter(it => it.title);
            const titles = validItems.map(it => it.title.trim());

            const existingSeriesList = await Serie.find(
                { titre: { $in: titles } },
                { titre: 1, pageUrl: 1, episodes: 1 }
            ).lean();
            const existingMap = new Map(existingSeriesList.map(s => [s.titre, s]));

            const toProcess = validItems.filter(it => {
                const existing = existingMap.get(it.title.trim());
                if (existing && existing.pageUrl && existing.episodes && existing.episodes.length > 0) {
                    console.log(`Déjà traitée et complète : ${it.title.trim()}`);
                    return false;
                }
                return true;
            });

            console.log(`Séries à traiter : ${toProcess.length}/${validItems.length}`);

            for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
                if (shuttingDown) break;
                const chunk = toProcess.slice(i, i + CONCURRENCY);
                await Promise.all(chunk.map(it => processSerie(it, existingMap.get(it.title.trim()), uqloadClient)));
            }

            currentPage++;
            await saveState(currentPage);
        }

        console.log("[ScrapeSeries] Cycle terminé, redémarrage dans 10s...");
        await sleep(10000);
    }
}

export { scrapeSeriesDetails as scrapeSeries };

if (process.argv[1] && (process.argv[1].includes('scrape-series') || process.argv[1].endsWith('scrape-series.ts') || process.argv[1].endsWith('scrape-series.js'))) {
    (async () => {
        while (true) {
            try {
                await scrapeSeriesDetails();
            } catch (err: any) {
                console.log(`[ScrapeSeries] Crash: ${err?.message || err} — redémarrage dans 10s...`);
                await sleep(10000);
            }
        }
    })();
}
