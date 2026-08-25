import axios from 'axios';
import mongoose from 'mongoose';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import ScraperState from '../../models/ScraperState';
import { connectDB } from '../../config/db';
import { reuploadEpisode } from '../../modules/reupload/reupload';
import { reuploadMovie } from '../../modules/reupload/reupload';
import { autoLink } from '../maintenance/auto-link';

const BASE_URL = 'https://www.open-otaku.me';

interface AnimeCategory { text: string; href: string; }
interface AnimeItem {
    newsId: string;
    title: string;
    poster: string;
    version: string;
    episodes: string;
    type: string;
    url: string;
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

/**
 * Même transformation que le site (getDownloadUrl dans app.js) :
 * vidzy : /embed-xxx.html → /d/xxx_n.html
 * luluvid : /embed-xxx.html → /d/xxx
 */
function toDownloadUrl(url: string): string {
    if (!url) return '';
    if (url.includes('vidzy.')) return url.replace('/embed-', '/d/').replace('.html', '_n.html');
    if (url.includes('luluvid.')) return url.replace('/embed-', '/d/').replace('.html', '');
    return url;
}

async function getDirectLink(embedUrl: string): Promise<string | null> {
    const dlUrl = toDownloadUrl(embedUrl);
    const { data } = await axios.get(`${BASE_URL}/api/dl`, { params: { url: dlUrl }, timeout: 60000 });
    if (data && data.success && data.downloadUrl) return data.downloadUrl;
    return null;
}

/**
 * Détecte si l'anime est un film ou une série.
 * Le champ `status` de /api/anime est la source fiable : "Film" → film,
 * "En cours" / "Terminé" → série. Le champ `episodes` de la liste du
 * dropdown ("1 / 1" → film) sert de pré-détection quand l'API détail n'est
 * pas dispo.
 */
function detectKind(item: AnimeItem, meta?: { status?: string }): 'movie' | 'series' {
    if (meta && meta.status) {
        if (meta.status.toLowerCase() === 'film') return 'movie';
        return 'series';
    }
    const eps = (item.episodes || '').trim();
    if (item.type === 'film' || item.type === 'movie') return 'movie';
    if (eps === '1 / 1' || eps === '1') return 'movie';
    return 'series';
}

async function fetchCategories(): Promise<AnimeCategory[]> {
    const { data } = await axios.get(`${BASE_URL}/api/anime-categories`, { timeout: 30000 });
    return (data && data.categories) || [];
}

async function fetchCategoryPage(path: string, page: number): Promise<AnimeItem[]> {
    const { data } = await axios.get(`${BASE_URL}/api/anime-category`, {
        params: { path, page },
        timeout: 30000,
    });
    return (data && data.results) || [];
}

async function fetchAnimeEpisodes(id: string): Promise<{ vf: Record<string, Record<string, string>>; vostfr: Record<string, Record<string, string>> }> {
    const { data } = await axios.get(`${BASE_URL}/api/episodes`, { params: { id }, timeout: 30000 });
    return { vf: (data && data.vf) || {}, vostfr: (data && data.vostfr) || {} };
}

async function fetchAnimeMeta(id: string): Promise<{ title: string; status?: string; year?: number; poster?: string; synopsis?: string }> {
    const { data } = await axios.get(`${BASE_URL}/api/anime`, { params: { id }, timeout: 30000 });
    return data || {};
}

async function loadState(): Promise<{ lastCatIndex: number; lastPage: number }> {
    try {
        const state = await ScraperState.findOne({ name: 'animes' });
        const raw = state?.lastPage || 1;
        return { lastCatIndex: Math.floor(raw / 10000), lastPage: raw % 10000 };
    } catch {
        return { lastCatIndex: 0, lastPage: 1 };
    }
}

async function saveState(catIndex: number, page: number) {
    await ScraperState.findOneAndUpdate(
        { name: 'animes' },
        { $set: { lastPage: catIndex * 10000 + page, updatedAt: new Date() } },
        { upsert: true }
    );
}

async function processItem(item: AnimeItem, kind: 'movie' | 'series') {
    const titre = item.title.trim();
    console.log(`\n[${kind.toUpperCase()}] ${titre} (${item.newsId})`);

    if (kind === 'movie') {
        const existing = await Movie.findOne({ titre });
        if (existing && existing.pageUrl && existing.lien) {
            console.log(`  ⏭ Film déjà traité : ${titre}`);
            return;
        }
    } else {
        const existing = await Serie.findOne({ titre });
        if (existing && existing.pageUrl && existing.episodes && existing.episodes.length > 0) {
            console.log(`  ⏭ Série déjà traitée : ${titre}`);
            return;
        }
    }

    const meta = await fetchAnimeMeta(item.newsId);
    const resolvedKind = detectKind(item, meta);
    if (resolvedKind !== kind) {
        console.log(`  ↻ Reclassé : ${kind} → ${resolvedKind}`);
        const recheck = resolvedKind === 'movie'
            ? await Movie.findOne({ titre }).lean()
            : await Serie.findOne({ titre }).lean();
        if (resolvedKind === 'movie' && recheck && (recheck as any).lien) {
            console.log(`  ⏭ Film déjà traité : ${titre}`);
            return;
        }
        if (resolvedKind === 'series' && recheck && (recheck as any).episodes?.length > 0) {
            console.log(`  ⏭ Série déjà traitée : ${titre}`);
            return;
        }
    }
    kind = resolvedKind;

    const { vf, vostfr } = await fetchAnimeEpisodes(item.newsId);
    // Priorité à la version VF, sinon VOSTFR
    const version = Object.keys(vf).length > 0 ? vf : vostfr;
    const epNumbers = Object.keys(version).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    if (epNumbers.length === 0) {
        console.log(`  ⏭ Aucun épisode trouvé : ${titre}`);
        return;
    }

    const seasonMatch = titre.match(/Saison\s*(\d+)/i);
    const defaultSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;

    const ficheUrl = `${BASE_URL}/index.php?newsid=${item.newsId}`;
    const episodes: Array<{ episode: string; season: number; episodeNumber: number; lien: string }> = [];

    for (const num of epNumbers) {
        const players = version[num] || {};
        // vidzy en priorité (l'API /api/dl accepte ses URLs transformées)
        const embedUrl = players.vidzy || players.luluvid || Object.values(players)[0] || '';
        if (!embedUrl) continue;

        const link = await getDirectLink(embedUrl);
        if (link) {
            const { season, episodeNumber, canonical } = parseEpisodeLabel(`Épisode ${num}`, defaultSeason);
            episodes.push({ episode: canonical, season, episodeNumber, lien: link });
            console.log(`    -> ${canonical} : ${link.slice(0, 90)}...`);
        } else {
            console.log(`    -> ⏭ Lien introuvable pour l'épisode ${num} (${embedUrl})`);
        }
    }

    if (episodes.length === 0) {
        console.log(`  ⏭ Aucun lien récupéré : ${titre}`);
        return;
    }

    const poster = meta.poster || item.poster || undefined;
    const year = typeof meta.year === 'number' ? meta.year : undefined;

    if (kind === 'movie') {
        const saved = await Movie.findOneAndUpdate(
            { titre },
            {
                $set: {
                    titre,
                    pageUrl: ficheUrl,
                    lien: episodes[0].lien,
                    year,
                    posterUrl: poster,
                    posterSource: poster ? 'tmdb' : undefined,
                },
            },
            { upsert: true, returnDocument: 'after' }
        );
        console.log(`  ✅ Film enregistré : ${titre}`);
        if (saved) {
            await reuploadMovie(saved._id.toString(), episodes[0].lien, titre);
            autoLink('movie', saved._id.toString());
        }
    } else {
        const saved = await Serie.findOneAndUpdate(
            { titre },
            {
                $set: {
                    titre,
                    pageUrl: ficheUrl,
                    episodes,
                    year,
                    posterUrl: poster,
                    posterSource: poster ? 'tmdb' : undefined,
                },
            },
            { upsert: true, returnDocument: 'after' }
        );
        console.log(`  ✅ Série enregistrée (${episodes.length} ép.) : ${titre}`);
        if (saved) {
            for (let epIdx = 0; epIdx < episodes.length; epIdx++) {
                const ep = episodes[epIdx];
                if (!ep.lien || ep.lien === '#') continue;
                await reuploadEpisode(saved._id.toString(), ep, epIdx);
            }
            autoLink('series', saved._id.toString());
        }
    }
}

async function scrapeAnimesCategories() {
    console.log('[START] scrapeAnimesCategories() — connexion MongoDB...');
    await connectDB();
    console.log('[OK] MongoDB connecté.');

    let shuttingDown = false;
    process.on('SIGTERM', async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\n[SIGTERM] Arrêt demandé, déconnexion...');
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
    });

    console.log('Récupération des catégories du dropdown Anime...');
    const categories = await fetchCategories();
    if (categories.length === 0) {
        console.log('[FATAL] Aucune catégorie récupérée.');
        await mongoose.disconnect();
        process.exit(1);
    }
    console.log(`[OK] ${categories.length} catégories dans le dropdown.`);

    const state = await loadState();
    console.log(`Reprise à la catégorie #${state.lastCatIndex} (page ${state.lastPage}).`);

    for (let catIndex = 0; catIndex < categories.length && !shuttingDown; catIndex++) {
        if (catIndex < state.lastCatIndex) continue;
        const cat = categories[catIndex];
        console.log(`\n========== Catégorie [${catIndex + 1}/${categories.length}] : ${cat.text} (${cat.href}) ==========`);

        let pageNum = catIndex === state.lastCatIndex ? state.lastPage : 1;
        let hasMore = true;

        while (hasMore && !shuttingDown) {
            console.log(`--- ${cat.text} — page ${pageNum} ---`);
            let items: AnimeItem[] = [];
            try {
                items = await fetchCategoryPage(cat.href, pageNum);
            } catch (e: any) {
                console.log(`Erreur fetch page ${pageNum} : ${e.message}`);
                break;
            }

            if (items.length === 0) {
                console.log('Fin de la catégorie.');
                hasMore = false;
                break;
            }

            console.log(`${items.length} animes sur la page.`);
            for (const item of items) {
                if (shuttingDown) break;
                try {
                    const kind = detectKind(item);
                    await processItem(item, kind);
                } catch (e: any) {
                    console.error(`Erreur sur ${item.title} : ${e.message}`);
                }
            }

            pageNum++;
            await saveState(catIndex, pageNum);
        }

        await saveState(catIndex + 1, 1);
    }

    await mongoose.disconnect();
    console.log('Scraping des animes terminé.');
}

scrapeAnimesCategories().catch((err) => {
    console.log('[FATAL] scrapeAnimesCategories() crashed:', err?.message || err);
    console.error(err);
    process.exit(1);
});