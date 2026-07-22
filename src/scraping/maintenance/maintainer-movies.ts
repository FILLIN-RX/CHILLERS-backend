import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import { chromium } from 'playwright';
import { browserConfig } from '../../config/browser';
import { connectDB } from '../../config/db';
import Movie from '../../models/Movie';
import DeadLink from '../../models/DeadLink';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

async function rescrapeMovie(browser: any, deadLink: any): Promise<boolean> {
  const { titre, lien: oldLien } = deadLink;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  try {
    const movie = await Movie.findOne({ titre }).select('pageUrl').lean();
    let pageUrl = movie?.pageUrl || null;

    if (pageUrl) {
      console.log(`[Maintenance] Navigation directe "${titre}"`);
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);
    } else {
      console.log(`[Maintenance] Recherche "${titre}"`);
      await page.goto('https://www.open-otaku.me/', { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);

      const searchBtn = page.locator('#fs-search-icon-btn');
      if (await searchBtn.count() > 0) {
        await searchBtn.click();
        await page.waitForTimeout(1500);
      }

      const searchInput = page.locator('input[type="search"], input[type="text"], #fs-search-input, .fs-search-input');
      if (await searchInput.count() > 0) {
        await searchInput.first().click();
        await searchInput.first().fill(titre);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
      }

      const firstCard = page.locator('.fs-card').first();
      if (await firstCard.count() > 0) {
        await firstCard.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
      }
    }

    const dlBtn = page.locator('#fs-quick-download');
    if (await dlBtn.count() > 0) {
      await dlBtn.click({ force: true });
      await page.waitForTimeout(10000);

      const dlLink = page.locator('a#fs-dl-link');
      const newLien = await dlLink.getAttribute('href');

      if (newLien && newLien !== '#' && newLien !== oldLien) {
        await Movie.updateOne({ titre }, { $set: { lien: newLien } });
        await DeadLink.deleteOne({ _id: deadLink._id });
        console.log(`[Maintenance] ✅ Film réparé: "${titre}" → ${newLien.substring(0, 80)}...`);
        return true;
      } else if (newLien === oldLien) {
        console.log(`[Maintenance] ⏭ Lien identique pour "${titre}"`);
        await DeadLink.deleteOne({ _id: deadLink._id });
        return true;
      }
    }
    console.log(`[Maintenance] ⏭ Aucun nouveau lien pour "${titre}"`);
    return false;
  } catch (e: any) {
    console.log(`[Maintenance] ⏭ Erreur "${titre}": ${e.message}`);
    return false;
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('[Maintenance] Démarrage réparation des films...');
  await connectDB();

  const deadLinks = await DeadLink.find({ type: 'movie' }).lean();
  console.log(`[Maintenance] ${deadLinks.length} films à réparer`);

  if (deadLinks.length === 0) {
    console.log('[Maintenance] Aucun film à réparer.');
    await mongoose.disconnect();
    return;
  }

  const browser = await chromium.launch({ ...browserConfig, headless: true });
  let repaired = 0;

  for (const dl of deadLinks) {
    const ok = await rescrapeMovie(browser, dl);
    if (ok) repaired++;
  }

  await browser.close();
  console.log(`[Maintenance] Terminé. ${repaired}/${deadLinks.length} films réparés.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[Maintenance] FATAL:', err);
  process.exit(1);
});
