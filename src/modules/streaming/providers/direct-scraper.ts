import axios from 'axios';
import https from 'https';
import querystring from 'querystring';

const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

export interface DirectStreamResult {
  directUrl: string;
  type: 'mp4' | 'hls' | 'unknown';
  referer: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TAG = '[DirectScraper]';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isFakeOrPromoUrl(url: string): boolean {
  return /\/(taunt|promo)\//i.test(url);
}

function isDirectVideoUrl(url: string): boolean {
  if (isFakeOrPromoUrl(url)) return false;
  return /\.(mp4|webm|m3u8|ts|m4s)(\?|$)/i.test(url);
}

function isVidzyUrl(url: string): boolean {
  return /(?:[a-z0-9]+\.)?vidzy\.(?:cc|org|xyz|co|tv|top|to|live|net|me|io|app|pro|site|online|stream|vip|fun|club|one|info)\//i.test(url);
}

/**
 * HEAD puis GET de secours : vérifie qu'une URL signée répond sans 403.
 * Le CDN Uqload renvoie un 403 sur les liens dont le token est incomplet
 * (hls_direct sans paramètre `v`) — on valide donc avant de les diffuser.
 */
async function isUrlReachable(url: string, referer: string): Promise<boolean> {
  try {
    await axios.head(url, {
      timeout: 8000,
      httpsAgent: ipv4Agent,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': UA, Referer: referer },
    });
    return true;
  } catch {
    try {
      const res = await axios.get(url, {
        timeout: 8000,
        httpsAgent: ipv4Agent,
        responseType: 'stream',
        validateStatus: (s) => s >= 200 && s < 400,
        headers: { 'User-Agent': UA, Referer: referer },
      });
      res.data.destroy();
      return true;
    } catch {
      return false;
    }
  }
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

const UQLOAD_TLDS = 'is|com|vc|ws|to|co|net|io';
const UQLOAD_DOMAINS = ['uqload.is', 'uqload.vc', 'uqload.ws', 'uqload.to', 'uqload.com'];

function extractUqloadCode(url: string): string | null {
  const m = url.match(new RegExp(`uqload\\.(?:${UQLOAD_TLDS})\\/embed-?([a-zA-Z0-9]+)`, 'i'));
  return m ? m[1] : null;
}

function isDoodstreamUrl(url: string): boolean {
  return /doodstream\.com|playmogo\.com|d000d\.com|d0000d\.com|dood\.(to|sh|so|cx|la|wf|pm)/i.test(url);
}

function isUqloadUrl(url: string): boolean {
  return new RegExp(`uqload\\.(${UQLOAD_TLDS})`, 'i').test(url);
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
    console.error(`${TAG} Doodstream: ERREUR code=${code}: ${err?.message || String(err)}`);
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

    // Page de secours Uqload : le fichier n'existe plus (expire/supprimé).
    if (/(file is no longer available|expired or has been deleted|has been deleted)/i.test(html)) {
      console.log(`${TAG} Uqload: ❌ fichier mort (${code}) — "File is no longer available"`);
      return null;
    }

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
    console.error(`${TAG} Uqload: ERREUR code=${code}: ${err?.message || String(err)}`);
    if (err.response) {
      console.error(`${TAG} Uqload: HTTP status=${err.response.status}, headers=`, JSON.stringify(err.response.headers).slice(0, 300));
    }
  }

  console.log(`${TAG} Uqload: → null (échec total)`);
  return null;
}

// ─── Uqload API ───────────────────────────────────────────────────────────────

// Lu à l'exécution (et pas au chargement du module) : sinon un import qui
// précède dotenv.config() fige une clé vide et l'API Uqload devient inutilisable.
function uqloadApiKey(): string {
  return process.env.UQLOAD_API_KEY || '';
}

interface UqloadDirectLinkResult {
  versions: { url: string; name: string; size: string }[];
  hls_direct?: string;
  file_length?: string;
}

/** Clone un fichier Uqload pour obtenir un nouveau filecode (CDN bypass) */
async function cloneFileCode(fileCode: string): Promise<string> {
  try {
    const url = `https://uqload.is/api/file/clone?key=${uqloadApiKey()}&file_code=${fileCode}`;
    console.log(`${TAG} Uqload clone: file_code=${fileCode}...`);
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data.status === 200 && data.result?.filecode) {
      console.log(`${TAG} Uqload clone: ✅ nouveau filecode=${data.result.filecode}`);
      return data.result.filecode;
    }
    console.log(`${TAG} Uqload clone: ⚠ échec, utilisation du code original`);
    return fileCode;
  } catch (err: any) {
    console.log(`${TAG} Uqload clone: ERREUR ${err?.message || String(err)}, utilisation du code original`);
    return fileCode;
  }
}

async function getUqloadDirectLink(fileCode: string, preferHls = false): Promise<DirectStreamResult | null> {
  const apiKey = uqloadApiKey();
  if (!apiKey) {
    console.log(`${TAG} Uqload API: pas de clé API configurée`);
    return null;
  }

  const tryTargetCode = async (targetCode: string): Promise<DirectStreamResult | null> => {
    try {
      const apiUrl = `https://uqload.is/api/file/direct_link?key=${apiKey}&file_code=${targetCode}${preferHls ? '&hls=1' : ''}`;
      console.log(`${TAG} Uqload API: GET ${apiUrl}${preferHls ? ' (HLS mode)' : ' (MP4 mode)'}`);
      // 10s : uqload.is redirige vers son domaine actuel, le premier aller-retour
      // coûte ~1,5s et dépassait régulièrement le budget de 6s.
      const { data } = await axios.get(apiUrl, { timeout: 10000 });
      console.log(`${TAG} Uqload API: status=${data.status}, msg=${data.msg}`);

      // Fichier supprimé/expiré côté Uqload : inutile de scraper la page embed.
      if (data?.status === 404 || /\bno file\b|not found|deleted/i.test(String(data?.msg || ''))) {
        console.log(`${TAG} Uqload API: ❌ fichier mort (${targetCode}) — msg=${data.msg}`);
        return null;
      }

      // Rejeter le piège Uqload : quand le compte API n'a pas de forfait Premium + Bandwidth,
      // Uqload renvoie status=200 mais avec une fausse vidéo promo (/taunt/promo/master.m3u8).
      if (/need premium|bandwidth plan/i.test(String(data?.msg || ''))) {
        console.log(`${TAG} Uqload API: ⚠ Forfait bandwidth requis (${data.msg}) — passage au scraping embed`);
        return null;
      }

      if (data.status !== 200 || !data.result) {
        console.log(`${TAG} Uqload API: échec pour ${targetCode}`);
        return null;
      }

      const result = data.result as UqloadDirectLinkResult;

      // Préférer HLS pour le streaming, MP4 pour le download
      if (preferHls && result.hls_direct) {
        if (isFakeOrPromoUrl(result.hls_direct)) {
          console.log(`${TAG} Uqload API: ⚠ hls_direct est une fausse vidéo promo/taunt (${result.hls_direct}), fallback embed`);
          return null;
        }
        if (await isUrlReachable(result.hls_direct, 'https://uqload.is/')) {
          console.log(`${TAG} Uqload API: ✅ HLS direct → ${result.hls_direct.slice(0, 120)}`);
          return {
            directUrl: result.hls_direct,
            type: 'hls',
            referer: 'https://uqload.is/',
          };
        }
        console.log(`${TAG} Uqload API: ⚠ hls_direct rejeté par le CDN (403), fallback clone/embed`);
        return null;
      }

      if (!preferHls) {
        const versions = result.versions || [];
        const qualityOrder: Record<string, number> = { o: 10, h: 8, n: 5, l: 2 };
        const sorted = [...versions].sort((a, b) => (qualityOrder[b.name] || 0) - (qualityOrder[a.name] || 0));
        if (sorted.length > 0) {
          const best = sorted[0];
          if (isFakeOrPromoUrl(best.url)) {
            console.log(`${TAG} Uqload API: ⚠ MP4 direct est une fausse vidéo promo/taunt (${best.url}), fallback embed`);
            return null;
          }
          console.log(`${TAG} Uqload API: ✅ MP4 direct (${best.name}) → ${best.url.slice(0, 120)}`);
          return {
            directUrl: best.url,
            type: 'mp4',
            referer: 'https://uqload.is/',
          };
        }
      }
    } catch (err: any) {
      console.log(`${TAG} Uqload API: ERREUR ${err?.message || String(err)}`);
    }
    return null;
  };

  // 1. Essai ultra-rapide avec le code original (< 300ms)
  const primaryResult = await tryTargetCode(fileCode);
  if (primaryResult) return primaryResult;

  // 2. Fallback clone uniquement si le code direct a échoué
  const clonedCode = await cloneFileCode(fileCode);
  if (clonedCode && clonedCode !== fileCode) {
    return await tryTargetCode(clonedCode);
  }

  return null;
}

// ─── Vidzy Scraper ────────────────────────────────────────────────────────────

async function scrapeVidzyEmbed(embedUrl: string): Promise<DirectStreamResult | null> {
  console.log(`${TAG} Vidzy: début résolution directe pour "${embedUrl.slice(0, 100)}"`);
  try {
    const dlPageUrl = embedUrl.replace('/embed-', '/d/').replace('.html', '_n.html');
    const { data: html } = await axios.get(dlPageUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://french-stream.net/',
      },
      timeout: 10000,
      httpsAgent: ipv4Agent,
    });

    const opMatch = html.match(/name="op" value="([^"]+)"/);
    const idMatch = html.match(/name="id" value="([^"]+)"/);
    const modeMatch = html.match(/name="mode" value="([^"]+)"/);
    const hashMatch = html.match(/name="hash" value="([^"]+)"/);

    if (hashMatch) {
      const form = {
        op: opMatch ? opMatch[1] : 'download_orig',
        id: idMatch ? idMatch[1] : '',
        mode: modeMatch ? modeMatch[1] : 'o',
        hash: hashMatch[1],
      };

      let origin = 'https://vidzy.cc';
      try {
        const u = new URL(embedUrl);
        origin = `${u.protocol}//${u.host}`;
      } catch {}

      const postData = querystring.stringify(form);
      const postRes = await axios.post(dlPageUrl, postData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': UA,
          'Referer': dlPageUrl,
          'Origin': origin,
        },
        timeout: 15000,
        httpsAgent: ipv4Agent,
      });

      const directLinks = postRes.data.match(/https?:\/\/[^"'\s\)]+\.(?:mp4|m3u8)[^"'\s\)]*/gi);
      if (directLinks && directLinks[0]) {
        console.log(`${TAG} Vidzy: ✅ MP4 direct trouvé → ${directLinks[0].slice(0, 120)}`);
        return {
          directUrl: directLinks[0],
          type: /\.(m3u8)/i.test(directLinks[0]) ? 'hls' : 'mp4',
          // Le CDN Vidzy vérifie le Referer de la page embed, pas de vidzy.cc/
          // Sans le bon referer, Vidzy sert une vidéo leurre de quelques secondes
          // avec le watermark "FSTREAM.TOP" au lieu du vrai contenu.
          referer: embedUrl,
        };
      }

      const aMatch = postRes.data.match(/href="([^"]+\.mp4[^"]*)"/i);
      if (aMatch && aMatch[1]) {
        console.log(`${TAG} Vidzy: ✅ MP4 direct trouvé via href → ${aMatch[1].slice(0, 120)}`);
        return {
          directUrl: aMatch[1],
          type: 'mp4',
          referer: embedUrl,
        };
      }
    }

    // Direct match dans la page embed initiale
    const embedDirect = html.match(/(?:file|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/i);
    if (embedDirect && isDirectVideoUrl(embedDirect[1])) {
      console.log(`${TAG} Vidzy: ✅ direct match trouvé → ${embedDirect[1].slice(0, 120)}`);
      return {
        directUrl: embedDirect[1],
        type: /\.(m3u8)/i.test(embedDirect[1]) ? 'hls' : 'mp4',
        referer: embedUrl,
      };
    }
  } catch (err: any) {
    console.warn(`${TAG} Vidzy: erreur résolution directe (${err?.message || String(err)})`);
  }
  return null;
}

// ─── Scraper générique (hôtes inconnus : VOE et ses clones /e/<code>) ────────
//
// DirectScraper ne connaissait que Doodstream/Uqload/Vidzy : tout le reste
// (VOE, `johnfullwonder.com/e/…`, miroirs du même gabarit) tombait en
// « URL non scrapable » et repartait en lecteur embed avec ses pubs. Ce
// scraper tente, sans connaissance préalable de l'hôte, d'extraire l'URL
// vidéo déclarée dans la page (HLS d'abord, MP4 ensuite).

function normalizeUrl(raw: string, base: string): string | null {
  try {
    if (raw.startsWith('//')) return `https:${raw}`;
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function findVideoInHtml(html: string, baseUrl: string): { url: string; type: 'hls' | 'mp4' } | null {
  // 1. HLS en clair (absolu ou protocole-relatif — les clones VOE utilisent `//`)
  const hls = html.match(/(?:https?:)?\/\/[^\s"'<>\\)]+?\.m3u8(?:\?[^\s"'<>\\)]*)?/i);
  if (hls?.[0]) {
    const url = normalizeUrl(hls[0], baseUrl);
    if (url && !isFakeOrPromoUrl(url)) return { url, type: 'hls' };
  }
  // 2. Patterns JS (file:, sources:, src:…)
  const js = html.match(
    /(?:file|fileSrc|videoSrc|sources|src)\s*[:=]\s*["']((?:https?:)?\/\/[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i
  );
  if (js?.[1]) {
    const url = normalizeUrl(js[1], baseUrl);
    if (url && !isFakeOrPromoUrl(url)) return { url, type: /\.m3u8/i.test(url) ? 'hls' : 'mp4' };
  }
  // 3. MP4 en clair
  const mp4 = html.match(/(?:https?:)?\/\/[^\s"'<>\\)]+?\.mp4(?:\?[^\s"'<>\\)]*)?/i);
  if (mp4?.[0]) {
    const url = normalizeUrl(mp4[0], baseUrl);
    if (url && !isFakeOrPromoUrl(url)) return { url, type: 'mp4' };
  }
  return null;
}

async function fetchEmbedHtml(embedUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  let origin = 'https://placeholder.invalid';
  try {
    origin = new URL(embedUrl).origin;
  } catch {}
  const res = await axios.get<string>(embedUrl, {
    timeout: 12_000,
    responseType: 'text',
    httpsAgent: ipv4Agent,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': UA,
      Referer: `${origin}/`,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
  });
  if (typeof res.data !== 'string' || res.data.length < 100) return null;
  const finalUrl = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl || embedUrl;
  return { html: res.data, finalUrl };
}

export async function scrapeGenericEmbed(embedUrl: string, depth = 0): Promise<DirectStreamResult | null> {
  console.log(`${TAG} Generic: résolution de "${embedUrl.slice(0, 100)}"`);
  try {
    const page = await fetchEmbedHtml(embedUrl);
    if (!page) {
      console.log(`${TAG} Generic: page vide ou injoignable`);
      return null;
    }

    let found = findVideoInHtml(page.html, page.finalUrl);

    if (!found) {
      const decoded = decodePacker(page.html);
      if (decoded) found = findVideoInHtml(decoded, page.finalUrl);
      if (found) console.log(`${TAG} Generic: URL trouvée dans le script P.A.C.K.E.R`);
    }

    // Certains lecteurs emboîtent le vrai host : un saut d'iframe maximum.
    if (!found && depth < 2) {
      const iframe = page.html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i)?.[1];
      if (iframe && !iframe.startsWith('about:blank')) {
        const next = normalizeUrl(iframe, page.finalUrl);
        if (next && next !== embedUrl) {
          console.log(`${TAG} Generic: saut d'iframe → ${next.slice(0, 100)}`);
          return scrapeGenericEmbed(next, depth + 1);
        }
      }
    }

    if (!found) {
      console.log(`${TAG} Generic: ❌ aucune URL vidéo déclarée dans la page`);
      return null;
    }

    const reachable = await isUrlReachable(found.url, page.finalUrl).catch(() => false);
    if (!reachable) {
      console.log(`${TAG} Generic: URL trouvée mais injoignable (403/404) → ${found.url.slice(0, 100)}`);
      return null;
    }
    console.log(`${TAG} Generic: ✅ ${found.type} → ${found.url.slice(0, 120)}`);
    return { directUrl: found.url, type: found.type, referer: page.finalUrl };
  } catch (err) {
    console.log(`${TAG} Generic: erreur ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
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
  if (isVidzyUrl(embedUrl)) {
    console.log(`${TAG} → détecté comme Vidzy`);
    return scrapeVidzyEmbed(embedUrl);
  }
  console.log(`${TAG} → hôte non reconnu, tentative générique (VOE, clones…)`);
  return scrapeGenericEmbed(embedUrl);
}

/**
 * Scrape directement la page embed Uqload à partir du fileCode,
 * **en bypassant l'API Uqload** (Strategy 0 de scrapeUqloadEmbed).
 *
 * Pourquoi : depuis le 5-6 août 2026, le CDN Uqload a durci son anti-leech.
 * L'API `direct_link?hls=1` renvoie un `hls_direct` dont le paramètre `v`
 * est vide ou expiré → 403 CDN. En revanche la page embed génère une URL HLS
 * signée via le JavaScript P.A.C.K.E.R. obfusqué (avec `v` rempli) → 200 OK.
 *
 * Retourne le lien HLS (master.m3u8) si trouvé, null sinon.
 */
export async function scrapeUqloadEmbedDirect(fileCode: string): Promise<DirectStreamResult | null> {
  let embedPageUrl = `https://${UQLOAD_DOMAINS[0]}/embed-${fileCode}.html`;
  console.log(`${TAG} scrapeUqloadEmbedDirect: code=${fileCode}`);

  try {
    const t0 = Date.now();
    let html = '';
    let status = 0;
    for (const domain of UQLOAD_DOMAINS) {
      const url = `https://${domain}/embed-${fileCode}.html`;
      try {
        const res = await axios.get(url, {
          timeout: 12000,
          httpsAgent: ipv4Agent,
          headers: { 'User-Agent': UA, Referer: `https://${domain}/` },
        });
        if (typeof res.data === 'string' && res.data.length > 200) {
          html = res.data;
          status = res.status;
          embedPageUrl = url;
          break;
        }
      } catch (e: any) {
        console.log(`${TAG} scrapeUqloadEmbedDirect: ${domain} KO (${e.message})`);
      }
    }
    if (!html) return null;
    console.log(`${TAG} scrapeUqloadEmbedDirect: page reçue en ${Date.now() - t0}ms (${embedPageUrl}, status=${status}, length=${html.length})`);

    // Priority 1: P.A.C.K.E.R. obfuscated JS — contient les URLs HLS signées
    console.log(`${TAG} scrapeUqloadEmbedDirect: S1 — décodage P.A.C.K.E.R...`);
    const decoded = decodePacker(html);
    if (decoded) {
      // Cherche d'abord les .m3u8 (HLS) dans le PACKER
      const hlsUrls = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi) || [];
      for (const raw of hlsUrls) {
        const urlMatch = raw.match(/(https?:\/\/[^\s"'<>]+)/i);
        if (urlMatch) {
          console.log(`${TAG} scrapeUqloadEmbedDirect: S1 ✅ HLS trouvé dans P.A.C.K.E.R. → ${urlMatch[1].slice(0, 150)}`);
          return { directUrl: urlMatch[1], type: 'hls', referer: embedPageUrl };
        }
      }
      // Fallback : MP4 dans le PACKER
      const mp4Urls = decoded.match(/(?:file|src)\s*[:=]\s*["']?(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/gi) || [];
      for (const raw of mp4Urls) {
        const urlMatch = raw.match(/(https?:\/\/[^\s"'<>]+)/i);
        if (urlMatch) {
          console.log(`${TAG} scrapeUqloadEmbedDirect: S1 MP4 trouvé dans P.A.C.K.E.R. → ${urlMatch[1].slice(0, 150)}`);
          return { directUrl: urlMatch[1], type: 'mp4', referer: embedPageUrl };
        }
      }
      console.log(`${TAG} scrapeUqloadEmbedDirect: S1 ❌ P.A.C.K.E.R. décodé mais pas d'URL HLS/MP4 vidéo`);
    } else {
      console.log(`${TAG} scrapeUqloadEmbedDirect: S1 ❌ pas de bloc P.A.C.K.E.R.`);
    }

    // Priority 2: .m3u8 directement dans le HTML brut
    console.log(`${TAG} scrapeUqloadEmbedDirect: S2 — recherche regex .m3u8 dans le HTML...`);
    const anyHls = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (anyHls) {
      console.log(`${TAG} scrapeUqloadEmbedDirect: S2 ✅ HLS trouvé → ${anyHls[1].slice(0, 150)}`);
      return { directUrl: anyHls[1], type: 'hls', referer: embedPageUrl };
    }
    console.log(`${TAG} scrapeUqloadEmbedDirect: S2 ❌ pas de .m3u8`);

    // Priority 3: balise <source> ou file: dans JS (MP4 fallback)
    console.log(`${TAG} scrapeUqloadEmbedDirect: S3 — balise <source> / file: ...`);
    const sourceMatch = html.match(/<source[^>]+src\s*=\s*["']([^"']+\.mp4[^"']*)/i)
      || html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i);
    if (sourceMatch) {
      console.log(`${TAG} scrapeUqloadEmbedDirect: S3 ✅ MP4 trouvé → ${sourceMatch[1].slice(0, 150)}`);
      return { directUrl: sourceMatch[1], type: 'mp4', referer: embedPageUrl };
    }
    console.log(`${TAG} scrapeUqloadEmbedDirect: S3 ❌ pas trouvé`);

    console.log(`${TAG} scrapeUqloadEmbedDirect: ⚠ Aucune strategie n'a fonctionné. HTML[0..500]:\n${html.slice(0, 500)}`);
  } catch (err: any) {
    console.error(`${TAG} scrapeUqloadEmbedDirect: ERREUR code=${fileCode}: ${err?.message || String(err)}`);
  }

  return null;
}

export function isScrapableUrl(url: string): boolean {
  return isDoodstreamUrl(url) || isUqloadUrl(url) || isVidzyUrl(url);
}

export const DirectScraper = {
  resolve: scrapeDirectStream,
  scrapeDirectStream,
  scrapeGenericEmbed,
  scrapeUqloadEmbedDirect,
  scrapeVidzyEmbed,
  isScrapableUrl,
  isDoodstreamUrl,
  isUqloadUrl,
  isVidzyUrl,
  extractCodeFromUrl,
  extractUqloadCode,
  getUqloadDirectLink,
  scrapeDoodstreamEmbed,
  scrapeUqloadEmbed,
};

export { isDoodstreamUrl, isUqloadUrl, isVidzyUrl, extractCodeFromUrl, extractUqloadCode, getUqloadDirectLink, scrapeVidzyEmbed };
