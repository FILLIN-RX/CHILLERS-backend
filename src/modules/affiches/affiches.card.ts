import { chromium, Browser } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return browserPromise;
}

export interface CardData {
  titre: string;
  year?: number;
  type: 'movie' | 'series';
  speech?: string | null;
  posterUrl?: string | null;
  link?: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function generateCardPNG(data: CardData): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

  const title = escapeHtml(data.titre);
  const speech = escapeHtml(data.speech || '');
  const typeLabel = data.type === 'movie' ? 'FILM' : 'SÉRIE';
  const poster = data.posterUrl ? `src="${escapeHtml(data.posterUrl)}"` : '';
  const link = data.link ? escapeHtml(data.link) : '';
  const year = data.year ? String(data.year) : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; overflow: hidden; font-family: 'Inter', system-ui, sans-serif; }
  .card { position: relative; width: 100%; height: 100%; background: #0b0b12; display: flex; }
  .backdrop { position: absolute; inset: 0; background-size: cover; background-position: center; filter: blur(45px) saturate(1.3); opacity: 0.45; transform: scale(1.2); }
  .overlay { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(8,8,14,0.92) 0%, rgba(8,8,14,0.65) 55%, rgba(8,8,14,0.85) 100%); }
  .poster-wrap { position: relative; width: 300px; height: 450px; margin: 90px 0 0 90px; flex-shrink: 0; z-index: 2; }
  .poster { width: 100%; height: 100%; object-fit: cover; border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,0.7); border: 1px solid rgba(255,255,255,0.08); }
  .poster-fallback { width: 100%; height: 100%; border-radius: 14px; background: linear-gradient(160deg, #23233a, #12121c); display: flex; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,0.08); }
  .poster-fallback span { color: #3c3c55; font-weight: 800; font-size: 40px; letter-spacing: 0.08em; }
  .info { position: relative; z-index: 2; padding: 100px 70px 60px 55px; flex: 1; display: flex; flex-direction: column; justify-content: center; min-width: 0; }
  .brand { color: #8b5cf6; font-weight: 800; font-size: 15px; letter-spacing: 0.35em; text-transform: uppercase; margin-bottom: 18px; }
  .type-chip { display: inline-block; color: #a5b4fc; border: 1px solid rgba(165,180,252,0.35); border-radius: 999px; padding: 4px 14px; font-size: 12px; font-weight: 700; letter-spacing: 0.2em; margin-bottom: 16px; width: fit-content; }
  .title { color: #fff; font-size: 42px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }
  .year { color: #8a8aa3; font-size: 20px; font-weight: 600; margin-top: 8px; }
  .speech { margin-top: 26px; color: #c7c7d6; font-size: 17px; line-height: 1.55; font-weight: 400; max-width: 560px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .link { margin-top: auto; padding-top: 40px; color: #6b6b84; font-size: 14px; letter-spacing: 0.02em; font-weight: 500; }
  .link b { color: #a5b4fc; font-weight: 700; }
  .footer { position: absolute; bottom: 26px; right: 60px; color: rgba(139,92,246,0.55); font-size: 12px; font-weight: 700; letter-spacing: 0.3em; z-index: 2; }
</style>
</head>
<body>
  <div class="card">
    <div class="backdrop" ${poster ? `style="background-image:url('${escapeHtml(data.posterUrl || '')}')"` : ''}></div>
    <div class="overlay"></div>
    <div class="poster-wrap">
      ${poster
        ? `<img class="poster" ${poster} alt="" />`
        : `<div class="poster-fallback"><span>🎬</span></div>`}
    </div>
    <div class="info">
      <div class="brand">CHILLERS</div>
      <span class="type-chip">${typeLabel}</span>
      <div class="title">${title}</div>
      ${year ? `<div class="year">${year}</div>` : ''}
      ${speech ? `<div class="speech">${speech}</div>` : ''}
      <div class="link">Regarder sur <b>chillers</b> — ${link || 'chillers.fr'}</div>
    </div>
    <div class="footer">CHILLERS STREAMING</div>
  </div>
</body>
</html>`;

  try {
    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    }
    if (poster) {
      try {
        await page.waitForFunction(
          () => {
            const img = document.querySelector('img.poster') as HTMLImageElement;
            return img && img.complete && img.naturalWidth > 0;
          },
          { timeout: 10000 },
        );
      } catch {
        // image indisponible → on capture quand même avec le fond flouté
      }
    }
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}
