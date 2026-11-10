/**
 * direct-enricher.ts — logique partagée « embed → URL directe (HLS / MP4) ».
 *
 * Réutilisée par :
 *  - ProviderManager : enrichit les résultats embed-only (MongoDBProvider,
 *    DoodStreamProvider, …) pour renvoyer directUrl/directType/referer sans
 *    changer l'ordre des providers (MongoDB reste prioritaire).
 *  - DirectProvider  : chaîne de fallback quand MongoDB n'a rien.
 *
 * Enrichissement « best effort » : `resolveDirectFromEmbed` ne lève jamais
 * d'exception et distingue un embed qu'on ne peut pas scraper ('unsupported',
 * à conserver tel quel) d'un embed scrapable dont rien de jouable n'a été
 * trouvé ('failed', à traiter comme un pis-aller par ProviderManager).
 */
import { DirectScraper, isScrapableUrl } from './direct-scraper';

const TAG = '[DirectEnricher]';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface EnrichedDirect {
  /** URL directe brute (.m3u8 / .mp4) — jouée par le <video> / hls.js. */
  directUrl: string;
  directType: 'mp4' | 'hls';
  /** Referer attendu par le CDN (à transmettre au proxy HLS côté client). */
  referer?: string;
}

/**
 * Issue d'une tentative d'enrichissement :
 *  - 'ok'           → URL directe obtenue (directUrl/dispo).
 *  - 'unsupported'  → hôte non scrapable (YouTube, VOE, lien direct déjà
 *                     résolu) : l'embed reste le meilleur résultat possible.
 *  - 'failed'       → hôte scrapable mais rien de jouable (fichier mort,
 *                     timeout, anti-bot) : l'embed est à traiter comme un
 *                     pis-aller, pas comme une réussite.
 */
export type EnrichOutcome =
  | ({ status: 'ok' } & EnrichedDirect)
  | { status: 'unsupported' }
  | { status: 'failed' };


function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function isDirectMediaUrl(url: string): boolean {
  if (/\/(taunt|promo)\//i.test(url)) return false;
  return /\.(mp4|webm|m3u8|ts|m4s)(\?|$)/i.test(url);
}

function directTypeOf(url: string): 'mp4' | 'hls' {
  return /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4';
}

/**
 * Retourne le Referer CDN attendu pour une URL directe connue.
 * Les CDN Vidzy/Uqload refusent ou servent une vidéo leurre sans ce header.
 */
function refererForDirectUrl(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    if (/vidzy\./i.test(host)) return 'https://vidzy.cc/';
    if (/uqload\./i.test(host)) return 'https://uqload.is/';
    if (/dood\.|playmogo\.|d000\./i.test(host)) return 'https://doodstream.com/';
    if (/streamtape\./i.test(host)) return 'https://streamtape.com/';
    if (/voe\./i.test(host)) return 'https://voe.sx/';
    if (/luluv/i.test(host)) return 'https://luluvdo.com/';
  } catch {}
  return undefined;
}

/**
 * Extrait l'URL directe d'un embed (Doodstream / Uqload / Vidzy).
 *
 * @param embedUrl  URL embed (iframe) ou URL directe déjà résolue.
 * @param opts.preferHls  Privilégie le HLS (Uqload API / P.A.C.K.E.R.).
 * @param opts.timeoutMs  Budget total du scrape (défaut 15s).
 */
export async function resolveDirectFromEmbed(
  embedUrl: string | null | undefined,
  opts: { preferHls?: boolean; timeoutMs?: number } = {},
): Promise<EnrichOutcome> {
  if (!embedUrl) return { status: 'unsupported' };

  // Déjà une URL directe → on se contente de typer + ajouter le referer CDN si connu.
  if (isDirectMediaUrl(embedUrl)) {
    return {
      status: 'ok',
      directUrl: embedUrl,
      directType: directTypeOf(embedUrl),
      referer: refererForDirectUrl(embedUrl),
    };
  }

  // Hôte qu'on ne sait pas scraper → l'embed est le meilleur résultat dispo.
  if (!isScrapableUrl(embedUrl)) return { status: 'unsupported' };

  const t0 = Date.now();
  const scraped = await withTimeout(
    DirectScraper.scrapeDirectStream(embedUrl, opts.preferHls ?? true),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!scraped?.directUrl) {
    console.log(`${TAG} échec (${Date.now() - t0}ms) pour ${embedUrl.slice(0, 100)}`);
    return { status: 'failed' };
  }

  const directType = directTypeOf(scraped.directUrl);
  console.log(`${TAG} ✅ ${directType} en ${Date.now() - t0}ms → ${scraped.directUrl.slice(0, 140)}`);

  return {
    status: 'ok',
    directUrl: scraped.directUrl,
    directType,
    referer: scraped.referer,
  };
}
