import axios from 'axios';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import { getFileInfo } from '../doodstream/doodstream.service';

export interface ScanProgress {
  running: boolean;
  type: 'movie' | 'series' | 'all' | null;
  total: number;
  processed: number;
  ok: number;
  ko: number;
  startedAt: Date | null;
  lastMessage: string;
  errors: string[];
}

export const scanProgress: ScanProgress = {
  running: false,
  type: null,
  total: 0,
  processed: 0,
  ok: 0,
  ko: 0,
  startedAt: null,
  lastMessage: '',
  errors: [],
};

const CONCURRENCY = 5;
const HEAD_TIMEOUT = 5000;
const GET_TIMEOUT = 8000;

async function isUrlAlive(url: string): Promise<boolean> {
  try {
    const head = await axios.head(url, {
      timeout: HEAD_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (head.status >= 200 && head.status < 400) return true;
  } catch {
    // certains serveurs bloquent HEAD → fallback GET stream coupé au premier octet
  }
  try {
    const res = await axios.get(url, {
      timeout: GET_TIMEOUT,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Range: 'bytes=0-1' },
    });
    if (res.status >= 200 && res.status < 400) {
      res.data.once?.('data', () => { try { res.data.destroy(); } catch {} });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function streamCandidates(doc: any): string[] {
  const urls: string[] = [];
  for (const key of ['lien', 'uqloadLink', 'uqloadHls', 'streamtapeLink']) {
    const u = doc[key];
    if (typeof u === 'string' && u.startsWith('http')) urls.push(u);
  }
  return urls;
}

function downloadCandidates(doc: any): string[] {
  const urls: string[] = [];
  const uq = doc.uqloadLink || doc.uqloadHls;
  if (typeof uq === 'string' && uq.startsWith('http')) urls.push(uq);
  const st = doc.streamtapeLink;
  if (typeof st === 'string' && st.startsWith('http')) urls.push(st);
  const lien = doc.lien;
  if (typeof lien === 'string' && /\.mp4|doodstream\.com\/d\/|dood\.(to|sh|so|cx|la|wf|pm)\/d\//i.test(lien)) {
    urls.push(lien);
  }
  return urls;
}

async function checkStreaming(doc: any): Promise<boolean> {
  const candidates = streamCandidates(doc);
  if (candidates.length === 0) return false;
  const results = await Promise.all(candidates.map(isUrlAlive));
  return results.some(Boolean);
}

async function checkDownload(doc: any): Promise<boolean> {
  const fileCode = doc.fileCode || doc.uqloadCode;
  if (fileCode && process.env.DOODSTREAM_API_KEY) {
    try {
      const info = await getFileInfo(fileCode);
      if (info && info.status === 200) return true;
    } catch {
      // fallback
    }
  }
  const candidates = downloadCandidates(doc);
  if (candidates.length === 0) return false;
  const results = await Promise.all(candidates.map(isUrlAlive));
  return results.some(Boolean);
}

async function checkMovie(movie: any): Promise<{ streaming: boolean; download: boolean }> {
  const [streaming, download] = await Promise.all([checkStreaming(movie), checkDownload(movie)]);
  return { streaming, download };
}

function sampleEpisodes(episodes: any[], max = 5): any[] {
  if (episodes.length <= max) return episodes;
  const out: any[] = [];
  const step = Math.floor(episodes.length / max);
  for (let i = 0; i < max && i * step < episodes.length; i++) {
    out.push(episodes[i * step]);
  }
  return out;
}

async function checkSerie(serie: any): Promise<{ streaming: boolean; download: boolean }> {
  const eps = sampleEpisodes(serie.episodes || []);
  if (eps.length === 0) return { streaming: false, download: false };

  const results = await Promise.all(
    eps.map(async (ep: any) => {
      const [streaming, download] = await Promise.all([checkStreaming(ep), checkDownload(ep)]);
      return { streaming, download };
    }),
  );

  const streamingCount = results.filter(r => r.streaming).length;
  const downloadCount = results.filter(r => r.download).length;
  const threshold = Math.max(1, Math.ceil(eps.length * 0.6));
  return {
    streaming: streamingCount >= threshold,
    download: downloadCount >= threshold,
  };
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      try {
        await worker(items[current]);
      } catch (err: any) {
        scanProgress.errors.push(err.message || String(err));
      }
    }
  });
  await Promise.all(runners);
}

export async function scanAvailability(type: 'movie' | 'series' | 'all' = 'all'): Promise<void> {
  if (scanProgress.running) throw new Error('Un scan est déjà en cours');

  scanProgress.running = true;
  scanProgress.type = type;
  scanProgress.processed = 0;
  scanProgress.ok = 0;
  scanProgress.ko = 0;
  scanProgress.startedAt = new Date();
  scanProgress.errors = [];
  scanProgress.lastMessage = 'Initialisation...';

  try {
    const totalMovies = type === 'movie' || type === 'all' ? await Movie.countDocuments() : 0;
    const totalSeries = type === 'series' || type === 'all' ? await Serie.countDocuments() : 0;
    scanProgress.total = totalMovies + totalSeries;

    if (totalMovies > 0) {
      scanProgress.lastMessage = `Scan des films (${totalMovies})...`;
      const cursor = Movie.find({}).select('titre tmdbId lien uqloadLink uqloadHls streamtapeLink fileCode uqloadCode').lean().cursor();
      const batch: any[] = [];
      for await (const movie of cursor) {
        batch.push(movie);
        if (batch.length >= 25) {
          await runPool(batch, async (m) => {
            const res = await checkMovie(m);
            await Movie.updateOne({ _id: m._id }, {
              disponible: res.streaming && res.download,
              disponibleCheckedAt: new Date(),
            });
            if (res.streaming && res.download) scanProgress.ok++; else scanProgress.ko++;
            scanProgress.processed++;
            scanProgress.lastMessage = `Films: ${scanProgress.processed}/${scanProgress.total}`;
          });
          batch.length = 0;
        }
      }
      await runPool(batch, async (m) => {
        const res = await checkMovie(m);
        await Movie.updateOne({ _id: m._id }, {
          disponible: res.streaming && res.download,
          disponibleCheckedAt: new Date(),
        });
        if (res.streaming && res.download) scanProgress.ok++; else scanProgress.ko++;
        scanProgress.processed++;
        scanProgress.lastMessage = `Films: ${scanProgress.processed}/${scanProgress.total}`;
      });
    }

    if (totalSeries > 0) {
      scanProgress.lastMessage = `Scan des séries (${totalSeries})...`;
      const cursor = Serie.find({}).select('titre tmdbId episodes').lean().cursor();
      const batch: any[] = [];
      for await (const serie of cursor) {
        batch.push(serie);
        if (batch.length >= 25) {
          await runPool(batch, async (s) => {
            const res = await checkSerie(s);
            await Serie.updateOne({ _id: s._id }, {
              disponible: res.streaming && res.download,
              disponibleCheckedAt: new Date(),
            });
            if (res.streaming && res.download) scanProgress.ok++; else scanProgress.ko++;
            scanProgress.processed++;
            scanProgress.lastMessage = `Séries: ${scanProgress.processed}/${scanProgress.total}`;
          });
          batch.length = 0;
        }
      }
      await runPool(batch, async (s) => {
        const res = await checkSerie(s);
        await Serie.updateOne({ _id: s._id }, {
          disponible: res.streaming && res.download,
          disponibleCheckedAt: new Date(),
        });
        if (res.streaming && res.download) scanProgress.ok++; else scanProgress.ko++;
        scanProgress.processed++;
        scanProgress.lastMessage = `Séries: ${scanProgress.processed}/${scanProgress.total}`;
      });
    }

    scanProgress.lastMessage = `Terminé: ${scanProgress.ok} disponibles, ${scanProgress.ko} indisponibles`;
  } finally {
    scanProgress.running = false;
  }
}

export async function getBatchAvailability(type: 'movie' | 'tv', ids: number[]): Promise<Record<string, { disponible: boolean; streaming: boolean; download: boolean }>> {
  const result: Record<string, any> = {};
  if (ids.length === 0) return result;

  if (type === 'movie') {
    const movies = await Movie.find({ tmdbId: { $in: ids } }).select('tmdbId lien uqloadLink streamtapeLink fileCode disponible').lean();
    for (const m of movies) {
      result[String(m.tmdbId)] = {
        disponible: !!m.disponible,
        streaming: await checkStreaming(m),
        download: await checkDownload(m),
      };
    }
  } else {
    const series = await Serie.find({ tmdbId: { $in: ids } }).select('tmdbId episodes disponible').lean();
    for (const s of series) {
      result[String(s.tmdbId)] = {
        disponible: !!s.disponible,
        streaming: await checkStreaming(s.episodes?.[0] || s),
        download: await checkDownload(s.episodes?.[0] || s),
      };
    }
  }
  return result;
}
