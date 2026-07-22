# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: film-download.spec.ts >> Film download flow >> view movie detail page → trigger download
- Location: e2e/film-download.spec.ts:40:7

# Error details

```
Test timeout of 120000ms exceeded.
```

```
Error: page.screenshot: Target page, context or browser has been closed
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - generic [ref=e3]:
      - generic [ref=e4]:
        - link "Chillers Logo" [ref=e5] [cursor=pointer]:
          - /url: /
          - img "Chillers Logo" [ref=e6]
        - navigation [ref=e7]:
          - link "Home" [ref=e8] [cursor=pointer]:
            - /url: /
            - text: Home
          - link "Movies" [ref=e10] [cursor=pointer]:
            - /url: /media/movies
          - link "Series" [ref=e11] [cursor=pointer]:
            - /url: /media/series
          - link "Anime" [ref=e12] [cursor=pointer]:
            - /url: /media/anime
          - link "Categories" [ref=e13] [cursor=pointer]:
            - /url: /categories
      - generic [ref=e14]:
        - button "Search" [ref=e15]:
          - img [ref=e16]
        - button "en" [ref=e19]:
          - text: en
          - img [ref=e20]
  - main [ref=e22]:
    - generic [ref=e23]:
      - button "Back" [ref=e25]:
        - img [ref=e26]
      - generic [ref=e28]:
        - img "53 dimanches" [ref=e29]
        - generic [ref=e33]:
          - generic [ref=e34]:
            - img "53 dimanches"
          - generic [ref=e35]:
            - generic [ref=e36]:
              - generic [ref=e37]: Comédie
              - generic [ref=e38]: Drame
            - heading "53 dimanches" [level=1] [ref=e39]
            - generic [ref=e40]:
              - generic [ref=e41]:
                - img [ref=e42]
                - generic [ref=e44]: "5.9"
                - generic [ref=e45]: /10
              - generic [ref=e46]:
                - img [ref=e47]
                - text: "2026"
              - generic [ref=e50]:
                - img [ref=e51]
                - text: 1h 18m
              - generic [ref=e53]: movie
            - paragraph [ref=e54]: Lorsque deux frères et leur sœur se réunissent pour discuter du devenir de leur père, leurs retrouvailles tournent rapidement au vinaigre et font resurgir de vieilles rancunes.
            - generic [ref=e55]:
              - button "Watch" [ref=e56]:
                - img [ref=e57]
                - generic [ref=e59]: Watch
              - button "Download" [ref=e60]:
                - img [ref=e61]
                - generic [ref=e63]: Download
              - button "Share" [ref=e65]:
                - img [ref=e66]
      - generic [ref=e68]:
        - generic [ref=e69]:
          - heading "Synopsis" [level=2] [ref=e70]: Synopsis
          - paragraph [ref=e72]: Lorsque deux frères et leur sœur se réunissent pour discuter du devenir de leur père, leurs retrouvailles tournent rapidement au vinaigre et font resurgir de vieilles rancunes.
        - generic [ref=e73]:
          - heading "Cast" [level=2] [ref=e74]: Cast
          - generic [ref=e76]:
            - generic [ref=e77]: Javier Cámara
            - generic [ref=e78]: Carmen Machi
            - generic [ref=e79]: Javier Gutiérrez
            - generic [ref=e80]: Alexandra Jiménez
            - generic [ref=e81]: Ricardo Lacámara
        - generic [ref=e82]:
          - heading "Watch" [level=2] [ref=e83]: Watch
          - generic [ref=e86]:
            - paragraph [ref=e90]: Chargement…
            - generic [ref=e91]:
              - generic [ref=e92]:
                - generic [ref=e93]:
                  - generic [ref=e94]: CHILLERS+
                  - heading "53 dimanches" [level=1] [ref=e96]
                - paragraph [ref=e97]: Comédie • Drame
              - generic [ref=e98]:
                - generic [ref=e99]:
                  - button "Couper le son" [ref=e100]:
                    - img [ref=e101]
                  - slider: "1"
                - button "Fermer le lecteur" [ref=e104]:
                  - img [ref=e105]
            - generic [ref=e107]:
              - generic [ref=e108]:
                - slider [ref=e109] [cursor=pointer]: "0"
                - generic [ref=e110]:
                  - generic [ref=e111]: 0:00
                  - generic [ref=e112]: 0:00
              - generic [ref=e113]:
                - generic [ref=e114]:
                  - button "Reculer de 10 secondes" [ref=e115]:
                    - img [ref=e116]
                  - button "Lire" [ref=e118]:
                    - img [ref=e119]
                  - button "Avancer de 10 secondes" [ref=e121]:
                    - img [ref=e122]
                - generic [ref=e124]:
                  - button "Download" [ref=e125]:
                    - img [ref=e126]
                  - button "Paramètres" [ref=e128]:
                    - img [ref=e129]
                  - button "Plein écran" [ref=e131]:
                    - img [ref=e132]
        - generic [ref=e134]:
          - heading "You Might Also Like" [level=2] [ref=e135]: You Might Also Like
          - generic [ref=e137]:
            - generic [ref=e138] [cursor=pointer]:
              - generic [ref=e139]:
                - img "L'Odyssée" [ref=e140]
                - img [ref=e142]
              - generic [ref=e144]:
                - heading "L'Odyssée" [level=3] [ref=e145]
                - generic [ref=e146]:
                  - generic [ref=e147]: "2026"
                  - generic [ref=e148]: •
                  - generic [ref=e149]:
                    - img [ref=e150]
                    - generic [ref=e152]: "7.8"
            - generic [ref=e153] [cursor=pointer]:
              - generic [ref=e154]:
                - img "Obsession" [ref=e155]
                - img [ref=e157]
              - generic [ref=e159]:
                - heading "Obsession" [level=3] [ref=e160]
                - generic [ref=e161]:
                  - generic [ref=e162]: "2026"
                  - generic [ref=e163]: •
                  - generic [ref=e164]:
                    - img [ref=e165]
                    - generic [ref=e167]: "8.3"
            - generic [ref=e168] [cursor=pointer]:
              - generic [ref=e169]:
                - img "Disclosure Day" [ref=e170]
                - img [ref=e172]
              - generic [ref=e174]:
                - heading "Disclosure Day" [level=3] [ref=e175]
                - generic [ref=e176]:
                  - generic [ref=e177]: "2026"
                  - generic [ref=e178]: •
                  - generic [ref=e179]:
                    - img [ref=e180]
                    - generic [ref=e182]: "6.7"
            - generic [ref=e183] [cursor=pointer]:
              - generic [ref=e184]:
                - img "Toy Story 5" [ref=e185]
                - img [ref=e187]
              - generic [ref=e189]:
                - heading "Toy Story 5" [level=3] [ref=e190]
                - generic [ref=e191]:
                  - generic [ref=e192]: "2026"
                  - generic [ref=e193]: •
                  - generic [ref=e194]:
                    - img [ref=e195]
                    - generic [ref=e197]: "7.4"
            - generic [ref=e198] [cursor=pointer]:
              - generic [ref=e199]:
                - img "Vaiana, la légende du bout du monde" [ref=e200]
                - img [ref=e202]
              - generic [ref=e204]:
                - heading "Vaiana, la légende du bout du monde" [level=3] [ref=e205]
                - generic [ref=e206]:
                  - generic [ref=e207]: "2026"
                  - generic [ref=e208]: •
                  - generic [ref=e209]:
                    - img [ref=e210]
                    - generic [ref=e212]: "5.8"
            - generic [ref=e213] [cursor=pointer]:
              - generic [ref=e214]:
                - img "Scary Movie" [ref=e215]
                - img [ref=e217]
              - generic [ref=e219]:
                - heading "Scary Movie" [level=3] [ref=e220]
                - generic [ref=e221]:
                  - generic [ref=e222]: "2026"
                  - generic [ref=e223]: •
                  - generic [ref=e224]:
                    - img [ref=e225]
                    - generic [ref=e227]: "6"
            - generic [ref=e228] [cursor=pointer]:
              - generic [ref=e229]:
                - img "Des Minions et des monstres" [ref=e230]
                - img [ref=e232]
              - generic [ref=e234]:
                - heading "Des Minions et des monstres" [level=3] [ref=e235]
                - generic [ref=e236]:
                  - generic [ref=e237]: "2026"
                  - generic [ref=e238]: •
                  - generic [ref=e239]:
                    - img [ref=e240]
                    - generic [ref=e242]: "6.4"
            - generic [ref=e243] [cursor=pointer]:
              - generic [ref=e244]:
                - img "Backrooms" [ref=e245]
                - img [ref=e247]
              - generic [ref=e249]:
                - heading "Backrooms" [level=3] [ref=e250]
                - generic [ref=e251]:
                  - generic [ref=e252]: "2026"
                  - generic [ref=e253]: •
                  - generic [ref=e254]:
                    - img [ref=e255]
                    - generic [ref=e257]: "7"
  - contentinfo [ref=e258]:
    - generic [ref=e259]:
      - generic [ref=e260]:
        - generic [ref=e261]:
          - heading "CHILLERS" [level=2] [ref=e262]
          - paragraph [ref=e263]: L'expérience ultime du streaming gratuit. Films, séries, anime — accès instantané, zéro pub.
          - paragraph [ref=e264]: Chillers ne stocke aucun fichier. Tout contenu est hébergé par des tiers non affiliés. À des fins éducatives uniquement.
        - generic [ref=e265]:
          - heading "Liens" [level=3] [ref=e266]
          - list [ref=e267]:
            - listitem [ref=e268]:
              - link "À Propos" [ref=e269] [cursor=pointer]:
                - /url: /about
                - img [ref=e270]
                - text: À Propos
            - listitem [ref=e272]:
              - link "Contact" [ref=e273] [cursor=pointer]:
                - /url: /contact
                - img [ref=e274]
                - text: Contact
            - listitem [ref=e277]:
              - link "Soutenir" [ref=e278] [cursor=pointer]:
                - /url: /support
                - img [ref=e279]
                - text: Soutenir
            - listitem [ref=e281]:
              - link "Politique de confidentialité" [ref=e282] [cursor=pointer]:
                - /url: /privacy
                - img [ref=e283]
                - text: Politique de confidentialité
        - generic [ref=e285]:
          - heading "Categories" [level=3] [ref=e286]
          - list [ref=e287]:
            - listitem [ref=e288]:
              - link "Action & Adventure" [ref=e289] [cursor=pointer]:
                - /url: /categories?genre=Action+%26+Adventure
                - img [ref=e290]
                - text: Action & Adventure
            - listitem [ref=e292]:
              - link "Sci-Fi & Cyberpunk" [ref=e293] [cursor=pointer]:
                - /url: /categories?genre=Sci-Fi+%26+Cyberpunk
                - img [ref=e294]
                - text: Sci-Fi & Cyberpunk
            - listitem [ref=e296]:
              - link "Anime Blockbusters" [ref=e297] [cursor=pointer]:
                - /url: /categories?genre=Anime
                - img [ref=e298]
                - text: Anime Blockbusters
            - listitem [ref=e300]:
              - link "Cultural Documentaries" [ref=e301] [cursor=pointer]:
                - /url: /categories?genre=Documentary
                - img [ref=e302]
                - text: Cultural Documentaries
        - generic [ref=e304]:
          - heading "Soutenir" [level=3] [ref=e305]
          - paragraph [ref=e306]: Le projet vit grâce à vos dons. Orange Money & Mobile Money acceptés.
          - link "Nous soutenir" [ref=e307] [cursor=pointer]:
            - /url: /support
            - img [ref=e308]
            - text: Nous soutenir
        - generic [ref=e310]:
          - heading "Join the Chill" [level=3] [ref=e311]
          - paragraph [ref=e312]: Follow us on social channels to keep up with premier releases.
          - generic [ref=e313]:
            - button "X (Twitter)" [ref=e314]: 𝕏
            - button "Facebook" [ref=e315]: f
            - button "Instagram" [ref=e316]:
              - img [ref=e317]
            - button "YouTube" [ref=e320]: ▶
      - generic [ref=e321]:
        - generic [ref=e322]: © 2026 Chillers. No rights reserved.
        - generic [ref=e323]:
          - link "À Propos" [ref=e324] [cursor=pointer]:
            - /url: /about
            - img [ref=e325]
            - text: À Propos
          - generic [ref=e327]: •
          - link "Contact" [ref=e328] [cursor=pointer]:
            - /url: /contact
            - img [ref=e329]
            - text: Contact
          - generic [ref=e332]: •
          - link "Confidentialité" [ref=e333] [cursor=pointer]:
            - /url: /privacy
            - img [ref=e334]
            - text: Confidentialité
  - button "Open Next.js Dev Tools" [ref=e341] [cursor=pointer]:
    - img [ref=e342]
  - alert [ref=e345]
```

# Test source

```ts
  1  | import { test, expect, Page } from '@playwright/test';
  2  | import { pickRandomUploadedFilm } from './helpers/film-picker';
  3  | 
  4  | async function runFlow(page: Page, title: string, tmdbId: number) {
  5  |   // Navigate directly to the movie detail page
  6  |   // (search overlay has a bug: local MongoDB entries use _id instead of tmdbId)
  7  |   await page.goto(`/media/${tmdbId}?type=movie`, { waitUntil: 'domcontentloaded' });
  8  |   await page.waitForURL(/\/media\//, { timeout: 15_000 });
  9  | 
  10 |   // Wait for the movie title to appear (page content loaded)
  11 |   const heading = page.locator('h1').first();
  12 |   await expect(heading).toBeVisible({ timeout: 15_000 });
  13 |   const text = await heading.innerText();
  14 |   expect(text.trim().length).toBeGreaterThan(0);
  15 | 
  16 |   // Wait until the download button is ready (not in loading/disabled state).
  17 |   // The download button shows "Télécharger" text when the stream is ready,
  18 |   // and "Bientôt disponible" when unavailable.
  19 |   // We wait up to 25s for the stream to resolve.
  20 |   const downloadBtn = page.getByRole('button', { name: /Télécharger/ });
  21 | 
  22 |   try {
  23 |     await expect(downloadBtn).toBeVisible({ timeout: 25_000 });
  24 |     await expect(downloadBtn).toBeEnabled({ timeout: 5_000 });
  25 |   } catch {
  26 |     throw new Error(`Film "${title}" (tmdbId: ${tmdbId}) — Téléchargement non disponible`);
  27 |   }
  28 | 
  29 |   // Click download → startDownload → triggerDownload → popup
  30 |   const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
  31 |   await downloadBtn.click();
  32 |   const popup = await popupPromise;
  33 | 
  34 |   const popupUrl = popup.url();
  35 |   expect(popupUrl).toMatch(/vidzy\.cc|doodstream|\.mp4|download/i);
  36 |   await popup.close();
  37 | }
  38 | 
  39 | test.describe('Film download flow', () => {
  40 |   test('view movie detail page → trigger download', async ({ page }, testInfo) => {
  41 |     for (let attempt = 1; attempt <= 5; attempt++) {
  42 |       const { title, tmdbId } = pickRandomUploadedFilm();
  43 |       console.log(`Attempt ${attempt}/5: "${title}" (tmdbId: ${tmdbId})`);
  44 | 
  45 |       try {
  46 |         await runFlow(page, title, tmdbId);
  47 |         await page.screenshot({ path: `e2e-success-${testInfo.project.name}.png`, fullPage: true });
  48 |         console.log(`✓ OK: "${title}"`);
  49 |         return;
  50 |       } catch (err) {
  51 |         const message = err instanceof Error ? err.message : String(err);
  52 |         console.log(`✗ ${message}`);
  53 |         if (attempt === 5) {
> 54 |           await page.screenshot({ path: `e2e-failure-${testInfo.project.name}.png`, fullPage: true });
     |                      ^ Error: page.screenshot: Target page, context or browser has been closed
  55 |           throw err;
  56 |         }
  57 |       }
  58 |     }
  59 |   });
  60 | });
  61 | 
```