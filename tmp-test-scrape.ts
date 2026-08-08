import axios from 'axios';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function decodePacker(html: string): string | null {
  const idx = html.indexOf('eval(function(p,a,c,k,e,d)');
  if (idx === -1) return null;
  let depth = 0, end = 0;
  const evalStr = html.substring(idx);
  for (let i = 0; i < evalStr.length; i++) {
    if (evalStr[i] === '(') depth++;
    if (evalStr[i] === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  try { const d = new Function('return ' + evalStr.substring(0, end).replace('eval(', '('))(); return typeof d === 'string' ? d : null; } catch { return null; }
}

async function check(url: string, label: string) {
  try {
    const r = await axios.head(url, { timeout: 8000, validateStatus: (s) => s >= 200 && s < 400, headers: { 'User-Agent': UA, Referer: 'https://uqload.is/' } });
    console.log(`${label}: HEAD ${r.status}  content-type: ${r.headers['content-type']?.slice(0,40)}`);
    return r.status;
  } catch {
    try {
      const r = await axios.get(url, { timeout: 8000, responseType: 'stream', validateStatus: (s) => s >= 200 && s < 400, headers: { 'User-Agent': UA, Referer: 'https://uqload.is/' } });
      console.log(`${label}: GET ${r.status}  content-type: ${r.headers['content-type']?.slice(0,40)}`);
      r.data.destroy();
      return r.status;
    } catch (e: any) { console.log(`${label}: FAIL ${e.response?.status}`); return e.response?.status; }
  }
}

async function main() {
  const code = process.argv[2] || '010qmys9mco1';
  const KEY = process.env.UQLOAD_API_KEY;

  // 1) Scrape PACKER → view_id
  const { data: html } = await axios.get(`https://uqload.is/embed-${code}.html`, { timeout: 15000, family: 4, headers: { 'User-Agent': UA, Referer: 'https://uqload.is/' } });
  const decoded = decodePacker(html);
  const hlsMatch = decoded?.match(/https:\/\/[^\s"']+\.m3u8[^\s"']*/);
  const viewId = /[?&]v=([^&]+)/.exec(hlsMatch?.[0] || '')?.[1];
  console.log('view_id:', viewId);

  // 2) API direct_link (MP4 mode) — récupère le lien /v/...mp4
  const { data: api } = await axios.get(`https://uqload.is/api/file/direct_link?key=${KEY}&file_code=${code}`, { timeout: 10000, family: 4 });
  const versions = api.result?.versions || [];
  console.log('API versions:', versions.map((v: any) => v.name).join(','));
  const best = versions.sort((a: any, b: any) => ({ o: 10, h: 8, n: 5, l: 2 }[b.name] || 0) - ({ o: 10, h: 8, n: 5, l: 2 }[a.name] || 0))[0];
  const mp4Url = best?.url;
  console.log('API MP4 url:', mp4Url?.slice(0, 150));

  await check(mp4Url, 'MP4 brut (API)');

  // 3) Injecter v=<view_id> (et éventuellement réécrire sp/i)
  if (mp4Url && viewId) {
    const injected = mp4Url.replace(/[?&]v=[^&]*/, `&v=${viewId}`);
    await check(injected, 'MP4 + v=viewId');
    const injected2 = injected.replace(/[?&]i=[^&]*/, '&i=0.0');
    await check(injected2, 'MP4 + v + i=0.0');
  }
}
main();
