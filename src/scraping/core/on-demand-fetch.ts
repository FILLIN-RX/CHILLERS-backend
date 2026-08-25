import { searchOtaku, getSpecificEpisodeLink } from '../../modules/otaku/otaku.service';
import Movie from '../../models/Movie';
import Serie from '../../models/Serie';
import { autoLink } from '../maintenance/auto-link';

/**
 * Recherche et récupère les informations pour un film ou une série s'il est manquant via direct API
 */
export async function fetchMissingMedia(title: string, type: 'movie' | 'series', episodeNum?: string) {
    console.log(`[OnDemand Direct API] Recherche de : "${title}" (${type})...`);

    if (type === 'series' && episodeNum) {
        const link = await getSpecificEpisodeLink(null, episodeNum, null, title);
        if (link) {
            const result = { titre: title, episode: `Ép ${episodeNum}`, lien: link };
            const updated = await Serie.findOneAndUpdate(
                { titre: title },
                { $push: { episodes: { episode: `Ép ${episodeNum}`, lien: link } } },
                { upsert: true, returnDocument: 'after' }
            );
            if (updated?._id) autoLink('series', updated._id.toString());
            return result;
        }
    } else {
        const result = await searchOtaku(title, type);
        if (result && result.lien) {
            const updated = await Movie.findOneAndUpdate(
                { titre: title },
                { $set: { titre: result.titre, lien: result.lien } },
                { upsert: true, returnDocument: 'after' }
            );
            if (updated?._id) autoLink('movie', updated._id.toString());
            return { titre: result.titre, lien: result.lien };
        }
    }

    return null;
}

if (process.argv[1] && process.argv[1].includes('on-demand-fetch')) {
    const title = process.argv[2];
    const type = process.argv[3] as 'movie' | 'series';
    const episodeNum = process.argv[4];

    if (title && type) {
        fetchMissingMedia(title, type, episodeNum)
            .then((result) => {
                if (result) {
                    console.log(`[OnDemand] Successfully fetched: ${JSON.stringify(result)}`);
                    process.exit(0);
                } else {
                    console.log(`[OnDemand] Failed to fetch missing media for: "${title}"`);
                    process.exit(1);
                }
            })
            .catch((err) => {
                console.error(`[OnDemand] Error executing fetch:`, err);
                process.exit(1);
            });
    } else {
        console.error('Usage: npx tsx on-demand-fetch.ts <title> <type> [episodeNum]');
        process.exit(1);
    }
}
