// @ts-nocheck
export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'];
/** Message d'erreur sûr depuis un throw inconnu (catch). */
export function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
const GOOD_INDEXERS_RE = /(yts|eztv|1337x|galaxytv|nyaa|rarbg|therarbg|kickass|torrent9|ygg)/i;
const BAD_QUALITY_RE = /(\bcam\b|\bts\b|screener|hdtc|hdts|telesync|telecine|subbed\s*telesync)/i;
const QUALITY_RE = {
    '2160p': 40,
    '4k': 40,
    '1080p': 30,
    '720p': 10,
    'hdr': 20,
    '10bit': 15,
};
/**
 * Score un résultat torrent : plus c'est haut, meilleur c'est.
 * - Seeders en échelle sous-linéaire (plafonné à 100 pts)
 * - Taille idéale 0.7–4 Go (720p/1080p) : 50 pts
 * - Qualité explicite dans le titre (720p/1080p/4K)
 * - Indexeurs réputés +20
 * - Pénalité lourde pour les qualités pourries (CAM/TS/SCREENER)
 */
export function scoreTorrent(item) {
    const sizeGB = item.size > 0 ? item.size / 1024 ** 3 : 0;
    const seeds = Math.max(0, item.seeders || 0);
    let score = 0;
    score += Math.min(seeds, 500) * 0.2;
    if (sizeGB >= 1.5 && sizeGB <= 8) {
        // Idéal pour du 1080p ou 4K léger
        score += 50;
    }
    else if (sizeGB > 8 && sizeGB <= 25) {
        // Fichiers 4K HDR (assez lourds)
        score += 40;
    }
    else if (sizeGB >= 0.5 && sizeGB < 1.5) {
        // 720p ou 1080p très compressé
        score += 20;
    }
    else if (sizeGB > 25) {
        // Énormes REMUX (risque de gros buffering en streaming)
        score += 5;
    }
    const title = (item.title || '').toLowerCase();
    if (BAD_QUALITY_RE.test(title))
        score -= 100;
    for (const [re, pts] of Object.entries(QUALITY_RE)) {
        if (new RegExp(`\\b${re}\\b`).test(title))
            score += pts;
    }
    if (/\b(bluray|web-?dl|webrip|hdtv)\b/.test(title))
        score += 15;
    if (GOOD_INDEXERS_RE.test(item.indexer || ''))
        score += 20;
    return score;
}
export function sortTorrents(items) {
    return [...items].sort((a, b) => scoreTorrent(b) - scoreTorrent(a));
}
/**
 * Choisit le fichier vidéo principal d'un torrent :
 * - Si saison/épisode fournis → priorité aux fichiers SxxExx / NxN
 *   correspondants (séries multi-épisodes dans un même torrent)
 * - Sinon → le plus gros fichier vidéo
 */
export function pickVideoFile(files, season, episode) {
    const videos = files.filter((f) => exports.VIDEO_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext)));
    if (videos.length === 0)
        return null;
    const cleanName = (p) => p.split('/').pop()?.split('\\').pop() || p;
    if (season != null && episode != null) {
        const ss = String(season).padStart(2, '0');
        const es = String(episode).padStart(2, '0');
        const pattern = new RegExp(`s\\s*${ss}\\s*e\\s*${es}`, 'i');
        const patternAlt = new RegExp(`\\b${season}\\s*x\\s*${episode}\\b`, 'i');
        const matches = videos.filter((f) => pattern.test(f.path) || patternAlt.test(f.path));
        if (matches.length > 0) {
            const main = [...matches].sort((a, b) => b.length - a.length)[0];
            return { index: main.id, filename: cleanName(main.path), length: main.length };
        }
    }
    const best = [...videos].sort((a, b) => b.length - a.length)[0];
    return { index: best.id, filename: cleanName(best.path), length: best.length };
}
/**
 * Construit les requêtes Prowlarr par ordre de spécificité :
 * - Séries : "Titre S01E02" d'abord
 * - Puis "Titre (Année)", "Titre Année", enfin "Titre" seul
 */
export function buildSearchQueries(opts) {
    const queries = [];
    if (opts.season != null && opts.episode != null) {
        queries.push(`${opts.title} S${String(opts.season).padStart(2, '0')}E${String(opts.episode).padStart(2, '0')}`);
    }
    if (opts.year)
        queries.push(`${opts.title} (${opts.year})`);
    if (opts.year)
        queries.push(`${opts.title} ${opts.year}`);
    queries.push(opts.title);
    return [...new Set(queries)];
}
