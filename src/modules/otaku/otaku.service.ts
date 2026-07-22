import { chromium, Browser, Page } from 'playwright';
import { browserConfig } from '../../config/browser';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

const BASE_URL = 'https://www.open-otaku.me';

let browser: Browser | null = null;
let scrapeInProgress = false;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch(browserConfig);
  }
  return browser;
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

export interface OtakuResult {
  titre: string;
  lien: string;
  source: 'otaku';
}

export async function searchOtaku(title: string, type: 'movie' | 'series' = 'movie'): Promise<OtakuResult | null> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Navigate to search page
    const searchUrl = type === 'series'
      ? `${BASE_URL}/?cat=series`
      : `${BASE_URL}/`;

    console.log(`[Otaku] Searching "${title}" on ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Click search button
    const searchBtn = page.locator('#fs-search-icon-btn');
    if (await searchBtn.count() > 0) {
      await searchBtn.click();
      await page.waitForTimeout(1000);
    }

    // Type in search input
    const searchInput = page.locator('input[type="search"], input[type="text"], #fs-search-input, .fs-search-input');
    if (await searchInput.count() > 0) {
      await searchInput.first().fill(title);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    } else {
      // Try URL-based search
      await page.goto(`${BASE_URL}/?s=${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // Find cards in results
    const cards = await page.locator('.fs-card').all();
    if (cards.length === 0) {
      console.log(`[Otaku] No results for "${title}"`);
      return null;
    }

    // Find best match
    let bestCard = cards[0];
    let bestScore = 0;
    const searchNorm = normalize(title);

    for (const card of cards) {
      const cardTitle = await card.locator('.fs-card-title').innerText().catch(() => '');
      const cardNorm = normalize(cardTitle);
      if (cardNorm === searchNorm || cardNorm.includes(searchNorm) || searchNorm.includes(cardNorm)) {
        bestCard = card;
        bestScore = 1;
        break;
      }
      // Partial match
      if (cardNorm.slice(0, 10) === searchNorm.slice(0, 10)) {
        bestCard = card;
        bestScore = 0.5;
      }
    }

    if (bestScore === 0) {
      console.log(`[Otaku] No close match for "${title}", using first result`);
    }

    // Supprimer la popup don qui bloque le clic
    await page.evaluate(() => {
        document.querySelector('#fs-donate-overlay')?.remove();
    }).catch(() => {});

    await page.waitForTimeout(500);
    // Supprimer la popup don à nouveau (elle peut réapparaître)
    await page.evaluate(() => {
        document.querySelector('#fs-donate-overlay')?.remove();
    }).catch(() => {});

    // Click on best card (force: true pour ignorer les overlays)
    await bestCard.click({ force: true });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Get title from detail page
    const detailTitle = await page.locator('.fs-card-title, h1, h2').first().innerText().catch(() => title);

    if (type === 'series') {
      // Series: get first episode download link
      const link = await extractEpisodeDownload(page);
      if (link) {
        return { titre: detailTitle, lien: link, source: 'otaku' };
      }
    } else {
      // Movie: get download link
      const link = await extractMovieDownload(page);
      if (link) {
        return { titre: detailTitle, lien: link, source: 'otaku' };
      }
    }

    console.log(`[Otaku] No download link found for "${title}"`);
    return null;
  } catch (err: any) {
    console.error(`[Otaku] Error searching "${title}":`, err.message);
    return null;
  } finally {
    await page.close();
  }
}

async function extractMovieDownload(page: Page): Promise<string | null> {
  try {
    // Click download button
    const dlBtn = page.locator('button#fs-quick-download, .fs-download-btn, button:has-text("Download")');
    if (await dlBtn.count() > 0) {
      await dlBtn.first().click({ force: true });
      await page.waitForTimeout(8000);

      // Extract link
      const dlLink = page.locator('a#fs-dl-link, a[href*="vidzy"], a[href*="doodstream"], a[href*=".mp4"]');
      if (await dlLink.count() > 0) {
        const href = await dlLink.first().getAttribute('href');
        if (href && href !== '#') return href;
      }
    }

    // Fallback: try to find any direct link
    const allLinks = await page.locator('a[href]').all();
    for (const link of allLinks) {
      const href = await link.getAttribute('href');
      if (href && (href.includes('.mp4') || href.includes('vidzy') || href.includes('doodstream'))) {
        return href;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function extractEpisodeDownload(page: Page): Promise<string | null> {
  try {
    // Click download button
    const dlBtn = page.locator('button#fs-quick-download, .fs-download-btn');
    if (await dlBtn.count() > 0) {
      await dlBtn.first().click({ force: true });
      await page.waitForTimeout(8000);

      // Extract link
      const dlLink = page.locator('a#fs-dl-link, a[href*="vidzy"], a[href*="doodstream"], a[href*=".mp4"]');
      if (await dlLink.count() > 0) {
        const href = await dlLink.first().getAttribute('href');
        if (href && href !== '#') return href;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function searchAndNavigateToSeries(page: Page, title: string): Promise<boolean> {
  try {
    console.log(`[Otaku] Navigating to series: "${title}" via UI search`);

    // 1. Go to homepage
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 2. Click search button
    const searchBtn = page.locator('#fs-search-icon-btn');
    if (await searchBtn.count() > 0) {
      await searchBtn.click();
      await page.waitForTimeout(1000);
    }

    // 3. Type in search input and press Enter
    const searchInput = page.locator('input[type="search"], input[type="text"], #fs-search-input, .fs-search-input');
    if (await searchInput.count() > 0) {
      await searchInput.first().fill(title);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000); // Wait for results
    } else {
        console.log("[Otaku] Search input not found");
        return false;
    }

    // 4. Find cards and click best match
    const cards = await page.locator('.fs-card').all();
    if (cards.length === 0) {
      console.log(`[Otaku] No results for "${title}"`);
      return false;
    }

    // Simple matching to find the best card
    let targetCard = cards[0];
    for (const card of cards) {
      const cardTitle = await card.locator('.fs-card-title').innerText().catch(() => '');
      if (cardTitle.toLowerCase().includes(title.toLowerCase())) {
        targetCard = card;
        break;
      }
    }

    await targetCard.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    return true;
  } catch (err) {
    console.error(`[Otaku] Error navigating to "${title}":`, err);
    return false;
  }
}

export async function getSpecificEpisodeLink(page: Page, episodeNumber: string, previousLink?: string | null): Promise<string | null> {
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. Attendre que le select ait au moins une option
      await page.waitForFunction(() => {
        const s = document.querySelector('#fs-episode-select') as HTMLSelectElement;
        return s && s.options && s.options.length > 0;
      }, { timeout: 15000 });

      // 2. Sélectionner l'épisode dans la liste
      const optionFound = await page.evaluate((epNum) => {
          const select = document.querySelector('#fs-episode-select') as HTMLSelectElement;
          const option = Array.from(select.options).find(o => o.text.trim().includes('Ép ' + epNum));
          if (option) {
              select.value = option.value;
              select.dispatchEvent(new Event('change'));
              return true;
          }
          return false;
      }, episodeNumber);

      if (!optionFound) {
        const texts = await page.evaluate(() => {
          const s = document.querySelector('#fs-episode-select') as HTMLSelectElement | null;
          return s ? Array.from(s.options, o => o.text) : [];
        });
        console.log(`[Otaku] Épisode "${episodeNumber}" non trouvé. Options: ${JSON.stringify(texts)}`);
        return null;
      }

      // 3. Attendre que le contenu se mette à jour
      await page.waitForTimeout(3000);

      // 4. Cliquer sur téléchargement
      const dlBtn = page.locator('button#fs-quick-download, .fs-download-btn, button:has-text("Download")');
      if (await dlBtn.count() > 0) {
          await dlBtn.first().click({ force: true });
      } else {
          console.log("[Otaku] Bouton de téléchargement introuvable.");
          if (attempt < maxRetries) {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);
            continue;
          }
          return null;
      }

      // 5. Attendre un lien valide ET différent du précédent (évite les liens périmés)
      try {
        await page.waitForFunction((prevLink) => {
            const a = document.querySelector('a#fs-dl-link, a[href*="vidzy"], a[href*="doodstream"]');
            if (!a) return false;
            const href = a.getAttribute('href');
            return href !== null && href !== '#' && href.length > 10 && href !== prevLink;
        }, previousLink ?? null, { timeout: 30000 });
      } catch {
        console.log(`[Otaku] Timeout en attente du lien pour épisode ${episodeNumber}`);
        if (attempt < maxRetries) {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          continue;
        }
        return null;
      }

      // 6. Récupérer le lien
      const dlLink = page.locator('a#fs-dl-link, a[href*="vidzy"], a[href*="doodstream"]');
      if (await dlLink.count() > 0) {
          const href = await dlLink.first().getAttribute('href');
          if (href && href !== '#') return href;
      }

      if (attempt < maxRetries) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
      }
    } catch (err) {
      console.error(`[Otaku] Erreur (tentative ${attempt}) pour épisode ${episodeNumber}:`, err);
      if (attempt < maxRetries) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        continue;
      }
    }
  }
  return null;
}

export async function searchAndCache(
  title: string,
  type: 'movie' | 'series' = 'movie'
): Promise<OtakuResult | null> {
  if (scrapeInProgress) {
    console.log(`[Otaku] Scrape already in progress, skipping "${title}"`);
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
            pageUrl: '', // Will be filled by maintenance
            episodes: [{ episode: 'Ép 1', lien: result.lien }]
          });
          console.log(`[Otaku] Cached Series: ${result.titre}`);
        }
      } else {
        const existing = await Movie.findOne({ titre: result.titre });
        if (!existing) {
          await Movie.create({
            titre: result.titre,
            pageUrl: '', // Will be filled by maintenance
            lien: result.lien
          });
          console.log(`[Otaku] Cached Movie: ${result.titre}`);
        }
      }
    }
    return result;
  } finally {
    scrapeInProgress = false;
  }
}
