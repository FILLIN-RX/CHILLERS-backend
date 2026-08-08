/**
 * Diagnostic test — détermine si le problème de téléchargement est côté
 * backend (réponse API incorrecte / URL invalide) ou côté frontend
 * (le navigateur n'arrive pas à consommer l'URL fournie par le backend).
 *
 * Usage:
 *   cd backend && npx playwright test e2e/diagnose-download.spec.ts
 *
 * Pré-requis:
 *   - Backend tournant sur :4000
 *   - Frontend Next.js tournant sur :3000
 */

import { test, expect, request as playwrightRequest } from '@playwright/test';

const TARGETS = [
  { title: 'FROM', tmdbId: 124364, season: 1, episode: 1 },
  { title: 'Supergirl', tmdbId: 62688, season: 1, episode: 1 },
];
const API_BASE = 'http://localhost:4000';

for (const TARGET of TARGETS) {
test.describe(`Diagnostic download — ${TARGET.title} S${TARGET.season}E${TARGET.episode}`, () => {
  test('1) Backend : la réponse contient-elle un MP4 valide ?', async () => {
    const ctx = await playwrightRequest.newContext();
    const url = `${API_BASE}/api/doodstream/download?title=${encodeURIComponent(TARGET.title)}&tmdb_id=${TARGET.tmdbId}&season=${TARGET.season}&episode=${TARGET.episode}`;

    console.log(`\n=== TEST 1 : Backend response ===`);
    console.log(`GET ${url}`);

    const res = await ctx.get(url);
    expect(res.status()).toBe(200);
    const body = await res.json();

    console.log(`\n📦 Réponse backend :`);
    console.log(JSON.stringify(body, null, 2));

    expect(body.success).toBe(true);
    expect(body.data?.downloadUrl || body.data?.directUrl).toBeTruthy();

    const dl = body.data.downloadUrl || body.data.directUrl;
    const isMp4 = /\.mp4(\?|$)/i.test(dl);
    const isHls = /\.m3u8(\?|$)/i.test(dl);

    console.log(`\n🔍 Type d'URL :`);
    console.log(`   isMp4 = ${isMp4}`);
    console.log(`   isHls = ${isHls}`);
    console.log(`   hasUqloadCode = ${!!body.data?.uqloadCode}`);

    if (!isMp4 && !isHls) {
      console.log(`\n❌ PROBLÈME BACKEND : URL pas un MP4 ni HLS`);
      console.log(`   URL = ${dl}`);
      return;
    }

    if (isHls) {
      console.log(`\n⚠️  Backend renvoie du HLS, pas du MP4 → le navigateur ne pourra pas télécharger directement`);
    } else {
      console.log(`\n✅ Backend renvoie un MP4 direct`);
    }
  });

  test('2) Réseau : l\'URL du backend est-elle téléchargeable ?', async () => {
    const ctx = await playwrightRequest.newContext();
    const url = `${API_BASE}/api/doodstream/download?title=${encodeURIComponent(TARGET.title)}&tmdb_id=${TARGET.tmdbId}&season=${TARGET.season}&episode=${TARGET.episode}`;
    const body = await (await ctx.get(url)).json();
    const dl = body.data.downloadUrl || body.data.directUrl;

    console.log(`\n=== TEST 2 : Download direct de l'URL ===`);
    console.log(`URL = ${dl.slice(0, 150)}`);

    console.log(`\n[A] Requête nue (comme le ferait curl sans headers)`);
    const a = await ctx.get(dl, {
      headers: {},
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    console.log(`    Status: ${a.status()}`);
    console.log(`    Content-Type: ${a.headers()['content-type'] || '∅'}`);
    console.log(`    Content-Length: ${a.headers()['content-length'] || '∅'}`);

    if (a.status() === 200) {
      console.log(`    ✅ Backend peut consommer cette URL`);
    } else {
      console.log(`    ❌ Backend reçoit ${a.status()} même sans headers`);
    }

    console.log(`\n[B] Requête avec Referer = origin du frontend (simule un browser)`);
    const b = await ctx.get(dl, {
      headers: {
        'Referer': 'http://localhost:3000/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    console.log(`    Status: ${b.status()}`);
    console.log(`    Content-Type: ${b.headers()['content-type'] || '∅'}`);
    if (b.status() === 200) {
      console.log(`    ✅ Marche avec Referer (navigateur OK)`);
    } else if (b.status() === 403) {
      console.log(`    ❌ 403 avec Referer — c'est le bug du user`);
    } else {
      console.log(`    ⚠️  Status ${b.status()}`);
    }

    console.log(`\n[C] Requête avec Referer = https://uqload.is/ (Referer attendu par le CDN)`);
    const c = await ctx.get(dl, {
      headers: {
        'Referer': 'https://uqload.is/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    console.log(`    Status: ${c.status()}`);
    if (c.status() === 200) {
      console.log(`    ✅ CDN accepte quand Referer = uqload.is`);
    } else {
      console.log(`    ❌ CDN rejette même avec Referer uqload.is`);
    }
  });

  test('3) Frontend : le navigateur arrive-t-il à télécharger ?', async ({ page }) => {
    console.log(`\n=== TEST 3 : Browser end-to-end ===`);

    const requests: { url: string; status?: number; type?: string }[] = [];
    const failures: { url: string; status?: number; failure?: string }[] = [];

    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('uqload') || url.includes('vidzy') || url.includes('doodstream') || url.includes('/api/doodstream/')) {
        requests.push({ url: url.slice(0, 150) });
      }
    });

    page.on('response', (resp) => {
      const url = resp.url();
      const idx = requests.findIndex((r) => r.url === url.slice(0, 150));
      if (idx >= 0) requests[idx].status = resp.status();
    });

    page.on('requestfailed', (req) => {
      const url = req.url();
      if (url.includes('uqload') || url.includes('vidzy') || url.includes('doodstream')) {
        failures.push({ url: url.slice(0, 150), failure: req.failure()?.errorText });
      }
    });

    await page.goto(`/watch/${TARGET.tmdbId}?type=series&season=${TARGET.season}&episode=${TARGET.episode}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    console.log(`\n📄 Page chargée : ${page.url()}`);

    // Chercher le bouton de téléchargement
    const dlBtn = page.locator('button').filter({ hasText: /Télécharger|Download|télécharger/i }).first();
    const btnVisible = await dlBtn.isVisible().catch(() => false);
    console.log(`\n🔘 Bouton télécharger visible: ${btnVisible}`);

    if (!btnVisible) {
      console.log(`❌ Pas de bouton télécharger sur la page`);
      return;
    }

    // Capturer l'URL avant le clic
    console.log(`\n▶️  Click sur le bouton télécharger...`);
    await dlBtn.click();
    await page.waitForTimeout(6000);

    console.log(`\n📡 Toutes les requêtes réseau pertinentes :`);
    for (const r of requests) {
      const status = r.status ? `${r.status}` : '???';
      console.log(`   [${status}] ${r.url}`);
    }

    console.log(`\n❌ Échecs réseau :`);
    if (failures.length === 0) {
      console.log(`   (aucun)`);
    } else {
      for (const f of failures) {
        console.log(`   ${f.url} → ${f.failure}`);
      }
    }

    // Vérifier si une nouvelle page a été ouverte avec succès
    const pages = page.context().pages();
    console.log(`\n🪟 Onglets ouverts : ${pages.length}`);
    for (const [i, p] of pages.entries()) {
      console.log(`   [${i}] ${p.url()}`);
    }
  });
});
}
