import { ProviderManager } from './provider-manager';
import { StreamQuery } from './providers/provider.interface';

const manager = new ProviderManager();

export const getMovieStream = async (query: StreamQuery) => {
  return manager.getMovieStream(query);
};

export const getEpisodeStream = async (query: StreamQuery) => {
  return manager.getEpisodeStream(query);
};
