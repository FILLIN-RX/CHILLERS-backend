import axios from 'axios';
import querystring from 'querystring';
import Movie from '../../models/Movie';

const BASE_URL = 'https://french-stream.one';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FrenchStreamSearchResult {
  title: string;
  url: string;
  poster: string;
}

export interface FrenchStreamVersion {
  label: string; // TRUEFRENCH, FRENCH, VOSTFR
  embedUrl: string;
}

export interface FrenchStreamDirectResult {
  title: string;
  quality: string;
  fileSize: string;
  streamUrl: string;
  embedUrl?: string;
  source: 'frenchstream';
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

/**
 * Recherche un film sur French-Stream via l'endpoint AJAX interne
 */
export async function searchFrenchStream(query: string): Promise<FrenchStreamSearchResult[]> {
  try {
    const postData = querystring.stringify({ query });
    const { data } = await axios.post(
      `${BASE_URL}/engine/ajax/controller.php?mod=search`,
      postData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/`
        },
        timeout: 10000
      }
    );

    if (!data || typeof data !== 'string') return [];

    const items: FrenchStreamSearchResult[] = [];
    const regex = /location\.href='([^']+)'[\s\S]*?<img src='([^']*)'[\s\S]*?<div class='search-title'>([\s\S]*?)<\/div>/gi;
    let match;

    while ((match = regex.exec(data)) !== null) {
      const relUrl = match[1];
      const poster = match[2];
      const title = match[3].replace(/\\'/g, "'").replace(/&amp;/g, '&').trim();
      items.push({
        url: relUrl.startsWith('http') ? relUrl : `${BASE_URL}${relUrl}`,
        poster,
        title
      });
    }

    return items;
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur recherche "${query}":`, error.message);
    return [];
  }
}

/**
 * Extrait les liens de lecteurs Vidzy (TRUEFRENCH, FRENCH, VOSTFR) depuis la page du film
 */
export async function extractEmbedVersions(pageUrl: string): Promise<{ title: string; versions: FrenchStreamVersion[] }> {
  try {
    const { data: html } = await axios.get(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${BASE_URL}/`
      },
      timeout: 15000
    });

    const titleMatch = html.match(/<h1[^>]*id="s-title"[^>]*>([\s\S]*?)<\/h1>/i);
    const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const versions: FrenchStreamVersion[] = [];
    const optionRegex = /<div class="option" data-url="([^"]+)"><span>([\s\S]*?)<\/span><\/div>/gi;
    let match;

    while ((match = optionRegex.exec(html)) !== null) {
      const embedUrl = match[1];
      const label = match[2].replace(/Télécharger en /i, '').trim();
      versions.push({ label, embedUrl });
    }

    return { title: rawTitle, versions };
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur extraction ${pageUrl}:`, error.message);
    return { title: '', versions: [] };
  }
}

/**
 * Résout le lien direct MP4 1080p (Full HD) à partir de l'embed Vidzy
 */
export async function resolveVidzyDirectStream(embedUrl: string): Promise<{ streamUrl: string; fileSize: string } | null> {
  try {
    const dlPageUrl = embedUrl.replace('/embed-', '/d/').replace('.html', '_n.html');
    const { data: html } = await axios.get(dlPageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${BASE_URL}/`
      },
      timeout: 15000
    });

    const titleMatch = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const fileSize = titleMatch ? titleMatch[1].trim() : '1080p Full HD';

    const opMatch = html.match(/name="op" value="([^"]+)"/);
    const idMatch = html.match(/name="id" value="([^"]+)"/);
    const modeMatch = html.match(/name="mode" value="([^"]+)"/);
    const hashMatch = html.match(/name="hash" value="([^"]+)"/);

    if (!hashMatch) return null;

    const form = {
      op: opMatch ? opMatch[1] : 'download_orig',
      id: idMatch ? idMatch[1] : '',
      mode: modeMatch ? modeMatch[1] : 'o',
      hash: hashMatch[1]
    };

    const postData = querystring.stringify(form);
    const postRes = await axios.post(dlPageUrl, postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': USER_AGENT,
        'Referer': dlPageUrl,
        'Origin': 'https://vidzy.cc'
      },
      timeout: 15000
    });

    const directLinks = postRes.data.match(/https?:\/\/[^"'\s\)]+\.mp4[^"'\s\)]*/gi);
    if (directLinks && directLinks[0]) {
      return {
        streamUrl: directLinks[0],
        fileSize
      };
    }

    return null;
  } catch (error: any) {
    console.error(`[FrenchStream] Erreur résolution Vidzy ${embedUrl}:`, error.message);
    return null;
  }
}

/**
 * Recherche et résout directement un film en Haute Résolution (1080p)
 */
export async function getFrenchStreamMovie(title: string): Promise<FrenchStreamDirectResult | null> {
  try {
    console.log(`[FrenchStream HQ] Recherche film 1080p: "${title}"`);
    const searchResults = await searchFrenchStream(title);
    if (searchResults.length === 0) return null;

    // Trouver la meilleure correspondance de titre
    let best = searchResults[0];
    const searchNorm = normalize(title);

    for (const item of searchResults) {
      const itemNorm = normalize(item.title);
      if (itemNorm === searchNorm || itemNorm.includes(searchNorm)) {
        best = item;
        break;
      }
    }

    console.log(`[FrenchStream HQ] Page trouvée: ${best.url} (${best.title})`);
    const { title: resolvedTitle, versions } = await extractEmbedVersions(best.url);
    if (versions.length === 0) return null;

    // Priorité aux versions : TRUEFRENCH > FRENCH > VOSTFR
    const chosenVersion =
      versions.find(v => v.label.toUpperCase().includes('TRUEFRENCH')) ||
      versions.find(v => v.label.toUpperCase().includes('FRENCH')) ||
      versions[0];

    console.log(`[FrenchStream HQ] Version sélectionnée: ${chosenVersion.label} (${chosenVersion.embedUrl})`);
    const directResult = await resolveVidzyDirectStream(chosenVersion.embedUrl);

    if (directResult?.streamUrl) {
      return {
        title: resolvedTitle || best.title,
        quality: '1080p',
        fileSize: directResult.fileSize,
        streamUrl: directResult.streamUrl,
        embedUrl: chosenVersion.embedUrl,
        source: 'frenchstream'
      };
    }

    return null;
  } catch (error: any) {
    console.error(`[FrenchStream HQ] Erreur globale pour "${title}":`, error.message);
    return null;
  }
}
