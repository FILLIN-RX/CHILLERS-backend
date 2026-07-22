const { chromium } = require('playwright');
const mongoose = require('mongoose');
const axios = require('axios');
const Movie = require('../../models/Movie').default;
const ScraperState = require('../../models/ScraperState').default;
const { connectDB } = require('../../config/db');
const { browserConfig } = require('../../config/browser');
const { UqloadClient } = require('../../modules/uqload/uqload.client');

async function uploadToUqload(client, titre, lien, movieId) {
  if (!client) return;
  try {
    console.log(`  -> Upload Uqload: ${titre}`);
    const { fileCode, directLink } = await client.uploadByUrlAndGetLink(lien, titre);
    const bestQuality = directLink?.versions?.find(v => v.name === 'n') || directLink?.versions?.[0];
    await Movie.updateOne(
      { _id: movieId },
      {
        $set: {
          uqloadCode: fileCode,
          uqloadLink: bestQuality ? bestQuality.url : null,
          uqloadQualities: directLink?.versions || [],
          uqloadHls: directLink?.hls_direct || null,
        }
      }
    );
    console.log(`  -> ✅ Uqload: ${titre} → ${fileCode}`);
  } catch (e) {
    console.log(`  -> ⏭ Uqload ignoré pour ${titre}: ${e.message}`);
  }
}

const DOOD_API_KEY = process.env.DOODSTREAM_API_KEY;
const DOOD_BASE = 'https://doodapi.co/api';

async function uploadToDoodStream(titre, lien, movieId) {
  if (!DOOD_API_KEY || !lien || lien === '#') return;
  try {
    console.log(`  -> Upload DoodStream: ${titre}`);
    const { data } = await axios.get(`${DOOD_BASE}/upload/url`, {
      params: { key: DOOD_API_KEY, url: lien, new_title: titre },
      timeout: 30000,
    });
    if (data.status === 200 && data.result?.filecode) {
      const doodUrl = `https://doodstream.com/e/${data.result.filecode}`;
      const movie = await Movie.findById(movieId);
      const update = { lien: doodUrl, fileCode: data.result.filecode, uploadedAt: new Date() };
      if (movie && !movie.lienOriginal) update.lienOriginal = movie.lien;
      await Movie.updateOne({ _id: movieId }, { $set: update });
      console.log(`  -> ✅ DoodStream: ${titre} → ${doodUrl}`);
    } else {
      console.log(`  -> ⏭ DoodStream ignoré pour ${titre}: ${data.msg || 'réponse inattendue'}`);
    }
  } catch (e) {
    console.log(`  -> ⏭ DoodStream ignoré pour ${titre}: ${e.message}`);
  }
}

async function getLastPage() {
    try {
        const state = await ScraperState.findOne({ name: 'films' });
        return state ? state.lastPage : 1;
    } catch {
        return 1;
    }
}

async function saveLastPage(page) {
    await ScraperState.findOneAndUpdate(
        { name: 'films' },
        { $set: { lastPage: page, updatedAt: new Date() } },
        { upsert: true }
    );
}

async function scrapeFilms() {
    await connectDB();

    const browser = await chromium.launch(browserConfig);
    const page = await browser.newPage();
    const apiKey = process.env.UQLOAD_API_KEY;
    const uqload = apiKey ? new UqloadClient(apiKey) : null;

    let currentPage = await getLastPage();
    let hasMorePages = true;
    console.log(`Reprise à la page ${currentPage}`);

    while (hasMorePages) {
        const url = `https://www.open-otaku.me/?cat=films&page=${currentPage}`;
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
        console.log(`Films trouvés sur la page : ${cards.length}`);

        for (let i = 0; i < cards.length; i++) {
            let titre = `<film #${i}>`;
            try {
                let currentCards = await page.$$('.fs-card');
                let card = currentCards[i];
                titre = await card.$eval('.fs-card-title', el => el.innerText.trim());

                if (titre.includes("Saison") || titre.includes("Épisode")) continue;

                const existingFilm = await Movie.findOne({ titre: titre });
                if (existingFilm && existingFilm.pageUrl && existingFilm.lien) {
                    console.log(`Film déjà traité : ${titre}`);
                    continue;
                }

                console.log(`Traitement du film : ${titre}`);
                await card.click();
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(1000);

                const pageUrl = page.url();

                await page.click('button#fs-quick-download', { force: true });
                await page.waitForTimeout(10000);

                let dlLink = await page.$('a#fs-dl-link');
                let link = dlLink ? await dlLink.getAttribute('href') : "#";

                if (link && link !== "#") {
                    const saved = await Movie.findOneAndUpdate(
                        { titre: titre },
                        { $set: { titre, pageUrl, lien: link } },
                        { upsert: true, returnDocument: 'after' }
                    );
                    console.log(`Film sauvegardé dans MongoDB : ${titre}`);
                    if (saved) {
                        await uploadToUqload(uqload, titre, link, saved._id.toString());
                        await uploadToDoodStream(titre, link, saved._id.toString());
                    }
                }

                await page.goto(url, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('.fs-card');
            } catch (e) {
                console.error(`Erreur film ${titre}:`, e.message);
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded' });
                    await page.waitForSelector('.fs-card');
                } catch (recoveryErr) {
                    console.error(`Récupération échouée pour ${titre}:`, recoveryErr.message);
                }
            }
        }
        currentPage++;
        await saveLastPage(currentPage);
    }
    await browser.close();
    await mongoose.disconnect();
    console.log("Scraping terminé.");
}
scrapeFilms().catch(console.error);
