import axios from 'axios';
import { LiveSeedChannel } from './live.seed';

export interface IptvPlaylistEntry {
  name: string;
  logo?: string;
  url: string;
}

// Playlists filtées par pays de la base iptv-org (chaînes gratuites/publiques).
const COUNTRY_PLAYLIST = (country: string) =>
  `https://iptv-org.github.io/iptv/countries/${country.toLowerCase()}.m3u`;

// Playlists par langue : certains canaux internationaux sont absents des playlists par pays.
const LANGUAGE_PLAYLIST = (lang: string) =>
  `https://iptv-org.github.io/iptv/languages/${lang.toLowerCase()}.m3u`;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function parseM3u(text: string): IptvPlaylistEntry[] {
  const entries: IptvPlaylistEntry[] = [];
  let pending: { name?: string; logo?: string } = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      pending = {};
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      if (logoMatch) pending.logo = logoMatch[1];
      const name = line.replace(/^#EXTINF:[^,]*,/, '').trim();
      if (name) pending.name = name;
    } else if (line.startsWith('#')) {
      continue;
    } else if (pending.name && /^https?:\/\//i.test(line)) {
      entries.push({ name: pending.name, logo: pending.logo, url: line });
      pending = {};
    }
  }

  return entries;
}

export async function fetchIptvPlaylist(country: string): Promise<IptvPlaylistEntry[]> {
  return fetchIptvList(COUNTRY_PLAYLIST(country));
}

export async function fetchIptvLanguagePlaylist(lang: string): Promise<IptvPlaylistEntry[]> {
  return fetchIptvList(LANGUAGE_PLAYLIST(lang));
}

async function fetchIptvList(url: string): Promise<IptvPlaylistEntry[]> {
  try {
    const res = await axios.get<string>(url, { timeout: 30000 });
    return parseM3u(res.data);
  } catch (err) {
    throw new Error(`iptv-org: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Trouve l'entrée de playlist iptv-org correspondant à une chaîne du seed.
 */
export function findPlaylistMatch(
  entries: IptvPlaylistEntry[],
  seed: LiveSeedChannel
): IptvPlaylistEntry | undefined {
  const aliases = [seed.name, ...(seed.aliases || [])]
    .map(normalize)
    .filter(Boolean);

  const byExact = entries.find((e) => aliases.includes(normalize(e.name)));
  if (byExact) return byExact;

  const longAliases = aliases.filter((a) => a.length >= 8);
  return entries.find((e) => {
    const name = normalize(e.name);
    return longAliases.some((a) => name.includes(a));
  });
}
