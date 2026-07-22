import tmdbClient from './tmdb.js';

async function fetchMedia() {
  try {
    // Fetch 2 series
    const { data: tvData } = await tmdbClient.get('/tv/popular', { params: { page: 1 } });
    const series = tvData.results.slice(0, 2).map((item: any) => ({ ...item, media_type: 'tv' }));

    // Fetch 3 movies
    const { data: movieData } = await tmdbClient.get('/movie/popular', { params: { page: 1 } });
    const movies = movieData.results.slice(0, 3).map((item: any) => ({ ...item, media_type: 'movie' }));

    console.log(JSON.stringify([...series, ...movies], null, 2));
  } catch (error) {
    console.error('Error fetching media:', error);
  }
}

fetchMedia();
