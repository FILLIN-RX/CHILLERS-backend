import { Router, Response } from 'express';
import axios from 'axios';
import { adminMiddleware, AuthRequest } from '../admin/admin.middleware';
import { generateAICompletion } from './ai';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';

const router = Router();

const SITE_BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://chillers.vercel.app').replace(/\/$/, '');

// Shared TMDB fetch helper with fallback token
async function fetchTmdbTrending(endpoint: string): Promise<any[]> {
  const token = process.env.TMDB_TOKEN || process.env.NEXT_PUBLIC_TMDB_TOKEN;
  if (!token) return [];
  try {
    const { data } = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    return data?.results || [];
  } catch (err: any) {
    console.warn(`[AI Routes] TMDB fetch failed (${endpoint}):`, err.message);
    return [];
  }
}

/**
 * POST /api/admin/ai/social-suggestions
 * Génère des suggestions de posts sociaux quotidiens basées sur les films/séries du catalogue + les tendances web
 */
router.post('/social-suggestions', adminMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    // 1. Récupérer un échantillon de films & séries disponibles en base
    const [movies, series] = await Promise.all([
      Movie.find({ disponible: { $ne: false } }).sort({ createdAt: -1 }).limit(15).select('titre tmdbId year speech'),
      Serie.find({ disponible: { $ne: false } }).sort({ createdAt: -1 }).limit(15).select('titre tmdbId year speech'),
    ]);

    const catalogItems = [
      ...movies.map(m => ({ id: m._id, titre: m.titre, type: 'movie', tmdbId: m.tmdbId, year: m.year })),
      ...series.map(s => ({ id: s._id, titre: s.titre, type: 'series', tmdbId: s.tmdbId, year: s.year })),
    ];

    if (catalogItems.length === 0) {
      res.status(400).json({
        success: false,
        data: null,
        message: 'Aucun film ou série disponible dans le catalogue pour générer des suggestions.',
      });
      return;
    }

    // 2. Récupérer le top tendance TMDB du moment
    const trendingTmdb = await fetchTmdbTrending('trending/all/day?language=fr-FR');
    const trendingTitles = trendingTmdb.slice(0, 10).map(t => t.title || t.name).filter(Boolean);

    // 3. Formuler le prompt pour l'IA
    const systemPrompt = `Tu es l'assistant marketing digital expert de CHILLERS, une plateforme de streaming gratuit de films et séries en VF/VOSTFR. Ton objectif est de fournir des suggestions de posts réseaux sociaux très engageantes, modernes, captivantes, avec des emojis et des hashtags ciblés.`;

    const prompt = `Voici une sélection de titres disponibles dans notre catalogue CHILLERS :
${catalogItems.map(c => `- ${c.titre} (${c.type === 'movie' ? 'Film' : 'Série'}${c.year ? `, ${c.year}` : ''}) [TMDB: ${c.tmdbId || 'N/A'}]`).join('\n')}

Tendances actuelles recherchées sur le web :
${trendingTitles.join(', ')}

Génère exactement 5 suggestions de posts de réseaux sociaux prêtes à publier pour aujourd'hui.
Structure ta réponse obligatoirement sous la forme d'un objet JSON contenant une clé "suggestions" qui est un tableau d'objets avec les champs suivants :
- "platform": (string, exemple "Instagram / TikTok", "Facebook", "Telegram / WhatsApp")
- "mediaTitle": (string, nom exact du titre choisi parmi notre catalogue ci-dessus)
- "mediaType": (string, "movie" ou "series")
- "tmdbId": (number ou null)
- "hook": (string, titre/accroche percutante en une ligne)
- "caption": (string, texte complet du post avec émoticônes, appel à l'action convivial "À regarder gratuitement sur CHILLERS", et hashtags)
- "chillersLink": (string, lien vers le titre, ex: "${SITE_BASE_URL}/media/12345?type=movie")

Réponds exclusivement en JSON valide.`;

    const aiRes = await generateAICompletion({
      prompt,
      systemPrompt,
      maxTokens: 2500,
      temperature: 0.75,
      jsonMode: true,
    });

    let suggestions: any[] = [];
    try {
      const parsed = JSON.parse(aiRes.text);
      suggestions = Array.isArray(parsed) ? parsed : parsed.suggestions || [];
    } catch {
      // Si la réponse n'est pas un JSON pur
      suggestions = [
        {
          platform: 'Instagram / TikTok',
          mediaTitle: catalogItems[0]?.titre || 'Catalogue CHILLERS',
          mediaType: catalogItems[0]?.type || 'movie',
          hook: '🎬 Sélection Streaming de la semaine !',
          caption: aiRes.text,
          chillersLink: SITE_BASE_URL,
        },
      ];
    }

    res.json({
      success: true,
      data: {
        suggestions,
        usedProvider: aiRes.usedProvider,
      },
      message: 'Suggestions de posts sociaux générées avec succès.',
    });
  } catch (err: any) {
    console.error('[AI Routes] Erreur social-suggestions:', err.message);
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

/**
 * GET /api/admin/ai/content-gap
 * Identifie les films & séries très demandés / tendances sur le web qui MANQUENT dans le catalogue CHILLERS
 */
router.get('/content-gap', adminMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    // 1. Récupérer les tendances TMDB semaine (films + séries)
    const [trendingMovies, trendingTV] = await Promise.all([
      fetchTmdbTrending('trending/movie/week?language=fr-FR'),
      fetchTmdbTrending('trending/tv/week?language=fr-FR'),
    ]);

    // 2. Extraire tous les tmdbIds et titres de notre base de données locale
    const [existingMovies, existingSeries] = await Promise.all([
      Movie.find().select('tmdbId titre'),
      Serie.find().select('tmdbId titre'),
    ]);

    const existingTmdbIds = new Set<number>();
    const existingTitlesNorm = new Set<string>();

    existingMovies.forEach(m => {
      if (m.tmdbId) existingTmdbIds.add(m.tmdbId);
      if (m.titre) existingTitlesNorm.add(m.titre.trim().toLowerCase());
    });
    existingSeries.forEach(s => {
      if (s.tmdbId) existingTmdbIds.add(s.tmdbId);
      if (s.titre) existingTitlesNorm.add(s.titre.trim().toLowerCase());
    });

    // 3. Filtrer les contenus TMDB tendances qui N'EXISTENT PAS chez nous
    const missingCandidates: any[] = [];

    const processCandidates = (items: any[], type: 'movie' | 'tv') => {
      for (const item of items) {
        if (!item || !item.id) continue;
        const title = item.title || item.name || '';
        const titleNorm = title.trim().toLowerCase();
        if (existingTmdbIds.has(item.id) || existingTitlesNorm.has(titleNorm)) {
          continue; // Déjà présent dans CHILLERS
        }
        missingCandidates.push({
          tmdbId: item.id,
          title,
          type: type === 'movie' ? 'movie' : 'series',
          overview: item.overview || '',
          releaseDate: item.release_date || item.first_air_date || '',
          voteAverage: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
          posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
          popularity: item.popularity || 0,
        });
      }
    };

    processCandidates(trendingMovies, 'movie');
    processCandidates(trendingTV, 'tv');

    // Trier par popularité et prendre les 10 meilleurs candidats manquants
    missingCandidates.sort((a, b) => b.popularity - a.popularity);
    const topMissing = missingCandidates.slice(0, 10);

    if (topMissing.length === 0) {
      res.json({
        success: true,
        data: { items: [], usedProvider: 'gemini' },
        message: 'Félicitations ! Votre catalogue contient déjà tous les titres tendances du moment.',
      });
      return;
    }

    // 4. Utiliser l'IA pour rédiger un motif de recommandation percutant pour chaque titre manquant
    const systemPrompt = `Tu es un analyste de données spécialisé dans l'industrie du cinéma et du streaming.`;
    const prompt = `Voici une liste de films et séries très demandés actuellement sur le web qui manquent au catalogue de notre plateforme CHILLERS :
${topMissing.map(m => `- ${m.title} (${m.type === 'movie' ? 'Film' : 'Série'}, Note: ${m.voteAverage || 'N/A'}/10)`).join('\n')}

Pour chaque titre, donne une raison courte (1 phrase percutante en français) expliquant pourquoi l'administrateur devrait absolument l'ajouter maintenant (ex: "Forte tendance sur les réseaux sociaux cette semaine", "Nouvelle saison très attendue par les fans", "Grand succès box-office récent").

Structure ta réponse sous la forme d'un JSON valide sous la forme :
{
  "recommendations": [
    { "tmdbId": 123, "reason": "Explication courte..." }
  ]
}`;

    let usedProvider: 'gemini' | 'groq' = 'gemini';
    let recommendationsMap: Record<number, string> = {};

    try {
      const aiRes = await generateAICompletion({
        prompt,
        systemPrompt,
        maxTokens: 1200,
        temperature: 0.6,
        jsonMode: true,
      });
      usedProvider = aiRes.usedProvider;
      const parsed = JSON.parse(aiRes.text);
      const list = parsed.recommendations || parsed;
      if (Array.isArray(list)) {
        list.forEach((r: any) => {
          if (r.tmdbId && r.reason) {
            recommendationsMap[r.tmdbId] = r.reason;
          }
        });
      }
    } catch (err: any) {
      console.warn('[AI Routes] Erreur IA pour content-gap recommendations:', err.message);
    }

    // Associer la raison IA à chaque candidat
    const finalItems = topMissing.map(m => ({
      ...m,
      reason:
        recommendationsMap[m.tmdbId] ||
        `Titre très populaire cette semaine avec une note de ${m.voteAverage || '7'}/10. Très recherché par le public.`,
    }));

    res.json({
      success: true,
      data: {
        items: finalItems,
        usedProvider,
      },
      message: `${finalItems.length} contenus très demandés identifiés.`,
    });
  } catch (err: any) {
    console.error('[AI Routes] Erreur content-gap:', err.message);
    res.status(500).json({ success: false, data: null, message: err.message });
  }
});

export default router;
