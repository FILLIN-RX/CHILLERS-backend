import { ProviderManager } from './provider-manager';
import { StreamQuery } from './providers/provider.interface';

const manager = new ProviderManager();

export const getMovieStream = async (query: StreamQuery) => {
  return manager.getMovieStream(query);
};

export const getEpisodeStream = async (query: StreamQuery) => {
  return manager.getEpisodeStream(query);
};

// Variantes "rapides" (endpoint secondaire /api/nexstream) : uniquement les
// providers locaux (base de données), sans les fournisseurs lents (doodstream,
// otaku, torrents). Utilisées par la course Phase 5 du lecteur.
export const getMovieStreamFast = async (query: StreamQuery) => {
  return manager.getMovieStream(query, { only: ['direct', 'mongodb'] });
};

export const getEpisodeStreamFast = async (query: StreamQuery) => {
  return manager.getEpisodeStream(query, { only: ['direct', 'mongodb'] });
};
