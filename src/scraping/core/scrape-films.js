const axios = require('axios');
const mongoose = require('mongoose');
const Movie = require('../../models/Movie').default;
const ScraperState = require('../../models/ScraperState').default;
const { connectDB } = require('../../config/db');
const { UqloadClient } = require('../../modules/uqload/uqload.client');
const { autoLink } = require('../maintenance/auto-link');

const BASE_URL = 'https://www.open-otaku.me';
const MAX_EMPTY_RETRIES = 5;
const CONCURRENCY = 3;

function toDownloadUrl(url) {
  if (!url) return '';
  if (url.includes('vidzy.')) return url.replace('/embed-', '/d/').replace('.html', '_n.html');
  if (url.includes('luluvid.')) return url.replace('/embed-', '/d/').replace('.html', '');
  return url;
}

async function getDirectLink(embedUrl) {
  try {
    const dlUrl = toDownloadUrl(embedUrl);
    if (!dlUrl) return null;
    const { data } = await axios.get(`${BASE_URL}/api/dl`, {
      params: { url: dlUrl },
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return data && data.success && data.downloadUrl ? data.downloadUrl : null;
  } catch {
    return null;
  }
}

async function uploadToUqload(client, titre, lien, movieId) {
  if (!client) return;
  try {
    console.log(`  -> Upload Uqload: ${titre}`);
    const { fileCode, directLink } = await client.uploadByUrlAndGetLink(lien, titre);
    const bestQuality = directLink?.versions?.find(v => v.name === 'n') || directLink?.versions?.[0];
    await Movie.updateOne(
      { _id: movieId },
      {
        $set: {
          uqloadCode: fileCode,
          uqloadLink: bestQuality ? bestQuality.url : null,
          uqloadQualities: directLink?.versions || [],
          uqloadHls: directLink?.hls_direct || null,
        }
      }
    );
    console.log(`  -> ✅ Uqload: ${titre} → ${fileCode}`);
  } catch (e) {
    console.log(`  -> ⏭ Uqload ignoré pour ${titre}: ${e.message}`);
  }
}

const DOOD_API_KEY = process.env.DOODSTREAM_API_KEY;
const DOOD_BASE = 'https://doodapi.co/api';

async function uploadToDoodStream(titre, lien, movieId) {
  if (!DOOD_API_KEY || !lien || lien === '#') return;
  try {
    console.log(`  -> Upload DoodStream: ${titre}`);
    const { data } = await axios.get(`${DOOD_BASE}/upload/url`, {
      params: { key: DOOD_API_KEY, url: lien, new_title: titre },
      timeout: 30000,
    });
    if (data.status === 200 && data.result?.filecode) {
      const doodUrl = `https://doodstream.com/e/${data.result.filecode}`;
      const movie = await Movie.findById(movieId);
      const update = { lien: doodUrl, fileCode: data.result.filecode, uploadedAt: new Date() };
      if (movie && !movie.lienOriginal) update.lienOriginal = movie.lien;
      await Movie.updateOne({ _id: movieId }, { $set: update });
      console.log(`  -> ✅ DoodStream: ${titre} → ${doodUrl}`);
    } else {
      console.log(`  -> ⏭ DoodStream ignoré pour ${titre}: ${data.msg || 'réponse inattendue'}`);
    }
  } catch (e) {
    console.log(`  -> ⏭ DoodStream ignoré pour ${titre}: ${e.message}`);
  }
}

async function getLastPage() {
  try {
    const state = await ScraperState.findOne({ name: 'films' });
    return state ? state.lastPage : 1;
  } catch {
    return 1;
  }
}

async function saveLastPage(page) {
  await ScraperState.findOneAndUpdate(
    { name: 'films' },
    { $set: { lastPage: page, updatedAt: new Date() } },
    { upsert: true }
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchFilmsPage(page) {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/fs-home`, {
      params: { category: 'films', page },
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    console.error(`[ScrapeFilms] Erreur fetch page ${page}:`, err.message);
    return [];
  }
}

async function fetchWatchDetails(id) {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/fs-watch`, {
      params: { id },
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return data || {};
  } catch (err) {
    console.error(`[ScrapeFilms] Erreur fetch fs-watch (${id}):`, err.message);
    return null;
  }
}

async function processFilm(item, uqloadClient) {
  const titre = item.title.trim();
  const ficheUrl = `${BASE_URL}/?watch_fs=${item.id}`;

  try {
    console.log(`[ScrapeFilms] Traitement : ${titre} (ID: ${item.id})`);
    const watch = await fetchWatchDetails(item.id);
    if (!watch) return;

    const players = watch.players || {};
    const embedUrl =
      players.vidzy?.default ||
      players.vidzy?.vff ||
      players.vidzy?.vf ||
      players.vidzy?.vostfr ||
      players.premium?.default ||
      (Object.values(players)[0] && Object.values(players)[0].default) ||
      '';

    let directLink = null;
    if (embedUrl) {
      directLink = await getDirectLink(embedUrl);
    }

    if (!directLink) {
      console.log(`[ScrapeFilms] ⚠️ Lien direct introuvable pour : ${titre}`);
      return;
    }

    let year = undefined;
    if (watch.meta?.year) {
      const parsed = parseInt(String(watch.meta.year), 10);
      if (parsed > 1900 && parsed < 2100) year = parsed;
    }
    const poster = watch.meta?.poster || item.poster || undefined;

    const updateData = {
      titre,
      pageUrl: ficheUrl,
      lien: directLink,
      ...(year ? { year } : {}),
      ...(poster ? { posterUrl: poster, posterSource: 'tmdb' } : {})
    };

    const saved = await Movie.findOneAndUpdate(
      { titre },
      { $set: updateData },
      { upsert: true, returnDocument: 'after' }
    );

    console.log(`[ScrapeFilms] ✅ Sauvegardé : ${titre}`);
    if (saved) {
      if (uqloadClient) await uploadToUqload(uqloadClient, titre, directLink, saved._id);
      await uploadToDoodStream(titre, directLink, saved._id);
      autoLink('movie', saved._id.toString());
    }
  } catch (err) {
    console.error(`[ScrapeFilms] ❌ Erreur sur ${titre}:`, err.message);
  }
}

async function scrapeFilms() {
  console.log('[START] scrapeFilms() called — connecting to MongoDB...');
  await connectDB();
  console.log('[OK] MongoDB connected, scraper direct API initialisé.');

  const uqloadKey = process.env.UQLOAD_API_KEY;
  const uqloadClient = uqloadKey ? new UqloadClient(uqloadKey) : null;

  while (true) {
    let currentPage = await getLastPage();
    let hasMorePages = true;
    console.log(`[ScrapeFilms] Démarrage boucle depuis la page ${currentPage}`);

    while (hasMorePages) {
      console.log(`\n--- Page ${currentPage} ---`);
      let items = await fetchFilmsPage(currentPage);

      if (items.length === 0) {
        let retries = 0;
        let pageLoaded = false;
        while (retries < MAX_EMPTY_RETRIES) {
          retries++;
          console.log(`Page ${currentPage} vide (tentative ${retries}/${MAX_EMPTY_RETRIES}) — attend 5s...`);
          await sleep(5000);
          items = await fetchFilmsPage(currentPage);
          if (items.length > 0) {
            pageLoaded = true;
            break;
          }
        }
        if (!pageLoaded) {
          console.log(`Page ${currentPage} toujours vide après ${MAX_EMPTY_RETRIES} tentatives — fin du cycle, retour page 1`);
          hasMorePages = false;
          await saveLastPage(1);
          break;
        }
      }

      console.log(`Films trouvés sur la page : ${items.length}`);
      const validItems = items.filter(it => it.title && !it.title.includes('Saison') && !it.title.includes('Épisode'));
      const titles = validItems.map(it => it.title.trim());

      const existingMovies = await Movie.find(
        { titre: { $in: titles } },
        { titre: 1, pageUrl: 1, lien: 1 }
      ).lean();
      const existingSet = new Set(
        existingMovies.filter(m => m.pageUrl && m.lien).map(m => m.titre)
      );

      const toProcess = validItems.filter(it => {
        if (existingSet.has(it.title.trim())) {
          console.log(`Déjà traité : ${it.title.trim()}`);
          return false;
        }
        return true;
      });

      console.log(`Films restants à traiter : ${toProcess.length}/${validItems.length}`);

      for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
        const chunk = toProcess.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(it => processFilm(it, uqloadClient)));
      }

      currentPage++;
      await saveLastPage(currentPage);
    }

    console.log("[ScrapeFilms] Cycle terminé, redémarrage dans 10s...");
    await sleep(10000);
  }
}

module.exports = { scrapeFilms };

if (require.main === module) {
  scrapeFilms().catch(console.error);
}
