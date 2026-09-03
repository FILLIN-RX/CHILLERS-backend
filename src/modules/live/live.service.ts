// @ts-nocheck
import axios_1 from "axios";
import * as live_db_1 from "./live.db";
import * as live_seed_1 from "./live.seed";
import * as live_iptv_1 from "./live.iptv";
function slugify(value) {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}
export async function ensureUniqueSlug(baseSlug, excludeId) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const slug = baseSlug || 'chaine';
    let candidate = slug;
    let i = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const existing = await LiveChannel.findOne({ slug: candidate });
        if (!existing || (excludeId && String(existing._id) === String(excludeId)))
            return candidate;
        candidate = `${slug}-${i}`;
        i++;
    }
}
/* ─── lecture publique ─────────────────────────────────────────────────── */
export async function listEnabled(filter) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const query = { enabled: true };
    if (filter?.category)
        query.categories = filter.category;
    if (filter?.country)
        query.country = filter.country.toUpperCase();
    return LiveChannel.find(query).sort({ order: 1, name: 1 }).lean();
}
export async function listAll() {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    return LiveChannel.find().sort({ order: 1, name: 1 }).lean();
}
export async function getBySlug(slug) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    return LiveChannel.findOne({ slug }).lean();
}
export async function getCategories() {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const categories = await LiveChannel.distinct('categories', { enabled: true });
    const order = ['news', 'politics', 'business', 'general', 'documentary', 'sports', 'music', 'kids', 'entertainment'];
    return [...order.filter((c) => categories.includes(c)), ...categories.filter((c) => !order.includes(c))];
}
/* ─── CRUD admin ───────────────────────────────────────────────────────── */
export async function createChannel(input) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const slug = await ensureUniqueSlug(slugify(input.name || 'chaine'));
    return LiveChannel.create({ ...input, slug, source: 'manual' });
}
export async function updateChannel(id, input) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const patch = { ...input };
    delete patch.name;
    if (input.name) {
        const nextSlug = await ensureUniqueSlug(slugify(input.name), id);
        patch.slug = nextSlug;
    }
    return LiveChannel.findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', runValidators: true }).lean();
}
export async function deleteChannel(id) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const res = await LiveChannel.findByIdAndDelete(id);
    return !!res;
}
/**
 * Upsert le seed dans la base live, en enrichissant chaque chaîne depuis la
 * playlist iptv-org de son pays (flux + logo à jour).
 * Par défaut, les flux/logos déjà présents en base (ex. édition admin) sont
 * préservés ; `updateStreams` force la mise à jour depuis iptv-org.
 */
export async function syncSeed(opts = {}) {
    const LiveChannel = await (0, live_db_1.getLiveChannelModel)();
    const result = { added: 0, updated: 0 };
    const byCountry = new Map();
    for (const seed of live_seed_1.LIVE_SEED) {
        const cc = (seed.country || 'FR').toLowerCase();
        byCountry.set(cc, [...(byCountry.get(cc) || []), seed]);
    }
    // Cache playlists pour éviter de refetcher pour chaque chaîne
    const playlistCache = new Map();
    async function getPlaylist(type, code) {
        const key = `${type}:${code}`;
        if (playlistCache.has(key))
            return playlistCache.get(key);
        try {
            const list = type === 'country' ? await (0, live_iptv_1.fetchIptvPlaylist)(code) : await (0, live_iptv_1.fetchIptvLanguagePlaylist)(code);
            playlistCache.set(key, list);
            return list;
        }
        catch (err) {
            console.warn(`[LiveTV] Playlist iptv-org ${key} indisponible:`, err.message);
            playlistCache.set(key, []);
            return [];
        }
    }
    for (const [cc, seeds] of byCountry) {
        for (const seed of seeds) {
            const playlist = [
                ...await getPlaylist('country', cc),
                ...(seed.language ? await getPlaylist('lang', seed.language) : []),
            ];
            const match = (0, live_iptv_1.findPlaylistMatch)(playlist, seed);
            const fallbackStream = seed.streamUrl || '';
            const fallbackLogo = seed.logo || '';
            const computedStream = match?.url || fallbackStream;
            const computedLogo = match?.logo || fallbackLogo;
            const existing = await LiveChannel.findOne({ slug: seed.slug });
            if (existing) {
                existing.name = seed.name;
                existing.categories = seed.categories;
                existing.country = seed.country || existing.country;
                existing.language = seed.language || existing.language;
                if (seed.type)
                    existing.type = seed.type;
                if (seed.referer)
                    existing.referer = seed.referer;
                if (seed.userAgent)
                    existing.userAgent = seed.userAgent;
                if (opts.updateStreams) {
                    if (computedStream)
                        existing.streamUrl = computedStream;
                    if (computedLogo)
                        existing.logo = computedLogo;
                }
                else {
                    if (!existing.streamUrl && computedStream)
                        existing.streamUrl = computedStream;
                    if (!existing.logo && computedLogo)
                        existing.logo = computedLogo;
                }
                await existing.save();
                result.updated++;
            }
            else {
                await LiveChannel.create({
                    name: seed.name,
                    slug: seed.slug,
                    logo: computedLogo,
                    categories: seed.categories,
                    country: seed.country,
                    language: seed.language,
                    type: seed.type || 'hls',
                    streamUrl: computedStream,
                    referer: seed.referer,
                    userAgent: seed.userAgent,
                    enabled: true,
                    order: seed.order ?? 0,
                    source: 'seed',
                });
                result.added++;
            }
        }
    }
    return result;
}
/* ─── proxy HLS (secours CORS) ─────────────────────────────────────────── */
const BLOCKED_HOSTS = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '[::1]',
    '::1',
    '169.254.169.254',
    'metadata.google.internal',
];
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
function isBlockedUrl(raw) {
    let host;
    try {
        host = new URL(raw).hostname.toLowerCase();
    }
    catch {
        return true;
    }
    return (BLOCKED_HOSTS.includes(host) ||
        host.endsWith('.localhost') ||
        host.endsWith('.internal'));
}
export async function proxyStream(url, opts = {}) {
    if (!/^https?:\/\//i.test(url) || isBlockedUrl(url)) {
        throw new Error('URL invalide ou interdite');
    }
    const headers = {
        'User-Agent': opts.userAgent || DEFAULT_UA,
        Accept: '*/*',
    };
    if (opts.referer)
        headers['Referer'] = opts.referer;
    if (opts.range)
        headers['Range'] = opts.range;
    const res = await axios_1.get(url, {
        headers,
        responseType: 'stream',
        validateStatus: () => true,
        maxRedirects: 5,
    });
    const toStrOrNull = (v) => v == null || v === '' ? null : String(v);
    return {
        status: res.status,
        contentType: toStrOrNull(res.headers['content-type']) || 'application/octet-stream',
        contentLength: toStrOrNull(res.headers['content-length']),
        contentRange: toStrOrNull(res.headers['content-range']),
        acceptRanges: toStrOrNull(res.headers['accept-ranges']),
        body: res.data,
    };
}
