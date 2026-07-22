import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { DoodStreamProvider } from '../../streaming/providers/doodstream.provider';

async function main() {
  const provider = new DoodStreamProvider();

  // Test 1: The Chi, season 8, episode 1
  console.log('=== Test getEpisodeStream: The Chi S08E01 ===');
  const result = await provider.getEpisodeStream({
    tmdbId: 90573,
    season: 8,
    episode: 1,
    title: 'The Chi',
    type: 'tv',
  });
  console.log('Result:', JSON.stringify(result, null, 2));

  // Test 2: X-Men '97, season 2, episode 1
  console.log('\n=== Test getEpisodeStream: X-Men 97 S02E01 ===');
  const result2 = await provider.getEpisodeStream({
    tmdbId: 138502,
    season: 2,
    episode: 1,
    title: "X-Men '97",
    type: 'tv',
  });
  console.log('Result:', JSON.stringify(result2, null, 2));

  // Test 3: Download URL
  console.log('\n=== Test getDownloadUrl: The Chi ===');
  const dl = await provider.getDownloadUrl('The Chi', 90573);
  console.log('Download URL:', dl);
}

main().catch(err => console.error('[FATAL]', err));
