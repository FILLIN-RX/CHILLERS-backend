// @ts-nocheck
import * as streamingService from "./streaming.service";
import * as types_1 from "../types";
export const getMovieStreamFast = async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id))
            throw new types_1.AppError('Valid TMDB movie ID is required', 400);
        const result = await streamingService.getMovieStreamFast({
            tmdbId: id,
            type: req.query.type || 'movie',
            title: req.query.title,
            language: req.query.language || 'fr',
        });
        if (!result) {
            res.json({ success: false, data: null, message: 'Aucun flux local disponible.' });
            return;
        }
        res.json({
            success: true,
            data: { embedUrl: result.embedUrl },
            provider: result.provider,
            message: null,
        });
    }
    catch (error) {
        next(error);
    }
};
export const getEpisodeStreamFast = async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const season = parseInt(req.params.season, 10);
        const episode = parseInt(req.params.episode, 10);
        if (isNaN(id) || isNaN(season) || isNaN(episode)) {
            throw new types_1.AppError('Valid TMDB TV ID, season, and episode are required', 400);
        }
        const result = await streamingService.getEpisodeStreamFast({
            tmdbId: id,
            type: req.query.type || 'tv',
            title: req.query.title,
            season,
            episode,
            language: req.query.language || 'fr',
        });
        if (!result) {
            res.json({ success: false, data: null, message: 'Aucun flux local disponible.' });
            return;
        }
        res.json({
            success: true,
            data: { embedUrl: result.embedUrl },
            provider: result.provider,
            message: null,
        });
    }
    catch (error) {
        next(error);
    }
};
