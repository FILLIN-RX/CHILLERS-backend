import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { connectDB } from '../../config/db';
import Serie from '../../models/Serie';

function parseTitreSeason(titre: string): number | null {
    const match = titre.match(/Saison (\d+)/i);
    return match ? parseInt(match[1], 10) : null;
}

async function main() {
    await connectDB();

    const allSeries = await Serie.find().lean();
    let fixed = 0;
    let errors: string[] = [];

    for (const serie of allSeries) {
        const expectedSeason = parseTitreSeason(serie.titre);
        if (!expectedSeason) continue;

        const updates: { season: number; canonical: string; index: number }[] = [];

        for (let i = 0; i < (serie.episodes || []).length; i++) {
            const ep = serie.episodes[i];
            if (ep.season !== expectedSeason) {
                const epNum = ep.episodeNumber || 0;
                const canon = `S${String(expectedSeason).padStart(2, "0")}E${String(epNum).padStart(2, "0")}`;
                updates.push({ season: expectedSeason, canonical: canon, index: i });
            }
        }

        if (updates.length > 0) {
            const setFields: Record<string, any> = {};
            for (const u of updates) {
                setFields[`episodes.${u.index}.season`] = u.season;
                setFields[`episodes.${u.index}.episode`] = u.canonical;
            }
            try {
                await Serie.updateOne({ _id: serie._id }, { $set: setFields });
                fixed += updates.length;
                console.log(`✅ ${serie.titre}: ${updates.length} épisodes corrigés`);
            } catch (e: any) {
                errors.push(`${serie.titre}: ${e.message}`);
                console.log(`❌ ${serie.titre}: ${e.message}`);
            }
        }
    }

    console.log(`\n=== Résultat ===`);
    console.log(`✅ Épisodes corrigés: ${fixed}`);
    if (errors.length > 0) {
        console.log(`❌ Erreurs: ${errors.length}`);
        errors.forEach(e => console.log(`  - ${e}`));
    }

    process.exit(0);
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
