const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'series.json');

async function scrapeSingleSeries() {
    // Charger les données existantes pour ne pas écraser si besoin
    let allSeries = [];
    if (fs.existsSync(DATA_FILE)) {
        try {
            allSeries = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        } catch (e) {
            console.log("Impossible de lire le fichier existant, démarrage à blanc.");
        }
    }

    // Lancer Playwright (headless: false pour que vous puissiez voir l'action)
    console.log("Lancement du navigateur...");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = "https://www.open-otaku.me/?cat=series&page=11";

    try {
        console.log(`Navigation vers ${url}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        
        console.log("Attente de l'apparition des cartes de séries (.fs-card)...");
        await page.waitForSelector('.fs-card', { timeout: 20000 });

        const cards = await page.$$('.fs-card');
        if (cards.length === 0) {
            console.log("Aucune carte trouvée !");
            await browser.close();
            return;
        }

        // On ne teste que la PREMIÈRE série pour ce test (teste 1)
        const card = cards[0];
        const titre = await card.$eval('.fs-card-title', el => el.innerText.trim());

        console.log(`\n--- Début du test pour la série : "${titre}" ---`);
        
        // Cliquer sur la carte
        console.log("Clic sur la série...");
        await card.click();
        await page.waitForLoadState('domcontentloaded');

        // Initialiser l'objet de données
        const serieData = { titre: titre, episodes: [] };

        let episodeCount = 0;
        // Boucle sur les épisodes
        while (true) {
            // Attendre que le sélecteur d'épisode soit chargé (on attend le select lui-même qui est visible)
            await page.waitForSelector('#fs-episode-select', { state: 'visible', timeout: 20000 });
            
            const epTitre = await page.$eval('#fs-episode-select option:checked', el => el.innerText.trim());
            console.log(`  -> Épisode détecté : ${epTitre}`);

            // Clic sur le bouton de téléchargement rapide
            console.log("     Clic sur le téléchargement rapide...");
            await page.click('button#fs-quick-download', { force: true });
            
            // Attente du chargement du lien (10 secondes comme dans votre script d'origine)
            console.log("     Attente de 10 secondes pour générer le lien...");
            await page.waitForTimeout(10000);

            // Tenter de récupérer le lien
            const dlLink = await page.$('a#fs-dl-link');
            const link = dlLink ? await dlLink.getAttribute('href') : "#";

            if (link && link !== "#") {
                serieData.episodes.push({ episode: epTitre, lien: link });
                console.log(`     -> LIEN TROUVÉ : ${link}`);
            } else {
                console.log(`     -> ERREUR : Aucun lien trouvé pour cet épisode.`);
            }

            // Fermer la modal de téléchargement
            console.log("     Fermeture de la modal...");
            await page.click('button#fs-modal-close');
            await page.waitForTimeout(2000);

            episodeCount++;
            // Pour le test, on peut limiter à 3 épisodes pour aller plus vite si vous le souhaitez, 
            // mais ici on garde la boucle complète de la série pour être fidèle.
            
            // Vérifier s'il y a un épisode suivant
            const nextBtn = await page.$('button#fs-next-ep');
            const isEnabled = nextBtn ? await nextBtn.isEnabled() : false;
            
            if (!nextBtn || !isEnabled) {
                console.log("Fin des épisodes pour cette série.");
                break;
            }
            
            console.log("     Passage à l'épisode suivant...");
            await nextBtn.click();
            await page.waitForTimeout(5000);
        }

        // Sauvegarder les données de cette série de test
        // On vérifie si elle existe déjà dans le fichier pour la mettre à jour, sinon on l'ajoute
        const existingIndex = allSeries.findIndex(s => s.titre === titre);
        if (existingIndex !== -1) {
            allSeries[existingIndex] = serieData;
        } else {
            allSeries.push(serieData);
        }

        fs.writeFileSync(DATA_FILE, JSON.stringify(allSeries, null, 4), 'utf-8');
        console.log(`\n[SUCCÈS] Série "${titre}" sauvegardée avec succès dans series.json !`);

    } catch (error) {
        console.error("Une erreur est survenue durant le test :", error);
    } finally {
        console.log("Fermeture du navigateur.");
        await browser.close();
    }
}

scrapeSingleSeries();
