import { isLinkDead } from './core/link-checker';
import { getSpecificEpisodeLink, searchAndNavigateToSeries } from '../modules/otaku/otaku.service';
import { chromium } from 'playwright';

async function runTest() {
    console.log("--- TEST DE MAINTENANCE ---");
    
    // 1. Tester la détection de lien mort (on force un lien bidon)
    const deadLink = "https://example.com/dead-link.mp4";
    console.log("Test 1: Vérification lien mort...");
    const isDead = await isLinkDead(deadLink);
    console.log("-> Le lien est-il mort ? ", isDead);

    // 2. Tester la réparation précise
    console.log("\nTest 2: Test de réparation pour 'Riot Women' - Ép 1...");
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    
    const serieTitle = "Riot Women";
    const epNum = "1";
    
    const navigated = await searchAndNavigateToSeries(page, serieTitle);
    console.log("-> Navigation réussie :", navigated);
    
    if (navigated) {
        const newLink = await getSpecificEpisodeLink(page, epNum);
        console.log("-> Nouveau lien trouvé : ", newLink);
    }
    
    await browser.close();
    console.log("\n--- TEST TERMINÉ ---");
}

runTest().catch(console.error);
