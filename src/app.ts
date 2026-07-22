import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { errorMiddleware } from './middleware/error.middleware';
import { clearCache } from './config/tmdb';
import moviesRoutes from './modules/movies/movies.routes';
import tvRoutes from './modules/tv/tv.routes';
import searchRoutes from './modules/search/search.routes';
import genresRoutes from './modules/genres/genres.routes';
import streamingRoutes from './streaming/streaming.routes';
import downloadRoutes from './modules/download/download.routes';
import doodstreamRoutes from './modules/doodstream/doodstream.routes';
import otakuRoutes from './modules/otaku/otaku.routes';
import adminRoutes from './modules/admin/admin.routes';

import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      frameSrc: ["'self'", "https://animekai.to", "https://*.vidlink.pro", "https://vidapi.xyz", "https://www.youtube.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      imgSrc: ["'self'", "data:", "https:"],
      mediaSrc: ["'self'", "https:", "blob:"],
    },
  },
}));
const allowedOrigins = (process.env.CORS_ORIGIN || 'https://chillers-pi.vercel.app').split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*')) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.some(o => origin.startsWith(o))) {
      callback(null, true);
      return;
    }
    callback(null, true);
  },
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' }, message: null });
});

app.post('/api/clear-cache', (_req, res) => {
  clearCache();
  res.json({ success: true, data: null, message: 'TMDB cache cleared' });
});

app.use('/api/movies', moviesRoutes);
app.use('/api/tv', tvRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/genres', genresRoutes);
app.use('/api/stream', streamingRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/doodstream', doodstreamRoutes);
app.use('/api/otaku', otakuRoutes);
app.use('/api/admin', adminRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    data: null,
    message: 'Route not found',
  });
});

app.use(errorMiddleware);

export default app;
