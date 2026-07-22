import axios from 'axios';
import dns from 'dns';

const tmdbClient = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  timeout: 10000,
  headers: {
    Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI1ODY4ZjBmM2NmZTg1MTZmYmQ1NmE2YjNiNzJmOGYwZiIsIm5iZiI6MTc4Mzk0MDMzNi42ODMsInN1YiI6IjZhNTRjNGYwY2M4ZTIzNDZhNWI1MmUxYiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.33Zn39ASeHdHwv7jxe5-qaPhi-5uSvGqfAOPCSW8ddM',
    'Content-Type': 'application/json',
  },
  // @ts-ignore
  lookup: (hostname: string, options: any, cb: (err: Error | null, address: any, family?: number) => void) => {
    dns.lookup(hostname, { ...options, family: 4 }, cb);
  },
});

interface CacheEntry {
  data: any;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_DURATION = 5 * 60 * 1000;

const originalGet = tmdbClient.get;

// @ts-ignore
tmdbClient.get = async function (url: string, config?: any) {
  const cacheKey = JSON.stringify({ url, params: config?.params });
  const cached = cache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiry > now) {
    return { data: cached.data };
  }

  const response = await originalGet.call(this, url, config) as any;
  cache.set(cacheKey, {
    data: response.data,
    expiry: Date.now() + CACHE_DURATION,
  });

  return response;
};

export function clearCache() {
  cache.clear();
}

export default tmdbClient;
