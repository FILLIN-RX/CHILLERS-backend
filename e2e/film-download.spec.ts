import { test, expect, Page } from '@playwright/test';
import { pickRandomUploadedFilm } from './helpers/film-picker';

async function runFlow(page: Page, title: string, tmdbId: number) {
  // Navigate directly to the movie detail page
  // (search overlay has a bug: local MongoDB entries use _id instead of tmdbId)
  await page.goto(`/media/${tmdbId}?type=movie`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/media\//, { timeout: 15_000 });

  // Wait for the movie title to appear (page content loaded)
  const heading = page.locator('h1').first();
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const text = await heading.innerText();
  expect(text.trim().length).toBeGreaterThan(0);

  // Wait until the download button is ready (not in loading/disabled state).
  // The download button shows "Télécharger" text when the stream is ready,
  // and "Bientôt disponible" when unavailable.
  // We wait up to 25s for the stream to resolve.
  const downloadBtn = page.getByRole('button', { name: /Télécharger/ });

  try {
    await expect(downloadBtn).toBeVisible({ timeout: 25_000 });
    await expect(downloadBtn).toBeEnabled({ timeout: 5_000 });
  } catch {
    throw new Error(`Film "${title}" (tmdbId: ${tmdbId}) — Téléchargement non disponible`);
  }

  // Click download → startDownload → triggerDownload → popup
  const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
  await downloadBtn.click();
  const popup = await popupPromise;

  const popupUrl = popup.url();
  expect(popupUrl).toMatch(/vidzy\.cc|doodstream|\.mp4|download/i);
  await popup.close();
}

test.describe('Film download flow', () => {
  test('view movie detail page → trigger download', async ({ page }, testInfo) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const { title, tmdbId } = pickRandomUploadedFilm();
      console.log(`Attempt ${attempt}/5: "${title}" (tmdbId: ${tmdbId})`);

      try {
        await runFlow(page, title, tmdbId);
        await page.screenshot({ path: `e2e-success-${testInfo.project.name}.png`, fullPage: true });
        console.log(`✓ OK: "${title}"`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`✗ ${message}`);
        if (attempt === 5) {
          await page.screenshot({ path: `e2e-failure-${testInfo.project.name}.png`, fullPage: true });
          throw err;
        }
      }
    }
  });
});
