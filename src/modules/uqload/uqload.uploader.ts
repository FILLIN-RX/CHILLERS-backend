import { UqloadClient } from './uqload.client';
import { BatchResult } from './uqload.types';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

export interface SaveAndUploadParams {
  type: 'movie' | 'series';
  titre: string;
  pageUrl: string;
  url: string;
  year?: number;
  season?: number;
  episodeLabel?: string;
  episodeNumber?: number;
}

export interface SaveAndUploadResult {
  success: boolean;
  fileCode?: string;
  directLink?: string;
  message?: string;
  dbAction: 'created' | 'updated' | 'duplicate';
}

export async function saveAndUpload(client: UqloadClient, params: SaveAndUploadParams): Promise<SaveAndUploadResult> {
  const { type, titre, pageUrl, url, year, season, episodeLabel, episodeNumber } = params;
  const escaped = titre.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

  if (type === 'series') {
    console.log(`[Uqload] ○ Vérification doublon: ${titre} - ${episodeLabel || ''}`);
    const existing = await Serie.findOne({
      titre: new RegExp(`^${escaped}$`, 'i'),
      episodes: {
        $elemMatch: {
          season: season || 1,
          episodeNumber: episodeNumber || 1,
          uqloadCode: { $exists: true, $ne: null },
        },
      },
    });
    if (existing) {
      console.log(`[Uqload] ✗ Doublon: ${titre} - ${episodeLabel || ''} (déjà uploadé)`);
      return { success: false, message: 'Doublon: épisode déjà uploadé', dbAction: 'duplicate' };
    }

    const formattedEp = episodeLabel || `S${String(season || 1).padStart(2, '0')}E${String(episodeNumber || 1).padStart(2, '0')}`;
    console.log(`[Uqload] ○ Sauvegarde DB: ${titre} — ${formattedEp}`);

    // Update existing episode or push new one
    const existingEp = await Serie.findOne({
      titre,
      episodes: { $elemMatch: { season: season || 1, episodeNumber: episodeNumber || 1 } },
    });
    let serie;
    if (existingEp) {
      const epIdx = existingEp.episodes.findIndex(e => e.season === (season || 1) && e.episodeNumber === (episodeNumber || 1));
      const setKey = `episodes.${epIdx}`;
      serie = await Serie.findOneAndUpdate(
        { _id: existingEp._id },
        {
          $set: {
            [`${setKey}.episode`]: formattedEp,
            [`${setKey}.lien`]: url,
            pageUrl,
            ...(year ? { year } : {}),
          },
        },
        { returnDocument: 'after' },
      );
    } else {
      serie = await Serie.findOneAndUpdate(
        { titre },
        {
          $push: { episodes: { episode: formattedEp, season: season || 1, episodeNumber: episodeNumber || 1, lien: url } },
          $set: { pageUrl, ...(year ? { year } : {}) },
        },
        { upsert: true, returnDocument: 'after' },
      );
    }
    console.log(`[Uqload] ✓ Sauvegarde DB OK: ${titre} — ${formattedEp}`);

    const epIndex = serie!.episodes.findIndex(e => e.season === (season || 1) && e.episodeNumber === (episodeNumber || 1));
    if (epIndex === -1) return { success: false, message: 'Épisode sauvegardé mais index introuvable', dbAction: 'updated' };

    try {
      console.log(`[Uqload] ○ Upload Uqload: ${titre} — ${formattedEp}`);
      const { fileCode, directLink } = await client.uploadByUrlAndGetLink(url, `${titre} - ${formattedEp}`);
      const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];
      console.log(`[Uqload] ✓ Upload Uqload OK: ${titre} — ${formattedEp} → ${fileCode}`);
      console.log(`[Uqload] ○ Update DB uqloadCode: ${formattedEp} → ${fileCode}`);
      await Serie.updateOne(
        { _id: serie!._id },
        { $set: { [`episodes.${epIndex}.uqloadCode`]: fileCode, [`episodes.${epIndex}.uqloadLink`]: bestQuality?.url || null } },
      );
      console.log(`[Uqload] ✓ DB mise à jour: ${titre} — ${formattedEp}`);
      return { success: true, fileCode, directLink: bestQuality?.url, dbAction: 'updated' };
    } catch (e: any) {
      console.log(`[Uqload] ✗ Upload échoué: ${titre} — ${formattedEp}: ${e.message}`);
      return { success: false, message: e.message, dbAction: 'updated' };
    }
  }

  console.log(`[Uqload] ○ Vérification doublon film: ${titre}`);
  const existing = await Movie.findOne({ titre: new RegExp(`^${escaped}$`, 'i'), lien: url });
  if (existing) {
    console.log(`[Uqload] ✗ Doublon film: ${titre}`);
    return { success: false, message: 'Doublon: ce lien existe déjà en BD', dbAction: 'duplicate' };
  }

  console.log(`[Uqload] ○ Sauvegarde DB film: ${titre}`);
  const movie = await Movie.findOneAndUpdate(
    { titre },
    { $set: { titre, pageUrl, lien: url, ...(year ? { year } : {}) } },
    { upsert: true, returnDocument: 'after' },
  );
  console.log(`[Uqload] ✓ Sauvegarde DB film OK: ${titre}`);

  try {
    console.log(`[Uqload] ○ Upload Uqload film: ${titre}`);
    const { fileCode, directLink } = await client.uploadByUrlAndGetLink(url, titre);
    const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];
    console.log(`[Uqload] ✓ Upload Uqload film OK: ${titre} → ${fileCode}`);
    console.log(`[Uqload] ○ Update DB uqloadCode film: ${titre} → ${fileCode}`);
    await Movie.updateOne(
      { _id: movie._id },
      {
        $set: {
          uqloadCode: fileCode,
          uqloadLink: bestQuality?.url || null,
          uqloadQualities: directLink?.versions || [],
          uqloadHls: directLink?.hls_direct || null,
        },
      },
    );
    console.log(`[Uqload] ✓ DB film mise à jour: ${titre}`);
    return { success: true, fileCode, directLink: bestQuality?.url, dbAction: 'created' };
  } catch (e: any) {
    console.log(`[Uqload] ✗ Upload film échoué: ${titre}: ${e.message}`);
    return { success: false, message: e.message, dbAction: 'created' };
  }
}

const BATCH_SIZE = 100;
let isUploading = false;
let shouldStop = false;

export function stopUpload() {
  shouldStop = true;
  console.log('[Uqload] Arrêt demandé…');
}

export function isUploadRunning() {
  return isUploading;
}

export async function uploadMoviesBatch(client: UqloadClient): Promise<BatchResult> {
  isUploading = true;
  shouldStop = false;
  const startTime = Date.now();
  const errors: string[] = [];
  let success = 0;
  let failed = 0;

  try {
    const pending = await Movie.find({ $or: [{ uqloadCode: { $eq: null } }, { uqloadCode: { $exists: false } }] })
      .limit(BATCH_SIZE)
      .lean();

    const total = pending.length;
    if (total === 0) {
      console.log('[Uqload] Aucun film à uploader');
      return { total: 0, success: 0, failed: 0, errors: [], duration: 0, remaining: 0 };
    }

    console.log(`[Uqload] Upload de ${total} films…`);

    for (let i = 0; i < total; i++) {
      if (shouldStop) break;

      const movie = pending[i];
      try {
        console.log(`[Uqload] (${i + 1}/${total}) ${movie.titre}`);

        const { fileCode, directLink } = await client.uploadByUrlAndGetLink(movie.lien, movie.titre);
        const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];

        await Movie.updateOne(
          { _id: movie._id },
          {
            $set: {
              uqloadCode: fileCode,
              uqloadLink: bestQuality?.url || null,
              uqloadQualities: directLink?.versions || [],
              uqloadHls: directLink?.hls_direct || null,
            }
          }
        );

        success++;
        console.log(`[Uqload] ✅ ${movie.titre} → ${fileCode}`);
      } catch (e: any) {
        failed++;
        errors.push(`${movie.titre}: ${e.message}`);
        console.log(`[Uqload] ❌ ${movie.titre}: ${e.message}`);
      }
    }

    const remaining = await Movie.countDocuments({ $or: [{ uqloadCode: { $eq: null } }, { uqloadCode: { $exists: false } }] });

    return { total, success, failed, errors, duration: (Date.now() - startTime) / 1000, remaining };
  } finally {
    isUploading = false;
  }
}

export async function uploadSeriesBatch(client: UqloadClient): Promise<BatchResult> {
  isUploading = true;
  shouldStop = false;
  const startTime = Date.now();
  const errors: string[] = [];
  let success = 0;
  let failed = 0;

  try {
    const series = await Serie.find({ 'episodes.uqloadCode': { $eq: null } })
      .limit(BATCH_SIZE)
      .lean();

    let totalEpisodes = 0;
    const episodesToUpload: { serieId: string; serieTitre: string; episodeIndex: number; episode: any }[] = [];

    for (const serie of series) {
      for (let idx = 0; idx < (serie.episodes || []).length; idx++) {
        const ep = serie.episodes[idx];
        if (!ep.uqloadCode) {
          episodesToUpload.push({ serieId: serie._id.toString(), serieTitre: serie.titre, episodeIndex: idx, episode: ep });
          totalEpisodes++;
        }
      }
    }

    if (totalEpisodes === 0) {
      console.log('[Uqload] Aucun épisode à uploader');
      return { total: 0, success: 0, failed: 0, errors: [], duration: 0, remaining: 0 };
    }

    console.log(`[Uqload] Upload de ${Math.min(totalEpisodes, BATCH_SIZE)} épisodes…`);

    for (let i = 0; i < Math.min(totalEpisodes, BATCH_SIZE); i++) {
      if (shouldStop) break;

      const { serieId, serieTitre, episodeIndex, episode } = episodesToUpload[i];
      const label = `${serieTitre} - ${episode.episode}`;

      try {
        console.log(`[Uqload] (${i + 1}/${Math.min(totalEpisodes, BATCH_SIZE)}) ${label}`);

        const { fileCode, directLink } = await client.uploadByUrlAndGetLink(episode.lien, label);
        const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];

        await Serie.updateOne(
          { _id: serieId },
          { $set: { [`episodes.${episodeIndex}.uqloadCode`]: fileCode, [`episodes.${episodeIndex}.uqloadLink`]: bestQuality?.url || null } }
        );

        success++;
        console.log(`[Uqload] ✅ ${label} → ${fileCode}`);
      } catch (e: any) {
        failed++;
        errors.push(`${label}: ${e.message}`);
        console.log(`[Uqload] ❌ ${label}: ${e.message}`);
      }
    }

    return {
      total: Math.min(totalEpisodes, BATCH_SIZE),
      success,
      failed,
      errors,
      duration: (Date.now() - startTime) / 1000,
      remaining: totalEpisodes - success - failed,
    };
  } finally {
    isUploading = false;
  }
}

export async function uploadSingleMovie(client: UqloadClient, movieId: string): Promise<void> {
  const movie = await Movie.findById(movieId);
  if (!movie) throw new Error('Film introuvable');

  console.log(`[Uqload] Upload film: ${movie.titre}`);
  const { fileCode, directLink } = await client.uploadByUrlAndGetLink(movie.lien, movie.titre);
  const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];

  await Movie.updateOne(
    { _id: movie._id },
    {
      $set: {
        uqloadCode: fileCode,
        uqloadLink: bestQuality?.url || null,
        uqloadQualities: directLink?.versions || [],
        uqloadHls: directLink?.hls_direct || null,
      }
    }
  );
  console.log(`[Uqload] ✅ ${movie.titre} → ${fileCode}`);
}

export async function uploadSingleEpisode(client: UqloadClient, serieId: string, episodeIndex: number): Promise<void> {
  const serie = await Serie.findById(serieId);
  if (!serie) throw new Error('Série introuvable');
  const ep = serie.episodes[episodeIndex];
  if (!ep) throw new Error('Épisode introuvable');

  const label = `${serie.titre} - ${ep.episode}`;
  console.log(`[Uqload] Upload épisode: ${label}`);

  const { fileCode, directLink } = await client.uploadByUrlAndGetLink(ep.lien, label);
  const bestQuality = directLink?.versions?.find((v: any) => v.name === 'n') || directLink?.versions?.[0];

  await Serie.updateOne(
    { _id: serieId },
    { $set: { [`episodes.${episodeIndex}.uqloadCode`]: fileCode, [`episodes.${episodeIndex}.uqloadLink`]: bestQuality?.url || null } }
  );
  console.log(`[Uqload] ✅ ${label} → ${fileCode}`);
}
