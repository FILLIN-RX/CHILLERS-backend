import { chromium } from 'playwright';
import mongoose from 'mongoose';
import Serie from '../../models/Serie';
import ScraperState from '../../models/ScraperState';
import { browserConfig } from '../../config/browser';
import { connectDB } from '../../config/db';
import { UqloadClient } from '../../modules/uqload/uqload.client';
import { reuploadEpisode } from '../../modules/reupload/reupload';

async function uploadEpisodeToUqload(client: UqloadClient | null, label: string, lien: string, serieId: string, episodeIndex: number) {
  if (!client) return;
  try {
    console.log(`    -> Upload Uqload: ${label}`);
    const { fileCode, directLink } = await client.uploadByUrlAndGetLink(lien, label);
    const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];
    await Serie.updateOne(
      { _id: serieId },
      { $set: { [`episodes.${episodeIndex}.uqloadCode`]: fileCode, [`episodes.${episodeIndex}.uqloadLink`]: bestQuality?.url || null } }
    );
    console.log(`    -> ✅ Uqload: ${label} → ${fileCode}`);
  } catch (e: any) {
    console.log(`    -> ⏭ Uqload ignoré: ${e.message}`);
  }
}

/**
 * Parse the episode label returned by Otaku's #fs-episode-select into a
 * structured (season, episodeNumber, canonicalLabel) tuple. Otaku uses
 * "S01E05" or just "Ép 5" depending on the source page. The schema
 * requires a numeric `season` + `episodeNumber` so the maintainer can
 * match by positional operator.
 */
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

async function scrapeSeriesDetails() {
    await connectDB();

    const browser = await chromium.launch(browserConfig);
    const page = await browser.newPage();
    const apiKey = process.env.UQLOAD_API_KEY;
    const uqload = apiKey ? new UqloadClient(apiKey) : null;

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
        const url = `https://www.open-otaku.me/?cat=series&page=${currentPage}`;
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
        console.log(`Séries trouvées sur la page : ${cards.length}`);

        for (let i = 0; i < cards.length; i++) {
            try {
                let currentCards = await page.$$('.fs-card');
                let card = currentCards[i];
                let titre = await card.$eval('.fs-card-title', (el: any) => el.innerText.trim());

                const existingSeries = await Serie.findOne({ titre: titre });
                if (existingSeries && existingSeries.pageUrl && existingSeries.episodes && existingSeries.episodes.length > 0) {
                    console.log(`Série déjà traitée et complète : ${titre}`);
                    continue;
                }

                console.log(`Traitement de la série : ${titre}`);
                await card.click();
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(1000);
                const pageUrl = page.url();

                let serieData: any = { 
                    titre: titre, 
                    pageUrl: pageUrl, 
                    episodes: existingSeries ? existingSeries.episodes : [] 
                };

                if (serieData.episodes.length === 0) {
                    console.log(`  -> Récupération des épisodes pour : ${titre}`);
                    while (true) {
                        await page.waitForSelector('#fs-episode-select', { state: 'attached', timeout: 10000 });
                        let epTitre = await page.$eval('#fs-episode-select option:checked', (el: any) => el.innerText.trim());
                        await page.click('button#fs-quick-download', { force: true });
                        await page.waitForTimeout(10000);
                        let dlLink = await page.$('a#fs-dl-link');
                        let link = dlLink ? await dlLink.getAttribute('href') : "#";

                        if (link && link !== "#") {
                            // Parse the label so the schema gets the structured
                            // season + episodeNumber fields it needs for
                            // positional updates. Without this the
                            // maintainer and the reupload module can't
                            // reliably match episodes back.
                            const seasonMatch = titre.match(/Saison (\d+)/i);
                            const defaultSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
                            const { season, episodeNumber, canonical } = parseEpisodeLabel(epTitre, defaultSeason);
                            serieData.episodes.push({
                                episode: canonical,
                                season,
                                episodeNumber,
                                lien: link,
                            });
                        }
                        // Supprimer la popup don qui bloque le clic
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
                    { titre: titre },
                    { $set: serieData },
                    { upsert: true, returnDocument: 'after' }
                );
                console.log(`Série enregistrée dans MongoDB : ${titre}`);

                if (saved) {
                    // Upload to BOTH Doodstream and Uqload. The reupload
                    // module handles "already uploaded" via the fileCode
                    // existence check, so re-running the scraper on the
                    // same episodes is safe and idempotent.
                    for (let epIdx = 0; epIdx < (saved.episodes || []).length; epIdx++) {
                        const ep = saved.episodes[epIdx];
                        if (!ep.lien || ep.lien === "#") continue;
                        const label = `${titre} - ${ep.episode}`;
                        await reuploadEpisode(saved._id.toString(), ep, epIdx);
                        // Keep the legacy Uqload path too — the new module
                        // shares the same Uqload API so this is a no-op
                        // when uqloadCode is already set, but the legacy
                        // helper also writes `uqloadLink` which the new
                        // module attempts but the upstream may not
                        // surface. Both writes are idempotent.
                        if (uqload && !ep.uqloadCode) {
                            await uploadEpisodeToUqload(uqload, label, ep.lien, saved._id.toString(), epIdx);
                        }
                    }
                }

                await page.goto(url, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('.fs-card');
            } catch (e) {
                console.error(`Erreur sur la série :`, e);
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
    console.log("Scraping terminé.");
}

scrapeSeriesDetails().catch(console.error);
