import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../../models/User';
import { SubscriptionPlan } from '../../models/SubscriptionPlan';

export const toggleFavorite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    const { mediaType, tmdbId, title, posterPath } = req.body;

    if (!mediaType || !tmdbId || !title) {
      res.status(400).json({ success: false, message: 'Données manquantes' });
      return;
    }

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
      return;
    }

    const index = user.favorites.findIndex((f) => f.tmdbId === String(tmdbId) && f.mediaType === mediaType);
    if (index > -1) {
      user.favorites.splice(index, 1);
    } else {
      user.favorites.push({ mediaType, tmdbId: String(tmdbId), title, posterPath });
    }

    await user.save();
    res.json({ success: true, favorites: user.favorites });
  } catch (error) {
    console.error('[User] Erreur toggleFavorite:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};

export const updateProgress = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    const { tmdbId, mediaType, season, episode, progress, duration, title, posterPath, backdropPath } = req.body;

    if (!mediaType || !tmdbId || progress === undefined || !duration || !title) {
      res.status(400).json({ success: false, message: 'Données manquantes' });
      return;
    }

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
      return;
    }

    const planCode = user.subscription?.plan || 'free';
    const planDoc = await SubscriptionPlan.findOne({ code: planCode });
    if (!planDoc?.features?.hasContinueWatching) {
      res.status(403).json({ success: false, message: 'Votre abonnement ne permet pas de reprendre la lecture.' });
      return;
    }

    const index = user.continueWatching.findIndex(
      (cw) => cw.tmdbId === String(tmdbId) && cw.season === season && cw.episode === episode
    );

    if (index > -1) {
      // Remove if watching is almost complete (e.g., less than 3 minutes left)
      if (duration - progress < 180) {
        user.continueWatching.splice(index, 1);
      } else {
        user.continueWatching[index].progress = progress;
        user.continueWatching[index].updatedAt = new Date();
      }
    } else {
      if (duration - progress >= 180) {
        user.continueWatching.push({
          tmdbId: String(tmdbId),
          mediaType,
          season,
          episode,
          progress,
          duration,
          title,
          posterPath,
          backdropPath,
          updatedAt: new Date(),
        });
      }
    }

    // If user has watch history feature, record in history as well
    if (planDoc?.features?.hasWatchHistory) {
      const histIndex = user.watchHistory.findIndex(
        (h) => h.tmdbId === String(tmdbId) && h.mediaType === mediaType && h.season === season && h.episode === episode
      );
      if (histIndex > -1) {
        user.watchHistory[histIndex].watchedAt = new Date();
        if (title) user.watchHistory[histIndex].title = title;
        if (posterPath) user.watchHistory[histIndex].posterPath = posterPath;
      } else {
        user.watchHistory.push({
          tmdbId: String(tmdbId),
          mediaType,
          season,
          episode,
          title,
          posterPath,
          watchedAt: new Date(),
        });
      }
      if (user.watchHistory.length > 100) {
        user.watchHistory.shift();
      }
    }

    // Keep only the 20 most recent continue watching
    user.continueWatching.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (user.continueWatching.length > 20) {
      user.continueWatching = user.continueWatching.slice(0, 20);
    }

    await user.save();
    res.json({ 
      success: true, 
      continueWatching: user.continueWatching,
      watchHistory: user.watchHistory 
    });
  } catch (error) {
    console.error('[User] Erreur updateProgress:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};

export const markAsWatched = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    const { tmdbId, mediaType, season, episode, title, posterPath } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
      return;
    }

    const planCode = user.subscription?.plan || 'free';
    const planDoc = await SubscriptionPlan.findOne({ code: planCode });
    if (!planDoc?.features?.hasWatchHistory) {
      res.status(403).json({ success: false, message: 'Votre abonnement ne permet pas l\'historique de lecture.' });
      return;
    }

    const histIndex = user.watchHistory.findIndex(
      (h) => h.tmdbId === String(tmdbId) && h.mediaType === mediaType && h.season === season && h.episode === episode
    );
    if (histIndex > -1) {
      user.watchHistory[histIndex].watchedAt = new Date();
      if (title) user.watchHistory[histIndex].title = title;
      if (posterPath) user.watchHistory[histIndex].posterPath = posterPath;
    } else {
      user.watchHistory.push({
        tmdbId: String(tmdbId),
        mediaType,
        season,
        episode,
        title,
        posterPath,
        watchedAt: new Date(),
      });
    }

    // Optional: cap history at 100
    if (user.watchHistory.length > 100) {
      user.watchHistory.shift();
    }

    await user.save();
    res.json({ success: true, watchHistory: user.watchHistory });
  } catch (error) {
    console.error('[User] Erreur markAsWatched:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};

export const updatePreferences = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    const { defaultQuality, defaultSubtitle } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
      return;
    }

    user.preferences = {
      defaultQuality: defaultQuality !== undefined ? defaultQuality : user.preferences?.defaultQuality,
      defaultSubtitle: defaultSubtitle !== undefined ? defaultSubtitle : user.preferences?.defaultSubtitle,
    };

    await user.save();
    res.json({ success: true, preferences: user.preferences });
  } catch (error) {
    console.error('[User] Erreur updatePreferences:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
