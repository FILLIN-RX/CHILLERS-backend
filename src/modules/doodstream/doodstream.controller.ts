import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import * as doodService from './doodstream.service';
import { AppError } from '../../types';

export const getAccountInfo = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await doodService.getAccountInfo();
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getAccountStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const last = Number(req.query.last) || undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await doodService.getAccountStats(last, from, to);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const remoteUploadAdd = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, fld_id, new_title } = req.query as Record<string, string>;
    if (!url) throw new AppError('Missing ?url= param', 400);
    const data = await doodService.remoteUploadAdd(url, fld_id, new_title);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const remoteUploadList = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await doodService.remoteUploadList();
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const remoteUploadStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code } = req.query as Record<string, string>;
    if (!file_code) throw new AppError('Missing ?file_code= param', 400);
    const data = await doodService.remoteUploadStatus(file_code);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const remoteUploadSlots = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await doodService.remoteUploadSlots();
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const remoteUploadActions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { restart_errors, clear_errors, clear_all, delete_code } = req.query as Record<string, string>;
    const msg = await doodService.remoteUploadActions({
      restartErrors: !!restart_errors,
      clearErrors: !!clear_errors,
      clearAll: !!clear_all,
      deleteCode: delete_code,
    });
    res.json({ success: true, data: { msg }, message: null });
  } catch (error) {
    next(error);
  }
};

export const createFolder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, parent_id } = req.query as Record<string, string>;
    if (!name) throw new AppError('Missing ?name= param', 400);
    const data = await doodService.createFolder(name, parent_id);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const renameFolder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fld_id, name } = req.query as Record<string, string>;
    if (!fld_id || !name) throw new AppError('Missing ?fld_id= or ?name=', 400);
    const data = await doodService.renameFolder(fld_id, name);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const listFolders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fld_id, only_folders } = req.query as Record<string, string>;
    const data = await doodService.listFolders(fld_id || '0', only_folders === '1');
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const listFiles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, per_page, fld_id, created } = req.query as Record<string, string>;
    const data = await doodService.listFiles({
      page: Number(page) || undefined,
      perPage: Number(per_page) || undefined,
      fldId: fld_id,
      created,
    });
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getFileInfo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code } = req.query as Record<string, string>;
    if (!file_code) throw new AppError('Missing ?file_code= param', 400);
    const data = await doodService.getFileInfo(file_code);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const checkFileStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code } = req.query as Record<string, string>;
    if (!file_code) throw new AppError('Missing ?file_code= param', 400);
    const data = await doodService.checkFileStatus(file_code);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const getFileImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code } = req.query as Record<string, string>;
    if (!file_code) throw new AppError('Missing ?file_code= param', 400);
    const data = await doodService.getFileImage(file_code);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const renameFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code, title } = req.query as Record<string, string>;
    if (!file_code || !title) throw new AppError('Missing ?file_code= or ?title=', 400);
    const data = await doodService.renameFile(file_code, title);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const moveFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code, fld_id } = req.query as Record<string, string>;
    if (!file_code || !fld_id) throw new AppError('Missing ?file_code= or ?fld_id=', 400);
    const data = await doodService.moveFile(file_code, fld_id);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const searchFiles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search_term } = req.query as Record<string, string>;
    if (!search_term) throw new AppError('Missing ?search_term= param', 400);
    const data = await doodService.searchFiles(search_term);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

export const cloneFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_code, fld_id } = req.query as Record<string, string>;
    if (!file_code) throw new AppError('Missing ?file_code= param', 400);
    const data = await doodService.cloneFile(file_code, fld_id);
    res.json({ success: true, data, message: null });
  } catch (error) {
    next(error);
  }
};

/* ── Series Episode Management ── */

export const addSeriesEpisode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tmdb_id, season, episode, file_code, title, lien } = req.body as Record<string, string>;
    if (!tmdb_id || !season || !episode || !file_code) {
      throw new AppError('Missing required fields: tmdb_id, season, episode, file_code', 400);
    }

    const tmdbIdNum = Number(tmdb_id);
    const seasonNum = Number(season);
    const episodeNum = Number(episode);

    // Create folder structure on DoodStream: _SERIES/{tmdbId}-{title}/Season {season}
    const seriesFolderName = `${tmdbIdNum}-${(title || 'unknown').replace(/[^a-zA-Z0-9 ]/g, '').trim()}`;

    // Look for existing _SERIES parent folder
    let seriesFldId: string | null = null;
    let seasonFldId: string | null = null;

    const existingSeriesFolders = await doodService.listFolders('0', true);
    const seriesFolders = existingSeriesFolders.folders || [];
    for (const f of seriesFolders) {
      if (f.label === seriesFolderName || f.name === seriesFolderName) {
        seriesFldId = f.fld_id;
        break;
      }
    }

    if (!seriesFldId) {
      // Also try to find or create _SERIES root
      let rootFldId: string | null = null;
      for (const f of seriesFolders) {
        if (f.label === '_SERIES' || f.name === '_SERIES') {
          rootFldId = f.fld_id;
          break;
        }
      }
      if (!rootFldId) {
        const rootFolder = await doodService.createFolder('_SERIES');
        rootFldId = rootFolder.fld_id;
      }

      const seriesFolder = await doodService.createFolder(seriesFolderName, rootFldId || undefined);
      seriesFldId = seriesFolder.fld_id;
    }

    if (!seriesFldId) {
      throw new AppError('Failed to create or find series folder', 500);
    }

    // Find or create Season folder inside series folder
    const seasonFolderName = `Season ${seasonNum}`;
    const seasonFoldersResult = await doodService.listFolders(seriesFldId, true);
    const seasonFoldersList = seasonFoldersResult.folders || [];
    for (const f of seasonFoldersList) {
      if (f.label === seasonFolderName || f.name === seasonFolderName) {
        seasonFldId = f.fld_id;
        break;
      }
    }

    if (!seasonFldId) {
      const seasonFolder = await doodService.createFolder(seasonFolderName, seriesFldId);
      seasonFldId = seasonFolder.fld_id;
    }

    if (!seasonFldId) {
      throw new AppError('Failed to create or find season folder', 500);
    }

    // Move the file into the Season folder
    await doodService.moveFile(file_code, seasonFldId);

    // Update series-output.json
    const outputPath = path.join(__dirname, '../../../series-output.json');
    let output: Record<string, any> = {};
    if (fs.existsSync(outputPath)) {
      output = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    }

    const key = `${tmdbIdNum}_S${seasonNum}E${episodeNum}`;
    output[key] = {
      fileCode: file_code,
      titre: title || `Episode ${episodeNum}`,
      lien: lien || null,
      tmdbId: tmdbIdNum,
      season: seasonNum,
      episode: episodeNum,
      fldId: seasonFldId,
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    res.json({
      success: true,
      data: {
        tmdbId: tmdbIdNum,
        season: seasonNum,
        episode: episodeNum,
        fileCode: file_code,
        fldId: seasonFldId,
      },
      message: null,
    });
  } catch (error) {
    next(error);
  }
};

export const listSeriesEpisodes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId as string, 10);
    if (isNaN(tmdbId)) throw new AppError('Valid TMDB ID is required', 400);

    const outputPath = path.join(__dirname, '../../../series-output.json');
    let output: Record<string, any> = {};
    if (fs.existsSync(outputPath)) {
      output = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    }

    const episodes: any[] = [];
    for (const key of Object.keys(output)) {
      const file = output[key];
      if (file.tmdbId && Number(file.tmdbId) === tmdbId && file.season !== undefined && file.episode !== undefined) {
        episodes.push(file);
      }
    }

    // Sort by season then episode
    episodes.sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      return a.episode - b.episode;
    });

    res.json({ success: true, data: { tmdbId, episodes }, message: null });
  } catch (error) {
    next(error);
  }
};
