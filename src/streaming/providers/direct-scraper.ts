import axios from 'axios';

export interface DirectStreamResult {
  directUrl: string;
  type: 'mp4' | 'hls' | 'unknown';
  referer: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TAG = '[DirectScraper]';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDirectVideoUrl(url: string): boolean {
  return /\.(mp4|webm|m3u8|ts|m4s)(\?|$)/i.test(url);
}

/** Decode P.A.C.K.E.R. obfuscated JavaScript (eval(function(p,a,c,k,e,d){...})) */
function decodePacker(html: string): string | null {
  const idx = html.indexOf('eval(function(p,a,c,k,e,d)');
  if (idx === -1) return null;

  let depth = 0, end = 0;
  const evalStr = html.substring(idx);
  for (let i = 0; i < evalStr.length; i++) {
    if (evalStr[i] === '(') depth++;
    if (evalStr[i] === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fullEval = evalStr.substring(0, end);

  try {
    const decoded = new Function('return ' + fullEval.replace('eval(', '('))();
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

function extractCodeFromUrl(url: string): string | null {
  const m = url.match(
    /(?:doodstream\.com|playmogo\.com|d000d\.com|d0000\.com|dood\.(?:to|sh|so|cx|la|wf|pm))\/(?:d|e)\/([a-zA-Z0-9]+)/i
  );
  return m ? m[1] : null;
}

function extractUqloadCode(url: string): string | null {
  const m = url.match(/uqload\.(?:is|com)\/embed-?([a-zA-Z0-9]+)/i);
  return m ? m[1] : null;
}

function isDoodstreamUrl(url: string): boolean {
  return /doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(to|sh|so|cx|la|wf|pm)/i.test(url);
}

function isUqloadUrl(url: string): boolean {
  return /uqload\.(is|com)/i.test(url);
}

// ─── Doodstream Scraper ───────────────────────────────────────────────────────

async function scrapeDoodstreamEmbed(embedUrl: string): Promise<DirectStreamResult | null> {
  const code = extractCodeFromUrl(embedUrl);
  if (!code) {
    console.log(`${TAG} Doodstream: impossible d'extraire le fileCode de "${embedUrl}"`);
    return null;
  }

  const embedPageUrl = `https://doodstream.com/e/${code}`;
  console.log(`${TAG} Doodstream: code=${code}, fetch de ${embedPageUrl}`);

  try {
    const t0 = Date.now();
    const { data: html, status } = await axios.get(embedPageUrl, {
      timeout: 15000,
      headers: { 'User-Agent': UA, Referer: embedPageUrl },
    });
    console.log(`${TAG} Doodstream: page reçue en ${Date.now() - t0}ms (status=${status}, length=${html.length})`);

    // Strategy 1: Look for direct video URLs in the page source
    console.log(`${TAG} Doodstream: S1 — recherche URL directe (.mp4/.m3u8) dans le HTML...`);
    const directMatch = html.match(
      /(?:"|')(https?:\/\/[^"'\s]+\.(?:mp4|webm|m3u8)[^"'\s]*)(?:"|')/i
    );
    if (directMatch && isDirectVideoUrl(directMatch[1])) {
      console.log(`${TAG} Doodstream: S1 ✅ trouvé → ${directMatch[1].slice(0, 120)}`);
      return {
        directUrl: directMatch[1],
        type: /\.(m3u8)/i.test(directMatch[1]) ? 'hls' : 'mp4',
        referer: embedPageUrl,
      };
    }
    console.log(`${TAG} Doodstream: S1 ❌ pas trouvé`);

    // Strategy 2: Find the pass_md5.php token flow
    console.log(`${TAG} Doodstream: S2 — recherche token/expiry pour pass_md5.php...`);
    const tokenMatch = html.match(/(?:var\s+)?_token\s*=\s*["']([^"']+)["']/);
    const expiryMatch = html.match(/(?:var\s+)?expiry\s*=\s*["']([^"']+)["']/);

    if (tokenMatch && expiryMatch) {
      const passUrl = `https://doodstream.com/pass_md5.php?token=${encodeURIComponent(tokenMatch[1])}&expiry=${encodeURIComponent(expiryMatch[1])}`;
      console.log(`${TAG} Doodstream: S2 token=${tokenMatch[1].slice(0, 30)}... expiry=${expiryMatch[1]}`);
      console.log(`${TAG} Doodstream: S2 GET ${passUrl.slice(0, 120)}...`);

      const t1 = Date.now();
      const { data: passResponse, status: passStatus } = await axios.get(passUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': UA,
          Referer: embedPageUrl,
        },
      });
      console.log(`${TAG} Doodstream: S2 réponse en ${Date.now() - t1}ms (status=${passStatus})`);
      console.log(`${TAG} Doodstream: S2 body (${typeof passResponse}, len=${String(passResponse).length}): "${String(passResponse).slice(0, 200)}"`);

      if (passResponse && typeof passResponse === 'string' && passResponse.startsWith('http')) {
        const videoUrl = passResponse.trim();
        console.log(`${TAG} Doodstream: S2 ✅ URL directe → ${videoUrl.slice(0, 150)}`);
        return {
          directUrl: videoUrl,
          type: isDirectVideoUrl(videoUrl) ? (/\.(m3u8)/i.test(videoUrl) ? 'hls' : 'mp4') : 'mp4',
          referer: embedPageUrl,
        };
      }
      console.log(`${TAG} Doodstream: S2 ❌ réponse pass_md5 non HTTP ou vide`);
    } else {
      console.log(`${TAG} Doodstream: S2 ❌ token="${!!tokenMatch}" expiry="${!!expiryMatch}" — pas de pattern trouvé`);
    }

    // Strategy 3: Look for eval'd / base64 encoded sources
    console.log(`${TAG} Doodstream: S3 — recherche base64/atob...`);
    const b64Match = html.match(/(?:atob|decodeURIComponent)\s*\(\s*["']([A-Za-z0-9+/=%]+)["']/);
    if (b64Match) {
      try {
        const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
        console.log(`${TAG} Doodstream: S3 base64 décodé (${decoded.length} chars): "${decoded.slice(0, 200)}"`);
        const urlInDecoded = decoded.match(/(https?:\/\/[^\s"']+\.(?:mp4|m3u8)[^\s"']*)/i);
        if (urlInDecoded) {
          console.log(`${TAG} Doodstream: S3 ✅ trouvé dans base64 → ${urlInDecoded[1].slice(0, 150)}`);
          return {
            directUrl: urlInDecoded[1],
            type: /\.(m3u8)/i.test(urlInDecoded[1]) ? 'hls' : 'mp4',
            referer: embedPageUrl,
          };
        }
        console.log(`${TAG} Doodstream: S3 ❌ base64 décodé mais pas d'URL vidéo dedans`);
      } catch (e) {
        console.log(`${TAG} Doodstream: S3 ❌ échec décodage base64`);
      }
    } else {
      console.log(`${TAG} Doodstream: S3 ❌ pas de pattern base64/atob trouvé`);
    }

    // Strategy 4: Look for common patterns in inline scripts
    console.log(`${TAG} Doodstream: S4 — recherche patterns JS (sources/file/src/videoSrc)...`);
    const scriptPatterns = [
      { name: 'sources[]', re: /sources\s*:\s*\[\s*\{[^}]*src\s*:\s*["']([^"']+)["']/i },
      { name: 'file:', re: /file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/i },
      { name: 'src=:', re: /src\s*[=:]\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/i },
      { name: 'videoSrc:', re: /videoSrc\s*[=:]\s*["'](https?:\/\/[^"']+)/i },
    ];
    for (const { name, re } of scriptPatterns) {
      const m = html.match(re);
      if (m && isDirectVideoUrl(m[1])) {
        console.log(`${TAG} Doodstream: S4 ✅ pattern "${name}" → ${m[1].slice(0, 150)}`);
        return {
          directUrl: m[1],
          type: /\.(m3u8)/i.test(m[1]) ? 'hls' : 'mp4',
          referer: embedPageUrl,
        };
      }
      console.log(`${TAG} Doodstream: S4 ❌ pattern "${name}" non matché`);
    }

    // Debug: dump first 500 chars of HTML for manual inspection
    console.log(`${TAG} Doodstream: ⚠ Aucune strategie n'a fonctionné. HTML[0..500]:\n${html.slice(0, 500)}`);

  } catch (err: any) {
    console.error(`${TAG} Doodstream: ERREUR code=${code}: ${err.message}`);
    if (err.response) {
      console.error(`${TAG} Doodstream: HTTP status=${err.response.status}, headers=`, JSON.stringify(err.response.headers).slice(0, 300));
    }
  }

  console.log(`${TAG} Doodstream: → null (échec total)`);
  return null;
}

// ─── Uqload Scraper ───────────────────────────────────────────────────────────

async function scrapeUqloadEmbed(embedUrl: string, preferHls = false): Promise<DirectStreamResult | null> {
  const code = extractUqloadCode(embedUrl);
  if (!code) {
    console.log(`${TAG} Uqload: impossible d'extraire le fileCode de "${embedUrl}"`);
    return null;
  }

  // Strategy 0: Uqload API (fresh direct link, no scraping needed)
  console.log(`${TAG} Uqload: S0 — tentative API direct_link pour code=${code}...`);
  const apiResult = await getUqloadDirectLink(code, preferHls);
  if (apiResult) {
    console.log(`${TAG} Uqload: S0 ✅ lien frais via API → ${apiResult.directUrl.slice(0, 120)}`);
    return apiResult;
  }
  console.log(`${TAG} Uqload: S0 ❌ API indisponible, fallback scraping`);

  const embedPageUrl = `https://uqload.is/embed-${code}.html`;
  console.log(`${TAG} Uqload: code=${code}, fetch de ${embedPageUrl}`);

  try {
    const t0 = Date.now();
    const { data: html, status } = await axios.get(embedPageUrl, {
      timeout: 15000,
      headers: { 'User-Agent': UA, Referer: 'https://uqload.is/' },
    });
    console.log(`${TAG} Uqload: page reçue en ${Date.now() - t0}ms (status=${status}, length=${html.length})`);

    // Strategy 1: Direct source in <source> or <video> tag
    console.log(`${TAG} Uqload: S1 — recherche balise <source>/<video>...`);
    const sourceMatch = html.match(/<source[^>]+src\s*=\s*["']([^"']+)["']/i)
      || html.match(/<video[^>]+src\s*=\s*["']([^"']+)["']/i);
    if (sourceMatch && isDirectVideoUrl(sourceMatch[1])) {
      console.log(`${TAG} Uqload: S1 ✅ trouvé → ${sourceMatch[1].slice(0, 150)}`);
      return {
        directUrl: sourceMatch[1],
        type: /\.(m3u8)/i.test(sourceMatch[1]) ? 'hls' : 'mp4',
        referer: embedPageUrl,
      };
    }
    console.log(`${TAG} Uqload: S1 ❌ pas trouvé`);

    // Strategy 2: Sources array in JS
    console.log(`${TAG} Uqload: S2 — recherche sources[] dans JS...`);
    const sourcesMatch = html.match(/sources\s*:\s*\[\s*\{[^}]*src\s*:\s*["']([^"']+)["']/i);
    if (sourcesMatch && isDirectVideoUrl(sourcesMatch[1])) {
      console.log(`${TAG} Uqload: S2 ✅ trouvé → ${sourcesMatch[1].slice(0, 150)}`);
      return {
        directUrl: sourcesMatch[1],
        type: /\.(m3u8)/i.test(sourcesMatch[1]) ? 'hls' : 'mp4',
        referer: embedPageUrl,
      };
    }
    console.log(`${TAG} Uqload: S2 ❌ pas trouvé`);

    // Strategy 2b: Decode P.A.C.K.E.R. obfuscated JS (eval(function(p,a,c,k,e,d){...}))
    console.log(`${TAG} Uqload: S2b — décodage P.A.C.K.E.R...`);
    const decoded = decodePacker(html);
    if (decoded) {
      const packedUrls = decoded.match(/(?:file|src)\s*[:=]\s*["']?(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/gi) || [];
      for (const match of packedUrls) {
        const urlMatch = match.match(/(https?:\/\/[^\s"'<>]+)/i);
        if (urlMatch && isDirectVideoUrl(urlMatch[1])) {
          console.log(`${TAG} Uqload: S2b ✅ trouvé dans P.A.C.K.E.R. → ${urlMatch[1].slice(0, 150)}`);
          return {
            directUrl: urlMatch[1],
            type: /\.(m3u8)/i.test(urlMatch[1]) ? 'hls' : 'mp4',
            referer: embedPageUrl,
          };
        }
      }
      console.log(`${TAG} Uqload: S2b ❌ P.A.C.K.E.R. décodé mais pas d'URL vidéo`);
    } else {
      console.log(`${TAG} Uqload: S2b ❌ pas de bloc P.A.C.K.E.R.`);
    }

    // Strategy 3: file property in JS config
    console.log(`${TAG} Uqload: S3 — recherche file: dans JS...`);
    const fileMatch = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/i);
    if (fileMatch) {
      console.log(`${TAG} Uqload: S3 ✅ trouvé → ${fileMatch[1].slice(0, 150)}`);
      return {
        directUrl: fileMatch[1],
        type: /\.(m3u8)/i.test(fileMatch[1]) ? 'hls' : 'mp4',
        referer: embedPageUrl,
      };
    }
    console.log(`${TAG} Uqload: S3 ❌ pas trouvé`);

    // Strategy 4: Any direct video URL in page
    console.log(`${TAG} Uqload: S4 — recherche regex globale (.mp4/.m3u8)...`);
    const anyVideo = html.match(/(https?:\/\/[^\s"']+\.(?:mp4|m3u8)[^\s"']*)/i);
    if (anyVideo) {
      console.log(`${TAG} Uqload: S4 ✅ trouvé → ${anyVideo[1].slice(0, 150)}`);
      return {
        directUrl: anyVideo[1],
        type: /\.(m3u8)/i.test(anyVideo[1]) ? 'hls' : 'mp4',
        referer: embedPageUrl,
      };
    }
    console.log(`${TAG} Uqload: S4 ❌ pas trouvé`);

    // Debug: dump first 500 chars
    console.log(`${TAG} Uqload: ⚠ Aucune strategie n'a fonctionné. HTML[0..500]:\n${html.slice(0, 500)}`);

  } catch (err: any) {
    console.error(`${TAG} Uqload: ERREUR code=${code}: ${err.message}`);
    if (err.response) {
      console.error(`${TAG} Uqload: HTTP status=${err.response.status}, headers=`, JSON.stringify(err.response.headers).slice(0, 300));
    }
  }

  console.log(`${TAG} Uqload: → null (échec total)`);
  return null;
}

// ─── Uqload API ───────────────────────────────────────────────────────────────

const UQLOAD_API_KEY = process.env.UQLOAD_API_KEY || '';

interface UqloadDirectLinkResult {
  versions: { url: string; name: string; size: string }[];
  hls_direct?: string;
  file_length?: string;
}

/** Clone un fichier Uqload pour obtenir un nouveau filecode (CDN bypass) */
async function cloneFileCode(fileCode: string): Promise<string> {
  try {
    const url = `https://uqload.is/api/file/clone?key=${UQLOAD_API_KEY}&file_code=${fileCode}`;
    console.log(`${TAG} Uqload clone: file_code=${fileCode}...`);
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data.status === 200 && data.result?.filecode) {
      console.log(`${TAG} Uqload clone: ✅ nouveau filecode=${data.result.filecode}`);
      return data.result.filecode;
    }
    console.log(`${TAG} Uqload clone: ⚠ échec, utilisation du code original`);
    return fileCode;
  } catch (err: any) {
    console.log(`${TAG} Uqload clone: ERREUR ${err.message}, utilisation du code original`);
    return fileCode;
  }
}

async function getUqloadDirectLink(fileCode: string, preferHls = false): Promise<DirectStreamResult | null> {
  if (!UQLOAD_API_KEY) {
    console.log(`${TAG} Uqload API: pas de clé API configurée`);
    return null;
  }

  // Pour le download : cloner d'abord pour obtenir un nouveau filecode (CDN bypass)
  const targetCode = preferHls ? fileCode : await cloneFileCode(fileCode);

  try {
    const apiUrl = `https://uqload.is/api/file/direct_link?key=${UQLOAD_API_KEY}&file_code=${targetCode}${preferHls ? '&hls=1' : ''}`;
    console.log(`${TAG} Uqload API: GET ${apiUrl}${preferHls ? ' (HLS mode)' : ' (MP4 mode)'}`);
    const { data } = await axios.get(apiUrl, { timeout: 10000 });
    console.log(`${TAG} Uqload API: status=${data.status}, msg=${data.msg}`);

    if (data.status !== 200 || !data.result) {
      console.log(`${TAG} Uqload API: échec`);
      return null;
    }

    const result = data.result as UqloadDirectLinkResult;

    // Préférer HLS pour le streaming, MP4 pour le download
    if (preferHls && result.hls_direct) {
      console.log(`${TAG} Uqload API: ✅ HLS direct → ${result.hls_direct.slice(0, 120)}`);
      return {
        directUrl: result.hls_direct,
        type: 'hls',
        referer: 'https://uqload.is/',
      };
    }

    // Fallback to highest quality .mp4 (ou seul .mp4 si download)
    const versions = result.versions || [];
    const qualityOrder: Record<string, number> = { n: 4, h: 3, l: 2, o: 1 };
    const sorted = [...versions].sort((a, b) => (qualityOrder[a.name] || 0) - (qualityOrder[b.name] || 0));
    if (sorted.length > 0) {
      const best = sorted[0];
      console.log(`${TAG} Uqload API: ✅ MP4 direct (${best.name}) → ${best.url.slice(0, 120)}`);
      return {
        directUrl: best.url,
        type: 'mp4',
        referer: 'https://uqload.is/',
      };
    }

    // HLS uniquement si pas de MP4 mais HLS disponible (download path)
    if (!preferHls && result.hls_direct) {
      console.log(`${TAG} Uqload API: ✅ HLS direct (fallback, pas de MP4) → ${result.hls_direct.slice(0, 120)}`);
      return {
        directUrl: result.hls_direct,
        type: 'hls',
        referer: 'https://uqload.is/',
      };
    }

    console.log(`${TAG} Uqload API: ❌ aucune version disponible`);
    return null;
  } catch (err: any) {
    console.log(`${TAG} Uqload API: ERREUR ${err.message}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scrapeDirectStream(embedUrl: string, preferHls = false): Promise<DirectStreamResult | null> {
  console.log(`${TAG} scrapeDirectStream("${embedUrl.slice(0, 100)}")`);

  if (isDoodstreamUrl(embedUrl)) {
    console.log(`${TAG} → détecté comme Doodstream`);
    return scrapeDoodstreamEmbed(embedUrl);
  }
  if (isUqloadUrl(embedUrl)) {
    console.log(`${TAG} → détecté comme Uqload`);
    return scrapeUqloadEmbed(embedUrl, preferHls);
  }
  console.log(`${TAG} → URL non scrapable (ni Doodstream ni Uqload)`);
  return null;
}

export function isScrapableUrl(url: string): boolean {
  return isDoodstreamUrl(url) || isUqloadUrl(url);
}

export { isDoodstreamUrl, isUqloadUrl, extractCodeFromUrl, extractUqloadCode, getUqloadDirectLink };
