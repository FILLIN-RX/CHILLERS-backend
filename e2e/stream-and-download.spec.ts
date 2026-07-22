import { test, expect } from '@playwright/test';
import { pickRandomUploadedFilm } from './helpers/film-picker';
import { pickRandomSerie } from './helpers/series-picker';

test.describe('Streaming + Download', () => {
  test('Movie: stream loads and download popup opens', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { title, tmdbId } = pickRandomUploadedFilm();
      console.log(`Attempt ${attempt}/3: "${title}" (tmdbId: ${tmdbId})`);

      try {
        await page.goto(`/media/${tmdbId}?type=movie`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForURL(/\/media\//, { timeout: 15_000 });

        await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

        const videoEl = page.locator('video[src]');
        await expect(videoEl.first()).toBeVisible({ timeout: 30_000 });
        const videoSrc = await videoEl.first().getAttribute('src');
        expect(videoSrc).toBeTruthy();
        console.log(`  ✓ Stream src: ${videoSrc?.substring(0, 70)}…`);

        // Vérifie que la vidéo est montée sans erreur
        const videoError = await page.evaluate(() => {
          const v = document.querySelector('video');
          return v ? (v.error?.message || null) : 'no video';
        });
        expect(videoError).toBeNull();
        console.log(`  ✓ Video mounted (no error)`);

        const downloadBtn = page.locator('button').filter({ hasText: /Download|Télécharger/ }).first();
        await expect(downloadBtn).toBeVisible({ timeout: 10_000 });
        await expect(downloadBtn).toBeEnabled({ timeout: 5_000 });

        // Capture the download URL via window.open interception
        await page.evaluate(() => {
          (window as any).__lastDownloadUrl = '';
          const orig = window.open;
          window.open = (url: any, target?: any) => {
            (window as any).__lastDownloadUrl = url || '';
            window.open = orig;
            return orig ? orig.call(window, url, target) : null;
          };
        });

        await downloadBtn.click();
        await page.waitForTimeout(3_000);

        const downloadUrl = await page.evaluate(() => (window as any).__lastDownloadUrl || '');
        expect(downloadUrl).toMatch(/vidzy\.cc|doodstream|uqload|\.mp4|download/i);
        console.log(`  ✓ Download: ${downloadUrl.substring(0, 80)}…`);

        await page.screenshot({ path: `e2e-movie-ok-${testInfo.project.name}.png`, fullPage: true });
        console.log(`✓ OK: "${title}" — stream + download verified`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`✗ ${message}`);
        if (attempt === 3) {
          await page.screenshot({ path: `e2e-movie-fail-${testInfo.project.name}.png`, fullPage: true });
          throw err;
        }
      }
    }
  });

  test('TV Series: episode stream loads on season page', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let serie: { titre: string; tmdbId: number; episode: { season: number; episodeNumber: number; lien: string } };
      try {
        serie = await pickRandomSerie();
      } catch (err) {
        console.log(`✗ DB error: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 3) throw err;
        continue;
      }

      const { titre, tmdbId, episode } = serie;
      const url = `/tv/${tmdbId}/season/${episode.season}`;
      console.log(`Attempt ${attempt}/3: "${titre}" → ${url}`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForURL(/\/tv\/.*\/season\//, { timeout: 15_000 });

        await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

        const videoEl = page.locator('video[src]');
        await expect(videoEl.first()).toBeVisible({ timeout: 30_000 });
        const videoSrc = await videoEl.first().getAttribute('src');
        expect(videoSrc).toBeTruthy();
        console.log(`  ✓ Stream src: ${videoSrc?.substring(0, 70)}…`);

        const videoError = await page.evaluate(() => {
          const v = document.querySelector('video');
          return v ? (v.error?.message || null) : 'no video';
        });
        expect(videoError).toBeNull();
        console.log(`  ✓ Video mounted (no error)`);

        const downloadBtn = page.locator('button').filter({ hasText: /Télécharger|Download/ }).first();
        await expect(downloadBtn).toBeVisible({ timeout: 10_000 });
        await expect(downloadBtn).toBeEnabled({ timeout: 5_000 });

        await page.evaluate(() => {
          (window as any).__lastDownloadUrl = '';
          const orig = window.open;
          window.open = (url: any, target?: any) => {
            (window as any).__lastDownloadUrl = url || '';
            window.open = orig;
            return orig ? orig.call(window, url, target) : null;
          };
        });

        await downloadBtn.click();
        await page.waitForTimeout(3_000);

        const downloadUrl = await page.evaluate(() => (window as any).__lastDownloadUrl || '');
        expect(downloadUrl).toMatch(/vidzy\.cc|doodstream|uqload|\.mp4|download/i);
        console.log(`  ✓ Download: ${downloadUrl.substring(0, 80)}…`);

        await page.screenshot({ path: `e2e-serie-ok-${testInfo.project.name}.png`, fullPage: true });
        console.log(`✓ OK: "${titre}" — stream + download verified`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`✗ ${message}`);
        if (attempt === 3) {
          await page.screenshot({ path: `e2e-serie-fail-${testInfo.project.name}.png`, fullPage: true });
          throw err;
        }
      }
    }
  });
});
