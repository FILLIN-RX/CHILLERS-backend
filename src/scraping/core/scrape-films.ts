import axios from 'axios';
import mongoose from 'mongoose';
import Movie from '../../models/Movie';
import ScraperState from '../../models/ScraperState';
import { connectDB } from '../../config/db';
import { reuploadMovie } from '../../modules/reupload/reupload';
import { autoLink } from '../maintenance/auto-link';

const BASE_URL = 'https://www.open-otaku.me';
const MAX_EMPTY_RETRIES = 10;
const CONCURRENCY = 3;

interface FsItem {
    id: string;
    title: string;
    poster?: string;
    quality?: string;
    version?: string;
    description?: string;
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

async function resolveBestFilmLink(players: Record<string, any>): Promise<string | null> {
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

    for (const u of candidateUrls) {
        const direct = await getDirectLink(u);
        if (direct) return direct;
    }

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
                console.log(`[ScrapeFilms] [429 RateLimit] Pause de ${wait / 1000}s avant retry (tentative ${attempt}/${retries})...`);
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

async function fetchFilmsPage(page: number): Promise<FsItem[]> {
    try {
        const data = await fetchWithRetry(`${BASE_URL}/api/fs-home`, { category: 'films', page });
        return Array.isArray(data?.items) ? data.items : [];
    } catch (err: any) {
        console.error(`[ScrapeFilms] Erreur fetch page ${page}:`, err.message);
        return [];
    }
}

async function fetchWatchDetails(id: string): Promise<any> {
    try {
        const data = await fetchWithRetry(`${BASE_URL}/api/fs-watch`, { id });
        return data || {};
    } catch (err: any) {
        console.error(`[ScrapeFilms] Erreur fetch fs-watch (${id}):`, err.message);
        return null;
    }
}

async function getLastPage(): Promise<number> {
    try {
        const state = await ScraperState.findOne({ name: 'films' });
        return state ? state.lastPage : 1;
    } catch {
        return 1;
    }
}

async function saveLastPage(page: number) {
    await ScraperState.findOneAndUpdate(
        { name: 'films' },
        { $set: { lastPage: page, updatedAt: new Date() } },
        { upsert: true }
    );
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function processFilm(item: FsItem): Promise<void> {
    const titre = item.title.trim();
    const ficheUrl = `${BASE_URL}/?watch_fs=${item.id}`;

    try {
        console.log(`[ScrapeFilms] Traitement : ${titre} (ID: ${item.id})`);
        const watch = await fetchWatchDetails(item.id);
        if (!watch) {
            console.log(`[ScrapeFilms] ⚠️ Données introuvables pour : ${titre}`);
            return;
        }

        const directLink = await resolveBestFilmLink(watch.players || {});

        if (!directLink) {
            console.log(`[ScrapeFilms] ⚠️ Aucun lecteur ou lien direct exploitable pour : ${titre}`);
            return;
        }

        const movieDoc = await Movie.findOneAndUpdate(
            { titre },
            {
                $set: {
                    titre,
                    pageUrl: ficheUrl,
                    lien: directLink,
                    poster: item.poster || watch.meta?.poster || '',
                    description: item.description || watch.meta?.description || '',
                    qualite: item.quality || 'HD',
                    version: item.version || 'VF',
                    updatedAt: new Date()
                }
            },
            { upsert: true, new: true }
        );

        console.log(`[ScrapeFilms] ✅ Film enregistré : ${titre}`);

        if (movieDoc && !movieDoc.tmdbId) {
            try {
                autoLink('movie', String(movieDoc._id));
            } catch (err: any) {
                console.error(`[ScrapeFilms] Erreur autolink pour ${titre}:`, err.message);
            }
        }

        // Reupload Uqload + Streamtape asynchrone non-bloquant
        if (movieDoc && directLink && !movieDoc.uqloadLink && !(movieDoc as any).streamtapeCode) {
            reuploadMovie(String(movieDoc._id), directLink, titre).catch(() => {});
        }

    } catch (err: any) {
        console.error(`[ScrapeFilms] Erreur traitement film "${titre}":`, err.message);
    }
}

async function scrapeFilms() {
    console.log('[ScrapeFilms] Scraper ultra-rapide initialisé.');

    let page = await getLastPage();
    let emptyRetries = 0;

    console.log(`[ScrapeFilms] Démarrage boucle depuis la page ${page}`);

    while (true) {
        console.log(`\n--- Page ${page} ---`);
        const items = await fetchFilmsPage(page);

        if (items.length === 0) {
            emptyRetries++;
            console.log(`Page ${page} vide (tentative ${emptyRetries}/${MAX_EMPTY_RETRIES}) — attend 5s...`);
            if (emptyRetries >= MAX_EMPTY_RETRIES) {
                console.log(`Page ${page} toujours vide après ${MAX_EMPTY_RETRIES} tentatives — passage à la page suivante : ${page + 1}`);
                page++;
                await saveLastPage(page);
                emptyRetries = 0;
                continue;
            }
            await sleep(5000);
            continue;
        }

        emptyRetries = 0;
        console.log(`Films trouvés sur la page : ${items.length}`);

        const existingMovies = await Movie.find(
            { titre: { $in: items.map(i => i.title.trim()) } },
            { titre: 1, lien: 1 }
        ).lean();

        const existingMap = new Map(existingMovies.map(m => [m.titre, m]));

        const toProcess: FsItem[] = [];
        for (const item of items) {
            const titre = item.title.trim();
            const existing = existingMap.get(titre);
            if (existing && existing.lien && !existing.lien.includes('doodstream.com')) {
                console.log(`Déjà traité : ${titre}`);
            } else {
                toProcess.push(item);
            }
        }

        console.log(`Films restants à traiter : ${toProcess.length}/${items.length}`);

        for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
            const batch = toProcess.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(item => processFilm(item)));
        }

        await saveLastPage(page);
        page++;
        await sleep(1000);
    }
}

async function main() {
    await connectDB();
    await scrapeFilms();
}

if (require.main === module || process.argv[1]?.includes('scrape-films')) {
    main().catch(err => {
        console.error('[ScrapeFilms] Erreur fatale:', err);
        process.exit(1);
    });
}

export { scrapeFilms };
