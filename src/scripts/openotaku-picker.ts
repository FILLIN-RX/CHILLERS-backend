import { chromium, type Page } from 'playwright';
import { connectDB } from '../config/db';
import Movie from '../models/Movie';
import Serie from '../models/Serie';
import { UqloadClient } from '../modules/uqload/uqload.client';
import { saveAndUpload } from '../modules/uqload/uqload.uploader';

interface DetectPayload {
  url?: string;
  title?: string;
  type?: 'movie' | 'series';
  episode?: string;
  season?: number;
  pageUrl?: string;
  __reqId?: string;
}

interface EpisodeInfo {
  label: string;
  url: string;
  episodeNum?: number;
}

interface DetectResult {
  liens: EpisodeInfo[];
  titre: string;
  cleanTitle: string;
  type: 'movie' | 'series';
  season?: number;
  year?: number;
  dbStatus: 'existing' | 'new' | 'unknown';
  dbId?: string;
  pageUrl?: string;
  duplicates?: Record<string, boolean>;
}

interface UploadResult {
  success: boolean;
  fileCode?: string;
  directLink?: string;
  qualities?: number;
  message: string;
  __reqId?: string;
}

function parseEpisodeLabel(label: string, defaultSeason = 1): { season: number; episodeNumber: number; canonical: string } {
  const trimmed = label.trim();
  const sxxExx = trimmed.match(/S(\d+)\s*E\s*(\d+)/i);
  if (sxxExx) {
    const season = parseInt(sxxExx[1], 10);
    const num = parseInt(sxxExx[2], 10);
    return { season, episodeNumber: num, canonical: `S${String(season).padStart(2, "0")}E${String(num).padStart(2, "0")}` };
  }
  const epWord = trimmed.match(/(?:Ép|Ep|Episode)\s*\.?\s*(\d+)/i);
  if (epWord) {
    const num = parseInt(epWord[1], 10);
    return { season: defaultSeason, episodeNumber: num, canonical: `S${String(defaultSeason).padStart(2, "0")}E${String(num).padStart(2, "0")}` };
  }
  return { season: defaultSeason, episodeNumber: 0, canonical: trimmed };
}

function parseTitleAndSeason(rawTitle: string): { cleanTitle: string; season?: number; year?: number } {
  if (!rawTitle) return { cleanTitle: '' };
  const seasonMatch = rawTitle.match(/(?:saison|season|s)\s*(\d+)/i);
  let season: number | undefined;
  if (seasonMatch) season = parseInt(seasonMatch[1], 10);
  const yearMatch = rawTitle.match(/(\d{4})$/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
  let cleanTitle = rawTitle
    .replace(/(?:saison|season|s)\s*\d+/gi, '')
    .replace(/\b(vostfr|vf|french|1080p|720p)\b/gi, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+\d{4}$/, '')
    .trim();
  return { cleanTitle: cleanTitle || rawTitle, season, year };
}

async function checkDuplicates(
  title: string,
  type: 'movie' | 'series',
  season: number,
  liens: EpisodeInfo[],
): Promise<Record<string, boolean>> {
  const duplicates: Record<string, boolean> = {};
  const escaped = title.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const query = { titre: new RegExp(`^${escaped}$`, 'i') };

  if (type === 'series') {
    const serie = await Serie.findOne(query);
    if (serie) {
      liens.forEach((l, i) => {
        const epNum = l.episodeNum;
        if (epNum) {
          duplicates[String(i)] = serie.episodes.some((ep) => ep.season === season && ep.episodeNumber === epNum && ep.uqloadCode != null);
        } else {
          duplicates[String(i)] = l.url ? serie.episodes.some((ep) => ep.lien === l.url) : false;
        }
      });
    }
  } else {
    const movie = await Movie.findOne(query);
    if (movie) {
      liens.forEach((l, i) => {
        duplicates[String(i)] = !!(movie.lien && movie.lien === l.url);
      });
    }
  }
  return duplicates;
}

async function detectVideo(page: Page, payload: DetectPayload): Promise<DetectResult> {
  let rawTitle = payload.title || '';
  let type = payload.type || 'movie';

  if (!rawTitle) {
    rawTitle = await page.evaluate(() => {
      const el =
        document.querySelector('.fs-card-title') ||
        document.querySelector('#fs-watch-title') ||
        document.querySelector('h1') ||
        document.querySelector('.entry-title') ||
        document.querySelector('.anime-title');
      return el ? (el as HTMLElement).innerText.trim() : '';
    });
  }

  const { cleanTitle, season: extractedSeason, year } = parseTitleAndSeason(rawTitle);
  const season = payload.season || extractedSeason || 1;

  if (!payload.type) {
    const hasEpisodeSelect = await page.evaluate(() => {
      return !!(
        document.querySelector('#fs-episode-select') ||
        document.querySelector('.fs-episode-grid') ||
        document.querySelector('.episodes-list')
      );
    });
    if (hasEpisodeSelect || extractedSeason) type = 'series';
  }

  const liens: EpisodeInfo[] = await page.evaluate(() => {
    const results: EpisodeInfo[] = [];
    const epSelect = document.querySelector('#fs-episode-select');
    if (epSelect) {
      const options = epSelect.querySelectorAll('option');
      options.forEach((opt, idx) => {
        const val = opt.getAttribute('value') || '';
        const label = opt.innerText.trim();
        if (val && val !== '#') {
          results.push({ label: label || `Épisode ${idx + 1}`, url: val, episodeNum: idx + 1 });
        }
      });
    }
    if (results.length === 0) {
      const epLinks = document.querySelectorAll('.fs-episode-grid a, .episodes-list a');
      epLinks.forEach((a, idx) => {
        const href = a.getAttribute('href');
        const text = (a as HTMLElement).innerText.trim();
        if (href && href !== '#') {
          results.push({ label: text || `Épisode ${idx + 1}`, url: href, episodeNum: idx + 1 });
        }
      });
    }
    if (results.length === 0) {
      const a = document.querySelector('a#fs-dl-link, a.btn-download');
      if (a && a.getAttribute('href') && a.getAttribute('href') !== '#') {
        results.push({ label: 'Download Direct', url: a.getAttribute('href')! });
      }
    }
    return results;
  });

  const pageUrl = page.url();
  let dbStatus: DetectResult['dbStatus'] = 'unknown';
  let dbId: string | undefined;
  const finalTitle = cleanTitle || rawTitle;

  if (finalTitle) {
    const query = { titre: new RegExp(`^${finalTitle.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') };
    if (type === 'series') {
      const serie = await Serie.findOne(query);
      if (serie) { dbStatus = 'existing'; dbId = serie._id.toString(); } else { dbStatus = 'new'; }
    } else {
      const movie = await Movie.findOne(query);
      if (movie) { dbStatus = 'existing'; dbId = movie._id.toString(); } else { dbStatus = 'new'; }
    }
  }

  const duplicates = finalTitle ? await checkDuplicates(finalTitle, type, season, liens) : {};

  return { liens, titre: rawTitle, cleanTitle: finalTitle, type, season, year, dbStatus, dbId, pageUrl, duplicates };
}

async function uploadVideo(payload: DetectPayload, uqload: UqloadClient): Promise<UploadResult> {
  const { url, title, type, episode, season = 1, pageUrl } = payload;
  if (!url) return { success: false, message: 'URL manquante' };
  if (!title) return { success: false, message: 'Titre manquant' };

  const { cleanTitle: dbTitle, year } = parseTitleAndSeason(title);
  const finalTitle = dbTitle || title;

  const epMatch = episode?.match(/(\d+)/);
  const epNum = epMatch ? parseInt(epMatch[1], 10) : 1;

  try {
    const result = await saveAndUpload(uqload, {
      type: type as 'movie' | 'series',
      titre: finalTitle,
      pageUrl: pageUrl || '',
      url,
      year,
      season,
      episodeLabel: type === 'series' ? `S${String(season).padStart(2, '0')}E${String(epNum).padStart(2, '0')}` : undefined,
      episodeNumber: type === 'series' ? epNum : undefined,
    });

    if (!result.success) {
      const msg = result.message?.includes('max URLs') ? 'Limite Uqload atteinte (500 max), supprime d\'anciens fichiers' : result.message || 'Erreur';
      return { success: false, message: msg };
    }

    return {
      success: true,
      fileCode: result.fileCode,
      directLink: result.directLink,
      qualities: 0,
      message: `OK (${result.fileCode})`,
    };
  } catch (e: any) {
    const msg = e.message?.includes('max URLs') ? 'Limite Uqload atteinte (500 max), supprime d\'anciens fichiers' : `Erreur: ${e.message}`;
    return { success: false, message: msg };
  }
}

async function scanAllEpisodes(page: Page): Promise<DetectResult> {
  const liens: EpisodeInfo[] = [];
  let rawTitle = '';
  let finalSeason = 1;
  let finalYear: number | undefined;

  const epSelect = await page.$('#fs-episode-select');
  if (!epSelect) {
    console.log(`[OTAKU] ✗ Pas de sélecteur d'épisodes sur cette page`);
    return { liens: [], titre: '', cleanTitle: '', type: 'series', season: 1, dbStatus: 'new', pageUrl: page.url() };
  }

  try {
    rawTitle = await page.$eval('#fs-watch-title', (el: any) => el.innerText.trim());
  } catch {
    rawTitle = await page.$eval('.fs-card-title', (el: any) => el.innerText.trim()).catch(() => '');
  }
  const { cleanTitle, season: extractedSeason, year } = parseTitleAndSeason(rawTitle);
  finalSeason = extractedSeason || 1;
  finalYear = year;

  const seasonMatch = rawTitle.match(/Saison (\d+)/i);
  const defaultSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : (extractedSeason || 1);

  async function log(msg: string, t?: string) {
    try { await page.evaluate(([m, s]) => (window as any).otakuAddLog?.(m, s), [msg, t || ''] as [string, string]); } catch {}
  }
  async function setProgress(current: number, total: number) {
    try { await page.evaluate(([c, t]) => (window as any).otakuSetProgress?.(c, t), [current, total] as [number, number]); } catch {}
  }

  console.log(`[OTAKU] ○ Scan tous les épisodes: ${cleanTitle || rawTitle} (S${String(finalSeason).padStart(2, '0')})`);
  await log(`Scan: ${cleanTitle || rawTitle}`);
  await setProgress(1, -1);

  let idx = 0;
  while (true) {
    try {
      await page.waitForSelector('#fs-episode-select', { state: 'attached', timeout: 5000 });
    } catch { break; }
    const epTitre = await page.$eval('#fs-episode-select option:checked', (el: any) => el.innerText.trim());
    await log(`Clic download: ${epTitre}...`);
    await page.evaluate(() => {
      const link = document.querySelector('a#fs-dl-link');
      if (link) link.removeAttribute('href');
    });
    await page.click('button#fs-quick-download', { force: true });
    try {
      await page.waitForFunction(() => {
        const a = document.querySelector('a#fs-dl-link');
        if (!a) return false;
        const href = a.getAttribute('href');
        return href && href !== '#' && href.length > 10;
      }, { timeout: 15000 });
    } catch {}
    const dlLink = await page.$('a#fs-dl-link');
    const link = dlLink ? await dlLink.getAttribute('href') : '#';

    if (link && link !== '#') {
      const { season, episodeNumber, canonical } = parseEpisodeLabel(epTitre, defaultSeason);
      liens.push({ label: canonical, url: link, episodeNum: episodeNumber });
      console.log(`[OTAKU]   ✓ ${epTitre} → ${link.substring(0, 70)}`);
      await log(`✓ ${epTitre} → ${link.substring(0, 50)}...`, 'success');
    } else {
      await log(`✗ ${epTitre} — lien invalide`, 'error');
    }

    await page.evaluate(() => {
      document.querySelector('#fs-donate-overlay')?.remove();
      (document.querySelector('button#fs-modal-close') as HTMLElement)?.click();
    });
    await page.waitForTimeout(2000);
    const nextBtn = await page.$('button#fs-next-ep');
    if (!nextBtn || !(await nextBtn.isEnabled())) break;
    await nextBtn.click();
    await page.waitForTimeout(5000);
    idx++;
    await setProgress(idx, idx + 1);
  }

  console.log(`[OTAKU] ✓ Scan terminé: ${liens.length} épisode(s)`);
  await log(`${liens.length} épisode(s) trouvé(s)`, liens.length > 0 ? 'success' : 'error');
  await setProgress(0, 0);
  return {
    liens,
    titre: rawTitle,
    cleanTitle: cleanTitle || rawTitle,
    type: 'series',
    season: finalSeason,
    year: finalYear,
    dbStatus: 'unknown',
    pageUrl: page.url(),
  };
}

async function scanPage(page: Page, payload: { title?: string; type?: string; season?: number }): Promise<DetectResult> {
  let rawTitle = payload.title || '';
  if (!rawTitle) {
    rawTitle = await page.evaluate(() => {
      const el =
        document.querySelector('.fs-card-title') ||
        document.querySelector('#fs-watch-title') ||
        document.querySelector('h1') ||
        document.querySelector('.entry-title') ||
        document.querySelector('.anime-title');
      return el ? (el as HTMLElement).innerText.trim() : '';
    });
  }
  const { cleanTitle, season: extractedSeason, year } = parseTitleAndSeason(rawTitle);
  const detectedType = payload.type || await page.evaluate(() => {
    return document.querySelector('#fs-episode-select') ? 'series' : 'movie';
  });
  const type = detectedType as 'movie' | 'series';
  const season = payload.season || extractedSeason || 1;
  const liens: EpisodeInfo[] = [];

  async function log(msg: string, t?: string) {
    try { await page.evaluate(([m, s]) => (window as any).otakuAddLog?.(m, s), [msg, t || ''] as [string, string]); } catch {}
  }

  async function setProgress(current: number, total: number) {
    try { await page.evaluate(([c, t]) => (window as any).otakuSetProgress?.(c, t), [current, total] as [number, number]); } catch {}
  }

  if (type === 'movie') {
    await log('Détection film...');
    console.log(`[OTAKU]   ● Film: ${cleanTitle || rawTitle || 'inconnu'}`);
    const dlBtn = page.locator('button#fs-quick-download');
    if (await dlBtn.count() > 0) {
      await log('Clic sur le bouton download...');
      console.log(`[OTAKU]   ▸ Clic download...`);
      await dlBtn.first().click({ force: true });

      try {
        await page.waitForSelector('#fs-download-modal:not(.hidden)', { timeout: 8000 });
        await log('Modal ouvert, extraction du lien...');
        console.log(`[OTAKU]   ▸ Modal ouvert, extraction...`);
      } catch {
        await log('Modal non ouvert après clic', 'error');
        console.log(`[OTAKU]   ✗ Modal non ouvert`);
      }

      try {
        await page.waitForFunction(() => {
          const a = document.querySelector('a#fs-dl-link');
          if (!a) return false;
          const href = a.getAttribute('href');
          return href && href !== '#' && href.length > 10;
        }, { timeout: 20000 });
        await log('Lien extrait !', 'success');
        console.log(`[OTAKU]   ✓ Lien extrait`);
      } catch {
        await log('Timeout attente lien (20s)', 'error');
        console.log(`[OTAKU]   ✗ Timeout lien (20s)`);
      }

      const dlLink = page.locator('a#fs-dl-link');
      if (await dlLink.count() > 0) {
        const href = await dlLink.first().getAttribute('href');
        if (href && href !== '#') {
          liens.push({ label: 'Download Direct', url: href });
          await log('Lien trouvé: ' + href.substring(0, 80), 'success');
        } else {
          await log('Lien invalide (#)', 'error');
        }
      } else {
        await log('Aucun lien trouvé après clic', 'error');
      }

      await page.evaluate(() => {
        (document.querySelector('button#fs-modal-close') as HTMLElement)?.click();
        document.querySelectorAll('#fs-download-modal, .fs-modal-overlay').forEach(el => el.classList?.add('hidden'));
      }).catch(() => {});
    } else {
      await log('Bouton download introuvable', 'error');
    }
  } else {
    await log('Détection série...');
    console.log(`[OTAKU]   ● Série: ${cleanTitle || rawTitle || 'inconnu'} (S${String(season).padStart(2, '0')})`);

    // Sélection courante
    const epTitre = await page.evaluate(() => {
      const select = document.querySelector('#fs-episode-select') as HTMLSelectElement | null;
      return select?.options[select.selectedIndex]?.text?.trim() || 'Épisode courant';
    });
    await log('Épisode: ' + epTitre);
    console.log(`[OTAKU]   ● ${epTitre}`);

    const dlBtn = page.locator('button#fs-quick-download');
    if (await dlBtn.count() > 0) {
      await log('Clic download...');
      console.log(`[OTAKU]   ▸ Clic download...`);
      await dlBtn.first().click({ force: true });

      try {
        await page.waitForSelector('#fs-download-modal:not(.hidden)', { timeout: 8000 });
        console.log(`[OTAKU]   ▸ Modal ouvert`);
      } catch {
        await log('Modal non ouvert', 'error');
        console.log(`[OTAKU]   ✗ Modal non ouvert`);
      }

      try {
        await page.waitForFunction(() => {
          const a = document.querySelector('a#fs-dl-link');
          if (!a) return false;
          const href = a.getAttribute('href');
          return href && href !== '#' && href.length > 10;
        }, { timeout: 20000 });
      } catch {}

      const dlLink = page.locator('a#fs-dl-link');
      if (await dlLink.count() > 0) {
        const href = await dlLink.first().getAttribute('href');
        if (href && href !== '#') {
          const epMatch = epTitre.match(/(\d+)/);
          liens.push({ label: epTitre, url: href, episodeNum: epMatch ? parseInt(epMatch[1], 10) : undefined });
          await log('✓ ' + epTitre + ' → ' + href.substring(0, 50) + '...', 'success');
          console.log(`[OTAKU]   ✓ ${epTitre} → ${href.substring(0, 70)}`);
        } else {
          await log('✗ ' + epTitre + ' — lien invalide', 'error');
          console.log(`[OTAKU]   ✗ ${epTitre} — lien invalide`);
        }
      } else {
        await log('✗ ' + epTitre + ' — aucun lien', 'error');
        console.log(`[OTAKU]   ✗ ${epTitre} — aucun lien`);
      }

      await page.evaluate(() => {
        (document.querySelector('button#fs-modal-close') as HTMLElement)?.click();
        document.querySelectorAll('#fs-download-modal, .fs-modal-overlay').forEach(el => el.classList?.add('hidden'));
      }).catch(() => {});
    } else {
      await log('Bouton download introuvable', 'error');
    }
  }

  await setProgress(0, 0);
  await log(liens.length + ' lien(s) trouvé(s)', liens.length > 0 ? 'success' : 'error');

  const finalTitle = cleanTitle || rawTitle;
  let dbStatus: DetectResult['dbStatus'] = 'unknown';
  let dbId: string | undefined;

  if (finalTitle) {
    const escaped = finalTitle.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const query = { titre: new RegExp(`^${escaped}$`, 'i') };
    if (type === 'series') {
      const serie = await Serie.findOne(query);
      if (serie) { dbStatus = 'existing'; dbId = serie._id.toString(); } else { dbStatus = 'new'; }
    } else {
      const movie = await Movie.findOne(query);
      if (movie) { dbStatus = 'existing'; dbId = movie._id.toString(); } else { dbStatus = 'new'; }
    }
  }

  const duplicates = finalTitle ? await checkDuplicates(finalTitle, type, season, liens) : {};

  return {
    liens, titre: rawTitle, cleanTitle: finalTitle, type,
    season, year, dbStatus, dbId, pageUrl: page.url(), duplicates,
  };
}

const SVG = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M7 11l5 5 5-5"/><path d="M12 4v12"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>',
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 7h20M2 17h20"/></svg>',
  detect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M21 5v14c0 1.66-4 3-9 3s-9-1.34-9-3V5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="1"/><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><rect x="8" y="8" width="12" height="12" rx="2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

const injectUIScriptCode = `
(function() {
  if (document.getElementById('otaku-picker-container')) return;

  // Load Tailwind CDN
  if (!document.getElementById('otaku-tw-cdn')) {
    const tw = document.createElement('script');
    tw.id = 'otaku-tw-cdn';
    tw.src = 'https://cdn.tailwindcss.com';
    document.head.appendChild(tw);
  }

  if (!document.getElementById('otaku-tw-reset')) {
    const s = document.createElement('style');
    s.id = 'otaku-tw-reset';
    s.textContent = '#otaku-picker-container svg { width: 14px; height: 14px; }';
    document.head.appendChild(s);
  }

  const svgIcons = ${JSON.stringify(SVG)};
  function icon(name) { return svgIcons[name] || ''; }

  const container = document.createElement('div');
  container.id = 'otaku-picker-container';
  container.style.cssText = 'all:initial;position:fixed;bottom:28px;right:28px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;';
  container.innerHTML = \`
    <button id="otaku-picker-btn" class="flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-red-600 to-red-800 border-none cursor-pointer shadow-lg shadow-red-600/40 hover:scale-110 transition-all duration-200">
      \${icon('download')}
    </button>
    <div id="otaku-picker-panel" class="fixed bottom-24 right-7 z-[999999] w-[520px] max-h-[85vh] flex flex-col bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl shadow-black/60 opacity-0 pointer-events-none translate-y-3 transition-all duration-300 overflow-hidden data-[open]:opacity-100 data-[open]:pointer-events-auto data-[open]:translate-y-0">
      <div class="flex items-center justify-between px-7 pt-6 pb-4 border-b border-white/5">
        <div class="flex items-center gap-3">
          <span class="text-red-500 w-6 h-6 inline-block">\${icon('film')}</span>
          <h3 class="text-lg font-bold text-white m-0">Otaku</h3>
          <span class="text-[10px] font-bold uppercase tracking-widest text-red-500 bg-red-500/10 px-2 py-0.5 rounded">Picker</span>
        </div>
        <button id="otaku-close-btn" class="flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 border-none text-gray-500 cursor-pointer hover:bg-white/10 hover:text-white transition-all">
          \${icon('close')}
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-7 pt-6 pb-7 space-y-5">
        <div>
          <label class="block text-[11px] font-semibold uppercase tracking-wider text-white/30 mb-2">Titre</label>
          <input class="w-full px-3.5 py-2.5 bg-white/5 border border-white/8 rounded-lg text-white text-sm outline-none focus:border-red-500 placeholder:text-white/20 transition-colors" id="otaku-title" placeholder="Détection automatique..." />
        </div>

        <div class="flex gap-3.5">
          <div class="flex-1">
            <label class="block text-[11px] font-semibold uppercase tracking-wider text-white/30 mb-2">Type</label>
            <select class="w-full px-3.5 py-2.5 bg-white/5 border border-white/8 rounded-lg text-white text-sm outline-none focus:border-red-500" id="otaku-type">
              <option value="movie">Film</option>
              <option value="series">Série</option>
            </select>
          </div>
          <div id="otaku-season-group" class="w-20">
            <label class="block text-[11px] font-semibold uppercase tracking-wider text-white/30 mb-2">Saison</label>
            <input class="w-full px-3.5 py-2.5 bg-white/5 border border-white/8 rounded-lg text-white text-sm outline-none focus:border-red-500" id="otaku-season" type="number" value="1" min="1" />
          </div>
        </div>

        <div id="otaku-db-badge" class="flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-white/[0.03] text-white/40 border border-white/5">
          \${icon('database')}
          <span>Analyse du contenu...</span>
        </div>

        <div id="otaku-progress" class="hidden mb-5">
          <div class="flex justify-between text-xs text-white/40 mb-1.5">
            <span id="otaku-progress-label">Scan en cours...</span>
            <span id="otaku-progress-pct">0%</span>
          </div>
          <div class="w-full h-1 bg-white/5 rounded overflow-hidden">
            <div class="h-full bg-red-600 rounded transition-all duration-300 w-0" id="otaku-progress-fill"></div>
          </div>
        </div>

        <div class="flex items-center gap-3 mb-4">
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" id="otaku-auto-upload" class="sr-only peer" />
            <div class="w-9 h-5 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white/40 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-red-600 peer-checked:after:bg-white"></div>
          </label>
          <span class="text-[13px] text-white/50 font-medium">Upload auto après scan</span>
        </div>

        <button id="otaku-scan-btn" class="w-full py-3 px-4 rounded-xl border-none cursor-pointer font-bold text-sm bg-red-600 text-white flex items-center justify-center gap-2.5 hover:bg-red-500 transition-colors disabled:opacity-35 disabled:cursor-not-allowed">
          \${icon('scan')}
          Scanner la page
        </button>

        <button id="otaku-scan-all-btn" class="w-full py-3 px-4 rounded-xl border-none cursor-pointer font-bold text-sm bg-amber-600 text-white flex items-center justify-center gap-2.5 hover:bg-amber-500 transition-colors disabled:opacity-35 disabled:cursor-not-allowed mt-2.5">
          \${icon('list')}
          Scanner tous les épisodes
        </button>

        <hr class="border-0 border-t border-white/5 my-5" />

        <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/25 mb-3">
          \${icon('list')}
          <span>Liens détectés</span>
        </div>

        <div class="max-h-[300px] overflow-y-auto rounded-xl bg-black/30 p-1.5 space-y-0.5" id="otaku-episodes-list">
          <div class="py-5 text-center text-white/20 text-sm">
            Appuie sur "Scanner la page" pour détecter les liens
          </div>
        </div>

        <button id="otaku-upload-all-btn" class="hidden w-full py-3 rounded-lg border-none cursor-pointer font-bold text-[13px] bg-emerald-500/10 text-emerald-400 flex items-center justify-center gap-2 hover:bg-emerald-500/20 transition-colors mt-3 disabled:opacity-30 disabled:cursor-not-allowed">
          \${icon('upload')}
          Uploader tous les épisodes
        </button>

        <div class="max-h-[90px] overflow-y-auto bg-black/30 rounded-lg p-3 mt-4 font-mono text-[11px] leading-relaxed text-white/30 space-y-0.5" id="otaku-logs">
          <div>En attente...</div>
        </div>
      </div>
    </div>
  \`;
  document.body.appendChild(container);

  const btn = document.getElementById('otaku-picker-btn');
  const panel = document.getElementById('otaku-picker-panel');
  const closeBtn = document.getElementById('otaku-close-btn');
  const titleInput = document.getElementById('otaku-title');
  const typeSelect = document.getElementById('otaku-type');
  const seasonInput = document.getElementById('otaku-season');
  const seasonGroup = document.getElementById('otaku-season-group');
  const dbBadge = document.getElementById('otaku-db-badge');
  const epListContainer = document.getElementById('otaku-episodes-list');
  const uploadAllBtn = document.getElementById('otaku-upload-all-btn');
  const logsContainer = document.getElementById('otaku-logs');
  const scanBtn = document.getElementById('otaku-scan-btn');
  const scanAllBtn = document.getElementById('otaku-scan-all-btn');
  const progressWrap = document.getElementById('otaku-progress');
  const progressLabel = document.getElementById('otaku-progress-label');
  const progressPct = document.getElementById('otaku-progress-pct');
  const progressFill = document.getElementById('otaku-progress-fill');

  let currentDetectedLinks = [];
  let currentDuplicates = {};
  let scanning = false;

  btn.onclick = () => {
    const isOpen = panel.hasAttribute('data-open');
    if (isOpen) { panel.removeAttribute('data-open'); panel.classList.remove('open'); }
    else { panel.setAttribute('data-open', ''); panel.classList.add('open'); }
  };
  closeBtn.onclick = () => { panel.removeAttribute('data-open'); panel.classList.remove('open'); };

  typeSelect.onchange = () => {
    seasonGroup.style.display = typeSelect.value === 'series' ? 'block' : 'none';
  };

  function addLog(msg, type) {
    const div = document.createElement('div');
    div.className = type === 'error' ? 'text-red-400' : type === 'success' ? 'text-emerald-400' : '';
    div.textContent = '> ' + msg;
    logsContainer.appendChild(div);
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  function setProgress(current, total) {
    if (current === 0 && total === 0) { progressWrap.classList.add('hidden'); return; }
    progressWrap.classList.remove('hidden');
    if (total > 0) {
      progressFill.style.width = Math.round((current / total) * 100) + '%';
      progressPct.textContent = current + '/' + total;
    } else {
      progressFill.style.width = '100%';
      progressPct.textContent = '';
    }
  }

  window.otakuSetProgress = setProgress;
  window.otakuAddLog = function(msg, type) { addLog(msg, type); };

  window.otakuUpdateLink = function(index, status) {
    const b = epListContainer.querySelector('#otaku-ep-btn-' + index);
    if (!b) return;
    if (status === 'loading') { b.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-white bg-white/8 shrink-0'; b.innerHTML = icon('upload') + ' ...'; }
    else if (status === 'success') { b.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-emerald-400 bg-emerald-500/15 shrink-0'; b.innerHTML = icon('check') + ' Fait'; }
    else if (status === 'error') { b.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-red-400 bg-red-500/15 shrink-0'; b.innerHTML = icon('error') + ' Erreur'; }
  };

  function showConfirm(title, msg) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;';
      overlay.innerHTML = '<div class="bg-zinc-800 border border-white/10 rounded-2xl p-8 w-[380px] text-center"><h4 class="text-base font-bold text-white mb-2">' + title + '</h4><p class="text-[13px] text-white/50 mb-6 leading-relaxed">' + msg + '</p><div class="flex gap-2.5"><button class="flex-1 py-2.5 rounded-lg border-none cursor-pointer font-semibold text-[13px] bg-white/8 text-gray-400 hover:bg-white/15">Annuler</button><button class="flex-1 py-2.5 rounded-lg border-none cursor-pointer font-semibold text-[13px] bg-red-600 text-white hover:bg-red-500">Confirmer</button></div></div>';
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.style.opacity = '1');
      overlay.querySelector('button:first-child').onclick = () => { overlay.remove(); resolve(false); };
      overlay.querySelector('button:last-child').onclick = () => { overlay.remove(); resolve(true); };
    });
  }

  function showDupBadge() {
    dbBadge.className = 'flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
    dbBadge.innerHTML = icon('database') + ' <span>DB: Existe déjà</span>';
  }
  function showNewBadge() {
    dbBadge.className = 'flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20';
    dbBadge.innerHTML = icon('database') + ' <span>DB: Nouveau contenu</span>';
  }
  function showLoadingBadge() {
    dbBadge.className = 'flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-white/[0.03] text-white/40 border border-white/5';
    dbBadge.innerHTML = icon('database') + ' <span>Analyse...</span>';
  }

  window.otakuScanResponse = function(resultStr) {
    scanning = false;
    scanBtn.disabled = false;
    scanBtn.innerHTML = icon('scan') + ' Scanner la page';
    setProgress(0, 0);
    const r = JSON.parse(resultStr);
    window.dispatchEvent(new CustomEvent('otaku-detect-result', { detail: r }));
  };

  window.otakuUploadAsync = function(payload) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).substring(7);
      const handler = (e) => {
        if (e.detail && e.detail.__reqId === reqId) {
          window.removeEventListener('otaku-upload-response', handler);
          resolve(e.detail);
        }
      };
      window.addEventListener('otaku-upload-response', handler);
      window.otakuUpload(JSON.stringify({ ...payload, __reqId: reqId }));
    });
  };

  scanBtn.onclick = async () => {
    if (scanning) return;
    scanning = true;
    scanBtn.disabled = true;
    scanBtn.innerHTML = '<span class="inline-block w-3.5 h-3.5 border-2 border-white/15 border-t-white rounded-full animate-spin"></span> Scan en cours...';
    epListContainer.innerHTML = '<div class="py-5 text-center text-white/20 text-sm"><span class="inline-block w-3.5 h-3.5 border-2 border-white/15 border-t-white rounded-full animate-spin"></span> Analyse en cours...</div>';
    addLog('Scan lancé...');
    setProgress(1, -1);
    window.otakuScan(JSON.stringify({
      title: titleInput.value || undefined,
      type: typeSelect.value,
      season: parseInt(seasonInput.value, 10),
    }));
  };

  scanAllBtn.onclick = async () => {
    if (scanning) return;
    scanning = true;
    scanAllBtn.disabled = true;
    scanAllBtn.innerHTML = '<span class="inline-block w-3.5 h-3.5 border-2 border-white/15 border-t-white rounded-full animate-spin"></span> Scan en cours...';
    epListContainer.innerHTML = '<div class="py-5 text-center text-white/20 text-sm"><span class="inline-block w-3.5 h-3.5 border-2 border-white/15 border-t-white rounded-full animate-spin"></span> Analyse de tous les épisodes...</div>';
    addLog('Scan de tous les épisodes démarré...');
    setProgress(1, -1);
    window.otakuScanAll();
  };

  window.otakuScanAllResponse = function(resultStr) {
    scanning = false;
    scanAllBtn.disabled = false;
    scanAllBtn.innerHTML = icon('list') + ' Scanner tous les épisodes';
    setProgress(0, 0);
    const r = JSON.parse(resultStr);
    window.dispatchEvent(new CustomEvent('otaku-detect-result', { detail: r }));
  };

  window.addEventListener('otaku-detect-result', async (e) => {
    const r = e.detail;
    if (r.cleanTitle) titleInput.value = r.cleanTitle;
    if (r.type) {
      typeSelect.value = r.type;
      seasonGroup.style.display = r.type === 'series' ? 'block' : 'none';
    }
    if (r.season) seasonInput.value = r.season;
    currentDuplicates = r.duplicates || {};

    if (r.dbStatus === 'existing') showDupBadge();
    else if (r.dbStatus === 'new') showNewBadge();
    else showLoadingBadge();

    currentDetectedLinks = r.liens || [];
    epListContainer.innerHTML = '';

    if (currentDetectedLinks.length > 0) {
      addLog(currentDetectedLinks.length + ' lien(s) détecté(s)', 'success');

      currentDetectedLinks.forEach((item, index) => {
        const isDup = currentDuplicates[String(index)];
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between px-3.5 py-3 rounded-lg bg-white/[0.02] hover:bg-white/5 text-[13px] gap-3';
        row.innerHTML = \`
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <span class="text-red-500 w-3.5 h-3.5 shrink-0">\${icon('link')}</span>
            <span class="font-semibold text-white/80 truncate">\${item.label}</span>
            <span class="text-[11px] text-white/20 truncate max-w-[120px]" title="\${item.url}">\${item.url}</span>
            \${isDup ? '<span class="text-[10px] text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded font-semibold whitespace-nowrap">' + icon('duplicate') + ' Existe</span>' : ''}
          </div>
          <button class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-white bg-white/8 shrink-0 \${isDup ? '!bg-amber-400/10 !text-amber-400' : ''}" id="otaku-ep-btn-\${index}">
            \${isDup ? icon('check') + ' Fait' : icon('upload') + ' Upload'}
          </button>
        \`;
        epListContainer.appendChild(row);

        const epBtn = row.querySelector('#otaku-ep-btn-' + index);
        if (isDup) epBtn.title = 'Cet épisode existe déjà en base de données';
        epBtn.onclick = async () => {
          if (isDup) { addLog(item.label + ' — déjà en base, ignoré', 'error'); return; }
          const confirmed = await showConfirm('Uploader "' + item.label + '" ?', 'Le lien sera envoyé à Uqload et ajouté en base de données.');
          if (!confirmed) return;

          epBtn.disabled = true;
          epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-white bg-white/8 shrink-0';
          epBtn.innerHTML = icon('upload') + ' ...';
          const res = await window.otakuUploadAsync({
            url: item.url, title: titleInput.value, type: typeSelect.value,
            season: parseInt(seasonInput.value, 10), episode: item.label,
            pageUrl: window.location.href,
          });
          if (res.success) {
            epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-emerald-400 bg-emerald-500/15 shrink-0';
            epBtn.innerHTML = icon('check') + ' Fait';
            addLog(item.label + ' ok (' + res.fileCode + ')', 'success');
          } else {
            epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-red-400 bg-red-500/15 shrink-0';
            epBtn.innerHTML = icon('error') + ' Erreur';
            addLog(item.label + ' échec: ' + (res.message || ''), 'error');
          }
        };
      });

      if (currentDetectedLinks.length > 1) {
        const nonDupCount = currentDetectedLinks.filter((_, i) => !currentDuplicates[String(i)]).length;
        uploadAllBtn.style.display = 'flex';
        uploadAllBtn.innerHTML = icon('upload') + ' Uploader tout' + (nonDupCount < currentDetectedLinks.length ? ' (' + nonDupCount + ' restant' + (nonDupCount > 1 ? 's' : '') + ')' : '');
        uploadAllBtn.onclick = async () => {
          const confirmed = await showConfirm('Uploader ' + nonDupCount + ' épisode(s) ?', 'Tous les liens seront uploadés en parallèle.');
          if (!confirmed) return;

          uploadAllBtn.disabled = true;
          const total = currentDetectedLinks.length;
          let doneCount = 0, errCount = 0;

          const uploadOne = async (i) => {
            if (currentDuplicates[String(i)]) { addLog('[' + (i + 1) + '/' + total + '] ' + currentDetectedLinks[i].label + ' — doublon, ignoré', 'error'); doneCount++; return; }
            const item = currentDetectedLinks[i];
            const epBtn = epListContainer.querySelector('#otaku-ep-btn-' + i);
            if (epBtn) { epBtn.disabled = true; epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-white bg-white/8 shrink-0'; epBtn.innerHTML = icon('upload') + ' ...'; }
            addLog('[' + (i + 1) + '/' + total + '] ' + item.label);
            const res = await window.otakuUploadAsync({ url: item.url, title: titleInput.value, type: typeSelect.value, season: parseInt(seasonInput.value, 10), episode: item.label });
            if (res.success && epBtn) { epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-emerald-400 bg-emerald-500/15 shrink-0'; epBtn.innerHTML = icon('check') + ' Fait'; } else if (epBtn) { epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-red-400 bg-red-500/15 shrink-0'; epBtn.innerHTML = icon('error') + ' Erreur'; errCount++; }
            doneCount++;
            progressFill.style.width = Math.round((doneCount / total) * 100) + '%';
            progressPct.textContent = doneCount + '/' + total;
          };

          progressWrap.classList.remove('hidden');
          progressPct.textContent = '0/' + total;
          progressLabel.textContent = 'Upload en parallèle...';

          const indices = Array.from({ length: total }, (_, i) => i);
          await Promise.all(indices.map(i => uploadOne(i)));

          progressFill.style.width = '100%';
          progressPct.textContent = doneCount + '/' + total;
          progressLabel.textContent = 'Terminé !';
          setTimeout(() => { progressWrap.classList.add('hidden'); }, 2000);

          uploadAllBtn.disabled = false;
          uploadAllBtn.innerHTML = icon('upload') + ' Uploader tout';
          addLog('Terminé — ' + (doneCount - errCount) + '/' + total + ' réussi(s)', errCount > 0 ? 'error' : 'success');
        };
      } else {
        uploadAllBtn.style.display = 'none';
      }

      // Auto-upload si le toggle est activé
      const autoUpload = document.getElementById('otaku-auto-upload');
      if (autoUpload && autoUpload.checked) {
        const nonDups = currentDetectedLinks.filter((_, i) => !currentDuplicates[String(i)]);
        if (nonDups.length > 0) {
          const confirmed = await showConfirm('Uploader ' + nonDups.length + ' épisode(s) ?', 'Tous les liens seront uploadés en parallèle automatiquement.');
          if (!confirmed) return;
          const total = currentDetectedLinks.length;
          let doneCount = 0, errCount = 0;

          const uploadOne = async (i) => {
            if (currentDuplicates[String(i)]) { doneCount++; return; }
            const item = currentDetectedLinks[i];
            const epBtn = epListContainer.querySelector('#otaku-ep-btn-' + i);
            if (epBtn) { epBtn.disabled = true; epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-white bg-white/8 shrink-0'; epBtn.innerHTML = icon('upload') + ' ...'; }
            addLog('[Auto] ' + item.label);
            const res = await window.otakuUploadAsync({ url: item.url, title: titleInput.value, type: typeSelect.value, season: parseInt(seasonInput.value, 10), episode: item.label, pageUrl: window.location.href });
            if (res.success && epBtn) { epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-emerald-400 bg-emerald-500/15 shrink-0'; epBtn.innerHTML = icon('check') + ' Fait'; addLog('[Auto] ' + item.label + ' OK', 'success'); } else if (epBtn) { epBtn.className = 'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md border-none cursor-pointer font-semibold text-xs text-red-400 bg-red-500/15 shrink-0'; epBtn.innerHTML = icon('error') + ' Erreur'; addLog('[Auto] ' + item.label + ' échec', 'error'); errCount++; }
            doneCount++;
            progressFill.style.width = Math.round((doneCount / total) * 100) + '%';
            progressPct.textContent = doneCount + '/' + total;
          };

          progressWrap.classList.remove('hidden');
          progressPct.textContent = '0/' + total;
          progressLabel.textContent = 'Upload auto en parallèle...';

          const indices = Array.from({ length: total }, (_, i) => i);
          await Promise.all(indices.map(i => uploadOne(i)));

          progressFill.style.width = '100%';
          progressPct.textContent = doneCount + '/' + total;
          progressLabel.textContent = 'Auto-upload terminé !';
          setTimeout(() => { progressWrap.classList.add('hidden'); }, 2000);
          addLog('Auto-upload terminé — ' + (doneCount - errCount) + '/' + total + ' réussi(s)', errCount > 0 ? 'error' : 'success');
        }
      }
    } else {
      epListContainer.innerHTML = '<div class="py-5 text-center text-white/25 text-sm flex items-center justify-center gap-1.5">' + icon('error') + ' Aucun lien trouvé sur cette page</div>';
    }
  });
})();
`;

async function injectUI(page: Page) {
  try {
    await page.evaluate(injectUIScriptCode);
    const result = await detectVideo(page, {});
    await page.evaluate((r) => {
      window.dispatchEvent(new CustomEvent('otaku-detect-result', { detail: r }));
    }, result);
    const pageTitle = result.cleanTitle || result.titre || 'Page inconnue';
    const linkCount = result.liens?.length || 0;
    await page.evaluate(([title, count]) => {
      (window as any).otakuAddLog?.('Page chargée: ' + title + (count > 0 ? ' — ' + count + ' lien(s)' : ''));
    }, [pageTitle, linkCount] as [string, number]);
  } catch (e: any) {
    console.error('[OTAKU] Erreur injection:', e.message);
  }
}

async function main() {
  const apiKey = process.env.UQLOAD_API_KEY;
  if (!apiKey) {
    console.error('UQLOAD_API_KEY non configurée');
    process.exit(1);
  }

  console.log('[OTAKU] Connexion à MongoDB...');
  await connectDB();

  const uqload = new UqloadClient(apiKey);
  console.log('[OTAKU] Lancement du navigateur...');

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: any[]) => {
    origLog(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (msg.includes('[OTAKU]') || msg.includes('[MongoDB]')) {
      logToPanel(msg).catch(() => {});
    }
  };
  console.error = (...args: any[]) => {
    origErr(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    logToPanel(msg, 'error').catch(() => {});
  };

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();

  await page.exposeFunction('otakuDetect', async (payloadStr: string) => {
    try {
      const data = JSON.parse(payloadStr) as DetectPayload;
      const result = await detectVideo(page, data);
      await page.evaluate((r) => {
        window.dispatchEvent(new CustomEvent('otaku-detect-result', { detail: r }));
      }, result);
    } catch (e: any) {
      console.error('[OTAKU] detectVideo error:', e.message);
    }
  });

  await page.exposeFunction('otakuUpload', async (payloadStr: string) => {
    try {
      const data = JSON.parse(payloadStr) as DetectPayload;
      const epLabel = data.episode || data.title || '';
      console.log(`[OTAKU] ▸ Upload: ${epLabel} — en cours...`);
      const result = await uploadVideo(data, uqload);
      if (result.success) {
        console.log(`[OTAKU] ✓ Upload: ${epLabel} — OK (${result.fileCode})`);
      } else {
        console.log(`[OTAKU] ✗ Upload: ${epLabel} — ${result.message}`);
      }
      await page.evaluate(([r, reqId]) => {
        window.dispatchEvent(new CustomEvent('otaku-upload-response', { detail: { ...r, __reqId: reqId } }));
      }, [result, data.__reqId] as [any, string]);
    } catch (e: any) {
      console.error(`[OTAKU] ✗ Upload error: ${e.message}`);
    }
  });

  await page.exposeFunction('otakuScanAll', async () => {
    try {
      console.log(`[OTAKU] ▸ Scan tous les épisodes démarré...`);
      const result = await scanAllEpisodes(page);
      const count = result.liens?.length || 0;
      console.log(`[OTAKU] ✓ Scan tous les épisodes terminé — ${count} lien(s) trouvé(s)`);
      await page.evaluate((r) => {
        (window as any).otakuScanAllResponse(JSON.stringify(r));
      }, result);
    } catch (e: any) {
      console.error(`[OTAKU] ✗ Scan tous les épisodes error: ${e.message}`);
    }
  });

  await page.exposeFunction('otakuScan', async (payloadStr: string) => {
    try {
      const data = JSON.parse(payloadStr);
      console.log(`[OTAKU] ▸ Scan démarré — type: ${data.type || 'auto'}, saison: ${data.season || 1}`);
      const result = await scanPage(page, data);
      const count = result.liens?.length || 0;
      const dups = result.duplicates ? Object.values(result.duplicates).filter(Boolean).length : 0;
      console.log(`[OTAKU] ✓ Scan terminé — ${count} lien(s) trouvé(s), ${dups} doublon(s)`);
      await page.evaluate((r) => {
        (window as any).otakuScanResponse(JSON.stringify(r));
      }, result);
    } catch (e: any) {
      console.error(`[OTAKU] ✗ Scan error: ${e.message}`);
    }
  });

  async function logToPanel(msg: string, type?: string) {
    try {
      await page.evaluate(([m, t]) => (window as any).otakuAddLog(m, t), [msg, type || ''] as [string, string]);
    } catch {}
  }

  page.on('domcontentloaded', () => injectUI(page).catch(() => {}));

  console.log('[OTAKU] Navigation vers https://www.open-otaku.me...');
  await page.goto('https://www.open-otaku.me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await injectUI(page);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', async () => {
      await browser.close();
      process.exit(0);
    });
    browser.on('disconnected', () => resolve());
  });
}

main().catch(console.error);
