import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { ProviderManager } from '../../streaming/provider-manager';

async function main() {
  const manager = new ProviderManager();

  // Exact query from the streaming controller
  const query = {
    tmdbId: 90573,
    type: 'tv' as const,
    title: 'The Chi',
    season: 8,
    episode: 1,
  };

  console.log('Query:', JSON.stringify(query, null, 2));
  const result = await manager.getEpisodeStream(query);

  if (result) {
    console.log('Result:', JSON.stringify(result, null, 2));
  } else {
    console.log('No result from any provider');
  }
}

main().catch(err => console.error('[FATAL]', err));
