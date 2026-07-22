import { searchAndNavigateToSeries, getSpecificEpisodeLink } from '../../modules/otaku/otaku.service';
import { chromium } from 'playwright';
import { browserConfig } from '../../config/browser';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

/**
 * Recherche et récupère les informations pour un film ou une série s'il est manquant
 */
export async function fetchMissingMedia(title: string, type: 'movie' | 'series', episodeNum?: string) {
    console.log(`[OnDemand] Recherche de : "${title}" (${type})...`);
    
    const browser = await chromium.launch(browserConfig);
    const page = await browser.newPage();
    
    const navigated = await searchAndNavigateToSeries(page, title);
    if (!navigated) {
        await browser.close();
        return;
    }

    let result = null;

    if (type === 'series' && episodeNum) {
        const link = await getSpecificEpisodeLink(page, episodeNum);
        if (link) {
            result = { titre: title, episode: `Ép ${episodeNum}`, lien: link };
            // Update MongoDB Serie
            await Serie.findOneAndUpdate(
                { titre: title },
                { $push: { episodes: { episode: `Ép ${episodeNum}`, lien: link } } },
                { upsert: true }
            );
        }
    } else {
        const dlBtn = page.locator('button#fs-quick-download');
        await dlBtn.click({ force: true });
        await page.waitForTimeout(8000);
        const dlLink = page.locator('a#fs-dl-link');
        const link = await dlLink.getAttribute('href');
        result = { titre: title, lien: link };

        // Update MongoDB Movie
        await Movie.findOneAndUpdate(
            { titre: title },
            { $set: { titre: title, pageUrl: page.url(), lien: link } },
            { upsert: true }
        );
    }

    await browser.close();
    return result;
}

if (process.argv[1] && process.argv[1].includes('on-demand-fetch')) {
    const title = process.argv[2];
    const type = process.argv[3] as 'movie' | 'series';
    const episodeNum = process.argv[4];

    if (title && type) {
        fetchMissingMedia(title, type, episodeNum)
            .then((result) => {
                if (result) {
                    console.log(`[OnDemand] Successfully fetched: ${JSON.stringify(result)}`);
                    process.exit(0);
                } else {
                    console.log(`[OnDemand] Failed to fetch missing media for: "${title}"`);
                    process.exit(1);
                }
            })
            .catch((err) => {
                console.error(`[OnDemand] Error executing fetch:`, err);
                process.exit(1);
            });
    } else {
        console.error('Usage: npx tsx on-demand-fetch.ts <title> <type> [episodeNum]');
        process.exit(1);
    }
}
