import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import DeadLink from '../../models/DeadLink';

const LOG_DIR = path.join(__dirname, '../..');

function readLogFile(filename: string, lines: number = 100): string[] {
    try {
        const fullPath = path.join(LOG_DIR, filename);
        if (!fs.existsSync(fullPath)) return ['(fichier introuvable)'];
        const content = fs.readFileSync(fullPath, 'utf-8');
        const allLines = content.split('\n').filter(l => l);
        return allLines.slice(-lines);
    } catch (e: any) {
        return [`Erreur lecture: ${e.message}`];
    }
}

export async function getDashboardStats() {
    const moviesCount = await Movie.countDocuments();
    const seriesCount = await Serie.countDocuments();
    const completeSeries = await Serie.countDocuments({ pageUrl: { $ne: null }, episodes: { $ne: [] } });
    const totalEpisodes = await Serie.aggregate([
        { $unwind: '$episodes' },
        { $count: 'total' }
    ]);

    const deadLinksCount = await Serie.countDocuments({
        'episodes.lien': { $in: ['#', null, ''] }
    });

    const tmdbLinkedMovies = await Movie.countDocuments({ tmdbId: { $ne: null } });
    const tmdbLinkedSeries = await Serie.countDocuments({ tmdbId: { $ne: null } });

    return {
        movies: moviesCount,
        series: seriesCount,
        completeSeries,
        totalEpisodes: totalEpisodes[0]?.total || 0,
        deadLinks: deadLinksCount,
        tmdbLinkedMovies,
        tmdbLinkedSeries,
        uptime: process.uptime()
    };
}

export async function getDeadLinks() {
    const dead = await DeadLink.find()
        .sort({ lastChecked: -1 })
        .limit(200)
        .lean();
    return dead.map(d => ({ _id: d._id, titre: d.titre, episode: d.episode, lien: d.lien, type: d.type }));
}

export async function appealDeadLink(id: string) {
    const link = await DeadLink.findById(id);
    if (!link) return { found: false, alive: false };

    const { isLinkDead } = await import('../../scraping/core/link-checker');
    const dead = await isLinkDead(link.lien);
    if (!dead) {
        await DeadLink.findByIdAndDelete(id);
        return { found: true, alive: true, titre: link.titre, episode: link.episode };
    }
    return { found: true, alive: false, titre: link.titre, episode: link.episode };
}

export function getTmdbLinkErrors(lines: number = 100) {
    return {
        series: readLogFile('tmdb-link-errors.log', lines),
        movies: readLogFile('tmdb-movie-link-errors.log', lines)
    };
}

export function getCronLogs(lines: number = 100) {
    try {
        const { getLogs } = require('../../config/log-buffer');
        const logs = getLogs(lines);
        return logs.length > 0 ? logs : ['(buffer vide)'];
    } catch {
        return readLogFile('cron-manager.log', lines);
    }
}

export async function searchCollection(type: string, q: string, page: number, limit: number) {
    const Model: any = type === 'series' ? Serie : Movie;
    const filter: any = {};
    if (q) filter.titre = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const projection = type === 'series'
      ? 'titre pageUrl lien tmdbId createdAt episodes.uqloadCode episodes.fileCode episodes.episode episodes.season episodes.episodeNumber episodes.lien'
      : 'titre pageUrl lien tmdbId createdAt uqloadCode uqloadLink fileCode uqloadQualities';
    const [items, total] = await Promise.all([
        Model.find(filter, projection).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Model.countDocuments(filter),
    ]);
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getRecentItems() {
    const [recentMovies, recentSeries] = await Promise.all([
        Movie.find().sort({ createdAt: -1 }).limit(5).select('titre createdAt tmdbId').lean(),
        Serie.find().sort({ createdAt: -1 }).limit(5).select('titre createdAt tmdbId episodes').lean(),
    ]);

    const now = Date.now();
    const fmt = (d: any) => {
        const diff = now - new Date(d).getTime();
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        if (h > 24) return `${Math.floor(h / 24)}j`;
        if (h > 0) return `${h}h`;
        return `${m}min`;
    };

    return {
        movies: recentMovies.map(m => ({
            _id: m._id,
            titre: m.titre,
            tmdbId: m.tmdbId,
            addedAt: m.createdAt,
            ago: fmt(m.createdAt),
        })),
        series: recentSeries.map(s => ({
            _id: s._id,
            titre: s.titre,
            tmdbId: s.tmdbId,
            episodesCount: (s as any).episodes?.length || 0,
            addedAt: s.createdAt,
            ago: fmt(s.createdAt),
        })),
    };
}

export async function getHealth() {
    let dbStatus = '❌';
    let dbMessage = 'Non connecté';
    try {
        if (mongoose.connection.readyState === 1) {
            dbStatus = '✓';
            dbMessage = 'Connecté';
        } else if (mongoose.connection.readyState === 2) {
            dbStatus = '⋯';
            dbMessage = 'Connexion en cours';
        } else {
            dbStatus = '❌';
            dbMessage = 'Déconnecté';
        }
    } catch { dbMessage = 'Erreur'; }

    return {
        database: { status: dbStatus, message: dbMessage },
        email: {
            status: process.env.EMAIL_USER && process.env.EMAIL_PASS ? '✓' : '⚠',
            message: process.env.EMAIL_USER && process.env.EMAIL_PASS
                ? `Configuré (${process.env.EMAIL_USER})`
                : 'Non configuré',
        },
        tmdb: {
            status: process.env.TMDB_TOKEN ? '✓' : '❌',
            message: process.env.TMDB_TOKEN ? 'Token présent' : 'Token manquant',
        },
        doodstream: {
            status: process.env.DOODSTREAM_API_KEY ? '✓' : '⚠',
            message: process.env.DOODSTREAM_API_KEY ? 'API Key présente' : 'Non configuré',
        },
    };
}

export async function getTmdbStats() {
    const [totalMovies, totalSeries, linkedMovies, linkedSeries] = await Promise.all([
        Movie.countDocuments(),
        Serie.countDocuments(),
        Movie.countDocuments({ tmdbId: { $ne: null } }),
        Serie.countDocuments({ tmdbId: { $ne: null } }),
    ]);

    return {
        movies: { total: totalMovies, linked: linkedMovies, unlinked: totalMovies - linkedMovies },
        series: { total: totalSeries, linked: linkedSeries, unlinked: totalSeries - linkedSeries },
    };
}

export async function getScraperState() {
    const ScraperState = (await import('../../models/ScraperState')).default;
    const films = await ScraperState.findOne({ name: 'films' });
    const series = await ScraperState.findOne({ name: 'series' });
    return {
        films: films ? { lastPage: films.lastPage, updatedAt: films.updatedAt } : null,
        series: series ? { lastPage: series.lastPage, updatedAt: series.updatedAt } : null,
    };
}

export function getSettings() {
    return {
        corsOrigin: process.env.CORS_ORIGIN || 'non défini',
        port: process.env.PORT || '4000',
        mongoUri: process.env.MONGO_URI ? '✓ configuré' : '✗ manquant',
        tmdbApiKey: process.env.TMDB_API_KEY ? '✓ configuré' : '✗ manquant',
        doodstreamApiKey: process.env.DOODSTREAM_API_KEY ? '✓ configuré' : '✗ manquant',
        doodstreamUser: process.env.DOODSTREAM_USER ? '✓ configuré' : '✗ manquant',
        notificationEmail: process.env.NOTIFICATION_EMAIL || 'non défini',
        adminUsername: process.env.ADMIN_USERNAME ? '✓ configuré' : '✗ manquant',
        jwtSecretConfigured: !!process.env.JWT_SECRET,
    };
}
