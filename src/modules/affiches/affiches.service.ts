import axios from 'axios';
import tmdbClient from '../../config/tmdb';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import { generateSpeech, generatePosterImage } from '../ai/ai';

export type PosterSource = 'tmdb' | 'web' | 'ai' | 'none';

export interface AffichesProgress {
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

export const affichesProgress: AffichesProgress = {
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

const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500';

async function searchPosterWeb(titre: string, year?: number): Promise<string | null> {
  const query = encodeURIComponent(`${titre} ${year || ''} affiche officielle poster`.trim());
  const engines: { url: string; parse: (html: string) => string[] }[] = [
    {
      url: `https://www.bing.com/images/search?q=${query}`,
      parse: (html) => {
        const murls = [...html.matchAll(/"murl":"(https?:\\?\/\\?\/[^"]+)"/g)]
          .map(m => m[1].replace(/\\\//g, '/'))
          .filter(u => /\.(jpe?g|png|webp)(\?|$)/i.test(u));
        return murls;
      },
    },
  ];

  for (const engine of engines) {
    try {
      const { data } = await axios.get(engine.url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      });
      const urls = engine.parse(data);
      for (const url of urls.slice(0, 5)) {
        if (await isImageUrlAlive(url)) return url;
      }
    } catch {
      // moteur suivant
    }
  }
  return null;
}

async function isImageUrlAlive(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

async function fetchTmdbDetails(type: 'movie' | 'series', tmdbId: number): Promise<any | null> {
  const endpoint = type === 'movie' ? 'movie' : 'tv';
  try {
    const { data } = await tmdbClient.get(`/${endpoint}/${tmdbId}`, {
      params: { language: 'fr-FR', append_to_response: 'images' },
    });
    return data;
  } catch (err: any) {
    console.error(`[Affiches] TMDB details échec (${endpoint}/${tmdbId}):`, err.response?.data?.status_message || err.message);
    return null;
  }
}

async function resolveTmdbId(type: 'movie' | 'series', titre: string, year?: number): Promise<number | null> {
  if (/^\d+$/.test(titre)) return parseInt(titre, 10);
  const endpoint = type === 'movie' ? 'movie' : 'tv';
  try {
    const { data } = await tmdbClient.get(`/search/${endpoint}`, {
      params: { query: titre, language: 'fr-FR', year: year || undefined },
    });
    return data?.results?.[0]?.id || null;
  } catch {
    return null;
  }
}

export async function getPosterAndSpeech(
  type: 'movie' | 'series',
  titre: string,
  year?: number,
  tmdbId?: number,
): Promise<{ posterUrl: string | null; posterSource: PosterSource; speech: string | null }> {
  let posterUrl: string | null = null;
  let posterSource: PosterSource = 'none';
  let speech: string | null = null;

  const id = tmdbId || (await resolveTmdbId(type, titre, year));
  let overview: string | undefined;
  let tagline: string | undefined;

  if (id) {
    const details = await fetchTmdbDetails(type, id);
    if (details) {
      overview = details.overview;
      tagline = details.tagline;

      // 1) Poster TMDB
      if (details.poster_path) {
        posterUrl = `${TMDB_IMAGE}${details.poster_path}`;
        posterSource = 'tmdb';
      } else if (details.images?.posters?.length) {
        posterUrl = `${TMDB_IMAGE}${details.images.posters[0].file_path}`;
        posterSource = 'tmdb';
      }
    }
  }

  // 2) Recherche web de la vraie affiche
  if (!posterUrl) {
    const webUrl = await searchPosterWeb(titre, year);
    if (webUrl) {
      posterUrl = webUrl;
      posterSource = 'web';
    }
  }

  // 3) Génération IA en dernier recours
  if (!posterUrl) {
    const aiUrl = await generatePosterImage({ titre, synopsis: overview, type });
    if (aiUrl) {
      posterUrl = aiUrl;
      posterSource = 'ai';
    }
  }

  // Speech marketing IA (fallback synopsis TMDB)
  speech = await generateSpeech({ titre, synopsis: overview, tagline, type, year });
  if (!speech) speech = overview || null;

  return { posterUrl, posterSource, speech };
}

export async function generateOne(type: 'movie' | 'series', id: string): Promise<void> {
  const doc = type === 'movie'
    ? await Movie.findById(id).select('titre year tmdbId posterUrl posterSource speech').lean()
    : await Serie.findById(id).select('titre year tmdbId posterUrl posterSource speech').lean();

  if (!doc) throw new Error(`Document introuvable (${type}/${id})`);

  const result = await getPosterAndSpeech(type, doc.titre, doc.year, doc.tmdbId);

  const update: any = {
    speech: result.speech,
    posterUrl: result.posterUrl,
    posterSource: result.posterSource,
  };

  if (type === 'movie') {
    await Movie.updateOne({ _id: id }, { $set: update });
  } else {
    await Serie.updateOne({ _id: id }, { $set: update });
  }
}

async function getTrendingTmdbIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const [movies, tv] = await Promise.all([
      tmdbClient.get('/trending/movie/week', { params: { language: 'fr-FR' } }),
      tmdbClient.get('/trending/tv/week', { params: { language: 'fr-FR' } }),
    ]);
    for (const m of movies.data?.results || []) ids.add(`movie:${m.id}`);
    for (const t of tv.data?.results || []) ids.add(`series:${t.id}`);
  } catch (err: any) {
    console.error('[Affiches] Erreur récupération tendances TMDB:', err.message);
  }
  return ids;
}

export async function generateAll(type: 'movie' | 'series' | 'all' = 'all'): Promise<void> {
  if (affichesProgress.running) throw new Error('Une génération est déjà en cours');

  affichesProgress.running = true;
  affichesProgress.type = type;
  affichesProgress.processed = 0;
  affichesProgress.ok = 0;
  affichesProgress.ko = 0;
  affichesProgress.startedAt = new Date();
  affichesProgress.errors = [];
  affichesProgress.lastMessage = 'Récupération des films tendance du web (TMDB)...';

  try {
    const trending = await getTrendingTmdbIds();

    const movies = type === 'movie' || type === 'all'
      ? await Movie.find({}).select('titre year tmdbId').lean()
      : [];
    const series = type === 'series' || type === 'all'
      ? await Serie.find({}).select('titre year tmdbId').lean()
      : [];

    const sortTrendingFirst = (a: any, b: any, prefix: string) => {
      const ta = trending.has(`${prefix}:${a.tmdbId}`) ? 0 : 1;
      const tb = trending.has(`${prefix}:${b.tmdbId}`) ? 0 : 1;
      return ta - tb;
    };

    movies.sort((a, b) => sortTrendingFirst(a, b, 'movie'));
    series.sort((a, b) => sortTrendingFirst(a, b, 'series'));

    const items: { type: 'movie' | 'series'; doc: any }[] = [
      ...movies.map(doc => ({ type: 'movie' as const, doc })),
      ...series.map(doc => ({ type: 'series' as const, doc })),
    ];

    affichesProgress.total = items.length;
    affichesProgress.lastMessage = `Traitement de ${items.length} titres (tendances en priorité)...`;

    const CONCURRENCY = 2;
    let index = 0;
    const runner = async () => {
      while (index < items.length) {
        const current = index++;
        const { type: t, doc } = items[current];
        try {
          const result = await getPosterAndSpeech(t, doc.titre, doc.year, doc.tmdbId);
          const update: any = {
            speech: result.speech,
            posterUrl: result.posterUrl,
            posterSource: result.posterSource,
          };
          if (t === 'movie') {
            await Movie.updateOne({ _id: doc._id }, { $set: update });
          } else {
            await Serie.updateOne({ _id: doc._id }, { $set: update });
          }
          affichesProgress.ok++;
          affichesProgress.lastMessage = `${affichesProgress.ok}/${affichesProgress.total} — ${doc.titre} (${result.posterSource})`;
        } catch (err: any) {
          affichesProgress.ko++;
          affichesProgress.errors.push(`${doc.titre}: ${err.message}`);
        } finally {
          affichesProgress.processed++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
    affichesProgress.lastMessage = `Terminé: ${affichesProgress.ok} affiches générées, ${affichesProgress.ko} en échec`;
  } finally {
    affichesProgress.running = false;
  }
}

export async function listAffiches(opts: {
  type?: 'movie' | 'series' | 'all';
  disponible?: boolean;
  source?: PosterSource;
  q?: string;
  page?: number;
  limit?: number;
}) {
  const { type = 'all', disponible, source, q = '', page = 1, limit = 50 } = opts;
  const regex = q ? new RegExp(q, 'i') : null;
  const filter = {
    ...(regex ? { titre: regex } : {}),
    ...(disponible !== undefined ? { disponible } : {}),
    ...(source ? { posterSource: source } : {}),
  };

  const [movies, series] = await Promise.all([
    type === 'series' ? [] : Movie.find(filter).select('titre year tmdbId posterUrl posterSource speech disponible disponibleCheckedAt').sort({ createdAt: -1 }).limit(limit).skip((page - 1) * limit).lean(),
    type === 'movie' ? [] : Serie.find(filter).select('titre year tmdbId posterUrl posterSource speech disponible disponibleCheckedAt').sort({ createdAt: -1 }).limit(limit).skip((page - 1) * limit).lean(),
  ]);

  const movieCount = type === 'series' ? 0 : await Movie.countDocuments(filter);
  const serieCount = type === 'movie' ? 0 : await Serie.countDocuments(filter);

  const items = [
    ...movies.map((m: any) => ({ ...m, mediaType: 'movie' as const, link: m.tmdbId ? `/media/${m.tmdbId}?type=movie` : null })),
    ...series.map((s: any) => ({ ...s, mediaType: 'series' as const, link: s.tmdbId ? `/media/${s.tmdbId}?type=tv` : null })),
  ];

  return { items, total: movieCount + serieCount, page, limit };
}
