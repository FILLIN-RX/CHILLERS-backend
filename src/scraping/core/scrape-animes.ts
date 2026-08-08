import { chromium } from 'playwright';
import mongoose from 'mongoose';
import Serie from '../../models/Serie';
import ScraperState from '../../models/ScraperState';
import { browserConfig } from '../../config/browser';
import { connectDB } from '../../config/db';
import { uploadToStreamtape } from '../../modules/streamtape/streamtape.uploader';
import { autoLink } from '../maintenance/auto-link';

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

async function loadState(): Promise<{ lastPage: number }> {
    try {
        const state = await ScraperState.findOne({ name: 'animes' });
        return { lastPage: state?.lastPage || 1 };
    } catch {
        return { lastPage: 1 };
    }
}

async function saveState(lastPage: number) {
    await ScraperState.findOneAndUpdate(
        { name: 'animes' },
        { $set: { lastPage, updatedAt: new Date() } },
        { upsert: true }
    );
}

async function scrapeAnimesDetails() {
    console.log('[START] scrapeAnimesDetails() called — connecting to MongoDB...');
    await connectDB();
    console.log('[OK] MongoDB connected, launching Playwright...');

    const browser = await chromium.launch(browserConfig);
    console.log('[OK] Playwright browser launched');
    const page = await browser.newPage();

    let shuttingDown = false;
    process.on('SIGTERM', async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\n[SIGTERM] Arrêt demandé, fermeture du navigateur...');
        await browser.close().catch(() => {});
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
    });

    const state = await loadState();
    let currentPage = state.lastPage;
    let hasMorePages = true;

    while (hasMorePages && !shuttingDown) {
        const url = `https://www.open-otaku.me/?type=animes&page=${currentPage}`;
        console.log(`\n--- Navigation vers ${url} ---`);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        try {
            await page.waitForSelector('.fs-card', { timeout: 30000 });
        } catch (e) {
            console.log("Fin de la liste.");
            hasMorePages = false;
            break;
        }

        let cards = await page.$$('.fs-card');
        console.log(`Animes trouvés sur la page : ${cards.length}`);

        for (let i = 0; i < cards.length; i++) {
            try {
                let currentCards = await page.$$('.fs-card');
                let card = currentCards[i];
                let titre = await card.$eval('.fs-card-title', (el: any) => el.innerText.trim());

                const existingAnime = await Serie.findOne({ titre: titre });
                if (existingAnime && existingAnime.pageUrl && existingAnime.episodes && existingAnime.episodes.length > 0) {
                    console.log(`Anime déjà traité : ${titre}`);
                    continue;
                }

                console.log(`Traitement de l'anime : ${titre}`);
                await card.click();
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(1000);
                const pageUrl = page.url();

                let animeData: any = { 
                    titre, 
                    pageUrl, 
                    episodes: existingAnime ? existingAnime.episodes : [] 
                };

                if (animeData.episodes.length === 0) {
                    console.log(`  -> Récupération des épisodes pour : ${titre}`);
                    while (true) {
                        await page.waitForSelector('#fs-episode-select', { state: 'attached', timeout: 10000 });
                        let epTitre = await page.$eval('#fs-episode-select option:checked', (el: any) => el.innerText.trim());
                        await page.click('button#fs-quick-download', { force: true });
                        await page.waitForTimeout(10000);
                        let dlLink = await page.$('a#fs-dl-link');
                        let link = dlLink ? await dlLink.getAttribute('href') : "#";

                        if (link && link !== "#") {
                            const seasonMatch = titre.match(/Saison (\d+)/i);
                            const defaultSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
                            const { season, episodeNumber, canonical } = parseEpisodeLabel(epTitre, defaultSeason);
                            animeData.episodes.push({
                                episode: canonical,
                                season,
                                episodeNumber,
                                lien: link,
                            });
                        }
                        await page.evaluate(() => {
                            document.querySelector('#fs-donate-overlay')?.remove();
                        });
                        await page.click('button#fs-modal-close');
                        await page.waitForTimeout(2000);
                        let nextBtn = await page.$('button#fs-next-ep');
                        if (!nextBtn || !(await nextBtn.isEnabled())) break;
                        await nextBtn.click();
                        await page.waitForTimeout(5000);
                    }
                }

                const saved = await Serie.findOneAndUpdate(
                    { titre },
                    { $set: animeData },
                    { upsert: true, returnDocument: 'after' }
                );
                console.log(`Anime enregistré dans MongoDB : ${titre}`);

                if (saved) {
                    for (let epIdx = 0; epIdx < (saved.episodes || []).length; epIdx++) {
                        const ep = saved.episodes[epIdx];
                        if (!ep.lien || ep.lien === "#") continue;
                        if (ep.streamtapeCode) {
                            console.log(`  -> ⏭ Déjà uploadé Streamtape : ${titre} - ${ep.episode}`);
                            continue;
                        }
                        const label = `${titre} - ${ep.episode}`;
                        console.log(`  -> Upload Streamtape: ${label}`);
                        const st = await uploadToStreamtape(ep.lien, label);
                        if (st) {
                            await Serie.updateOne(
                                { _id: saved._id },
                                { $set: { [`episodes.${epIdx}.streamtapeCode`]: st.linkId, [`episodes.${epIdx}.streamtapeLink`]: st.embedUrl } }
                            );
                            console.log(`  -> ✅ Streamtape: ${label} → ${st.embedUrl}`);
                        } else {
                            console.log(`  -> ⏭ Streamtape échoué pour ${label}`);
                        }
                    }
                    // Liaison TMDB en arrière-plan (fire-and-forget) — anime utilise le modèle Serie
                    autoLink('series', saved._id.toString());
                }

                await page.goto(url, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('.fs-card');
            } catch (e) {
                console.error(`Erreur sur l'anime :`, e);
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded' });
                    await page.waitForSelector('.fs-card');
                } catch (recoveryErr) {
                    console.error(`Récupération échouée :`, recoveryErr);
                }
            }
        }
        currentPage++;
        await saveState(currentPage);
    }
    await browser.close();
    await mongoose.disconnect();
    console.log("Scraping animes terminé.");
}

scrapeAnimesDetails().catch((err) => {
    console.log('[FATAL] scrapeAnimesDetails() crashed:', err?.message || err);
    console.error(err);
    process.exit(1);
});
