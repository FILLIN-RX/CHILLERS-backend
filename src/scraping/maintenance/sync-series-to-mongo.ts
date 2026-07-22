import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from '../../config/db';
import Serie from '../../models/Serie';
import { SERIES_OUTPUT_PATH, SERIES_PATH } from '../../config/data-paths';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

interface SeriesOutputEntry {
    titre: string;
    fileCode: string;
    lien: string;
    season: number;
    episode: number;
    totalSlots?: string;
    usedSlots?: string;
    uploadedAt?: string;
    fldId?: string;
    tmdbId?: number;
}

type SeriesOutput = Record<string, SeriesOutputEntry>;

function labelFor(season: number, episode: number): string {
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function buildEpisode(entry: SeriesOutputEntry): any {
    return {
        episode: labelFor(entry.season, entry.episode),
        season: entry.season,
        episodeNumber: entry.episode,
        fileCode: entry.fileCode,
        lien: entry.lien,
        fldId: entry.fldId,
        tmdbId: entry.tmdbId,
        totalSlots: entry.totalSlots,
        usedSlots: entry.usedSlots,
        uploadedAt: entry.uploadedAt ? new Date(entry.uploadedAt) : undefined
    };
}

async function main() {
    if (!fs.existsSync(SERIES_OUTPUT_PATH)) {
        console.error(`[SYNC] series-output.json introuvable à ${SERIES_OUTPUT_PATH}`);
        process.exit(1);
    }

    await connectDB();

    const raw: SeriesOutput = JSON.parse(fs.readFileSync(SERIES_OUTPUT_PATH, 'utf-8'));
    const entries = Object.values(raw);

    // Charger series.json pour récupérer pageUrl par titre (si dispo)
    let seriesMeta: Record<string, { pageUrl?: string }> = {};
    if (fs.existsSync(SERIES_PATH)) {
        try {
            const arr: any[] = JSON.parse(fs.readFileSync(SERIES_PATH, 'utf-8'));
            seriesMeta = Object.fromEntries(
                arr.map(s => [s.titre, { pageUrl: s.pageUrl }])
            );
        } catch (e) {
            console.warn('[SYNC] Impossible de lire series.json pour pageUrl:', e);
        }
    }

    // Grouper par titre
    const byTitle = new Map<string, SeriesOutputEntry[]>();
    for (const entry of entries) {
        if (!entry.titre) continue;
        if (!byTitle.has(entry.titre)) byTitle.set(entry.titre, []);
        byTitle.get(entry.titre)!.push(entry);
    }

    console.log(`[SYNC] ${byTitle.size} séries, ${entries.length} épisodes à synchroniser`);

    let upserted = 0;
    let failed = 0;

    for (const [titre, groupEntries] of byTitle) {
        try {
            // Trier par (season, episodeNumber) pour cohérence
            const sorted = [...groupEntries].sort((a, b) => {
                if (a.season !== b.season) return a.season - b.season;
                return a.episode - b.episode;
            });

            const episodes = sorted.map(buildEpisode);
            const tmdbId = sorted.find(e => e.tmdbId)?.tmdbId;
            const pageUrl = seriesMeta[titre]?.pageUrl || '';

            await Serie.findOneAndUpdate(
                { titre },
                {
                    $set: {
                        titre,
                        pageUrl,
                        tmdbId,
                        episodes,
                        updatedAt: new Date()
                    },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
            );

            upserted++;
            if (upserted % 20 === 0) {
                console.log(`[SYNC] ${upserted}/${byTitle.size}...`);
            }
        } catch (err: any) {
            console.error(`[SYNC] Échec pour "${titre}":`, err.message);
            failed++;
        }
    }

    console.log(`\n[SYNC] Terminé: ${upserted} séries upsertées, ${failed} échouées`);
    process.exit(0);
}

main().catch(err => {
    console.error('[SYNC] FATAL:', err);
    process.exit(1);
});
