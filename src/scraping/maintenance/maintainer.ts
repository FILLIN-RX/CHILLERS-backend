import fs from 'fs';
import { chromium } from 'playwright';
import mongoose from 'mongoose';
import { browserConfig } from '../../config/browser';
import { isLinkDead } from '../core/link-checker';
import { createBackup } from '../core/backup';
import { sendNotification } from '../core/notifier';
import { getSpecificEpisodeLink, searchAndNavigateToSeries } from '../../modules/otaku/otaku.service';
import { reuploadEpisode } from '../../modules/reupload/reupload';
import { SERIES_PATH } from '../../config/data-paths';
import { connectDB } from '../../config/db';
import Serie, { type IEpisode } from '../../models/Serie';

// Keep SERIES_PATH for the backup-on-start step so the on-disk file still
// matches the DB after a maintenance pass, but the DB is now the single
// source of truth — we read from it and write back to it in place.
const SERIES_FILE = SERIES_PATH;
const BASE_URL = 'https://www.open-otaku.me';

/**
 * Extract the episode number from any of the label formats that show up
 * in MongoDB (the schema is loose — we accept the canonical "S02E01" form
 * and the legacy "Ép 5" form). Returns null when the label doesn't match
 * either, so the caller can skip the episode instead of sending "NaN"
 * downstream.
 */
function parseEpisodeNumber(label: string | undefined): number | null {
    if (!label) return null;
    const trimmed = label.trim();
    // "S02E01" / "S2E5" / "s02 e10" — last integer wins.
    const sxxExx = trimmed.match(/S\d+\s*E\s*(\d+)/i);
    if (sxxExx) return parseInt(sxxExx[1], 10);
    // "Ép 5" / "Episode 12" / "Ep. 3"
    const epWord = trimmed.match(/(?:Ép|Ep|Episode)\s*\.?\s*(\d+)/i);
    if (epWord) return parseInt(epWord[1], 10);
    // Bare number as a last resort
    const bare = trimmed.match(/(\d+)/);
    return bare ? parseInt(bare[1], 10) : null;
}

async function repairSeriesLinks() {
    console.log("[Maintenance] Démarrage de la vérification des liens...");
    await connectDB();

    // 1. Sauvegarde du fichier JSON (kept for parity with the previous flow —
    //    it can be re-synced from Mongo later via sync-series-to-mongo.ts).
    createBackup(SERIES_FILE);

    // 2. Chargement des données DEPUIS MongoDB. JSON sur disque n'est plus
    //    source de vérité : on itère sur les documents Serie et leurs
    //    sous-documents episodes, et on $set directement les liens mis à
    //    jour via positional operator.
    const allSeries = await Serie.find().lean();
    let repairedCount = 0;
    let report: string[] = [];

    // Lancer navigateur
    const browser = await chromium.launch(browserConfig);
    const page = await browser.newPage();

    // 3. Vérification
    for (const serie of allSeries) {
        // Si pageUrl manque, on tente une recherche pour le récupérer
        if (!serie.pageUrl) {
            console.log(`[Maintenance] pageUrl manquant pour ${serie.titre}, recherche en cours...`);
            const navigated = await searchAndNavigateToSeries(page, serie.titre);
            if (navigated) {
                const newPageUrl = page.url();
                // Persist the discovered pageUrl so we don't re-search next time.
                await Serie.updateOne({ _id: serie._id }, { $set: { pageUrl: newPageUrl } });
                serie.pageUrl = newPageUrl;
            } else {
                report.push(`Échec mise à jour pageUrl: ${serie.titre}`);
                continue; // Impossible de réparer sans URL
            }
        } else {
            // Navigation directe
            await page.goto(serie.pageUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);
        }

        // Tracke le dernier lien retourné par Otaku sur cette page pour
        // détecter les réponses périmées (la page renvoie parfois le lien
        // de l'épisode précédent au lieu du nouveau).
        let lastOtakuLink: string | null = null;

        // Corriger les saisons erronées (ex: "Saison 4" dans le titre mais
        // season=1 dans les épisodes à cause du bug parseEpisodeLabel).
        const expectedSeason = (() => {
            const m = serie.titre.match(/Saison (\d+)/i);
            return m ? parseInt(m[1], 10) : null;
        })();
        if (expectedSeason !== null) {
            const seasonUpdates: Record<string, any> = {};
            for (let i = 0; i < serie.episodes.length; i++) {
                const ep = serie.episodes[i];
                if (ep.season !== expectedSeason) {
                    const epNum = ep.episodeNumber || (i + 1);
                    const canon = `S${String(expectedSeason).padStart(2, "0")}E${String(epNum).padStart(2, "0")}`;
                    seasonUpdates[`episodes.${i}.season`] = expectedSeason;
                    seasonUpdates[`episodes.${i}.episode`] = canon;
                    ep.season = expectedSeason;
                    ep.episode = canon;
                }
            }
            const keys = Object.keys(seasonUpdates);
            if (keys.length > 0) {
                await Serie.updateOne({ _id: serie._id }, { $set: seasonUpdates });
                console.log(`[Maintenance] 🔧 Saison corrigée: ${serie.titre} (${keys.length / 2} épisodes)`);
                report.push(`Saison corrigée: ${serie.titre} (${keys.length / 2} épisodes)`);
            }
        }

        for (const episode of serie.episodes) {
            if (await isLinkDead(episode.lien)) {
                console.log(`[Maintenance] Lien mort détecté: ${serie.titre} - ${episode.episode}`);

                // Extraire le numéro de l'épisode. Le label peut être :
                //   - "Ép 5" (ancien format, encore présent en DB pour les
                //     séries importées avant la migration)
                //   - "S02E01" (format canonique de la DB)
                //   - "S02E1"  (variante sans zero-pad)
                // Le provider Otaku attend un entier simple ("5", "1").
                const epNum = parseEpisodeNumber(episode.episode);

                // La saison : préfère `episode.season` du document (numérique
                // déjà en DB) et retombe sur le regex du titre si absent.
                const season =
                    typeof episode.season === "number"
                        ? episode.season
                        : (() => {
                              const m = serie.titre.match(/Saison (\d+)/i);
                              return m ? parseInt(m[1], 10) : 1;
                          })();

                if (epNum === null) {
                    console.log(
                        `[Maintenance] ⚠ Numéro d'épisode introuvable dans "${episode.episode}" pour ${serie.titre}`
                    );
                    continue;
                }

                const newLink = await getSpecificEpisodeLink(page, String(epNum), lastOtakuLink);

                if (newLink) {
                    // Re-verify: Otaku sometimes returns the link from the
                    // previous episode (its page state lags by one click),
                    // which would silently re-write a still-dead URL into
                    // the DB. Without this guard we end up with several
                    // episodes pointing at the same "fresh" link — exactly
                    // what happened to Ride or Die / Plaisir max / Trying
                    // before the backfill. If the new link is also dead,
                    // we skip this episode without persisting or
                    // re-uploading; check-all-links will pick it up next
                    // pass when Otaku is in a better state.
                    if (await isLinkDead(newLink)) {
                        console.log(
                            `[Maintenance] ⚠ Otaku a renvoyé un lien encore mort: ${serie.titre} - ${episode.episode} (${newLink.slice(0, 60)}...)`
                        );
                        report.push(
                            `Stale Otaku (lien encore mort): ${serie.titre} - ${episode.episode}`,
                        );
                        continue;
                    }

                    // Mise à jour MongoDB via positional operator. C'est ici
                    // que la nouvelle URL est persistée — l'ancien code
                    // essayait la même opération mais avec une query sur
                    // `titre` + nested match, qui n'arrivait pas à matcher
                    // les documents (cf. warnings "Aucun document trouvé").
                    // Avec _id + positional $, le match est garanti.
                    const result = await Serie.updateOne(
                        {
                            _id: serie._id,
                            'episodes.season': season,
                            'episodes.episodeNumber': epNum,
                        },
                        { $set: { 'episodes.$.lien': newLink } }
                    );

                    if (result.matchedCount === 0) {
                        console.log(
                            `[Maintenance] ⚠ Episode introuvable pour maj: ${serie.titre} - S${season}E${String(epNum).padStart(2, '0')}`
                        );
                        report.push(`Match raté (épisode introuvable): ${serie.titre} - ${episode.episode}`);
                    } else {
                        // Keep the in-memory copy in sync so a subsequent
                        // repair in the same pass sees the fresh URL.
                        (episode as IEpisode).lien = newLink;
                        lastOtakuLink = newLink;
                        repairedCount++;
                        report.push(`Réparé: ${serie.titre} - ${episode.episode}`);
                        console.log(`[Maintenance] Succès: ${newLink}`);

                        // Mirror the freshly-repaired URL to Doodstream AND
                        // Uqload. We do this in the maintenance pass so a
                        // re-repair of the same episode doesn't have to
                        // re-scrape Otaku twice. The reupload module skips
                        // platforms that already have a fileCode.
                        try {
                            const reupload = await reuploadEpisode(
                                String(serie._id),
                                { ...(episode as IEpisode), lien: newLink },
                                allSeries.indexOf(serie), // best-effort positional
                            );
                            const uploadedTo: string[] = [];
                            if (reupload.uploadedDoodstream) uploadedTo.push("doodstream");
                            if (reupload.uploadedUqload) uploadedTo.push("uqload");
                            if (uploadedTo.length > 0) {
                                console.log(
                                    `[Maintenance] ↗ Mirror ${uploadedTo.join("+")} OK pour ${serie.titre} ${episode.episode}`
                                );
                                report.push(
                                    `Mirror ${uploadedTo.join("+")}: ${serie.titre} ${episode.episode}`
                                );
                            }
                            if (reupload.errors.length > 0) {
                                report.push(
                                    `Mirror partiel (${reupload.errors.join("; ")}): ${serie.titre} ${episode.episode}`
                                );
                            }
                        } catch (e: any) {
                            console.log(`[Maintenance] Mirror échoué: ${e.message}`);
                            report.push(`Mirror échoué: ${serie.titre} ${episode.episode} (${e.message})`);
                        }
                    }
                } else {
                    report.push(`Échec réparation: ${serie.titre} - ${episode.episode}`);
                    console.log(`[Maintenance] Échec.`);
                }
            }
        }
    }

    await browser.close();

    // 4. Re-sérialise series.json depuis Mongo pour qu'il reflète l'état
    //    réel. C'est un effet de bord utile pour les scripts qui lisent
    //    encore le JSON, mais ce n'est plus jamais la source de vérité.
    try {
        const fresh = await Serie.find().lean();
        fs.writeFileSync(SERIES_FILE, JSON.stringify(fresh, null, 4), 'utf-8');
    } catch (e: any) {
        console.log(`[Maintenance] ⚠ Échec réécriture series.json: ${e.message}`);
    }

    // 5. Notification
    if (repairedCount > 0) {
        await sendNotification(
            "Maintenance Chillers: Liens réparés",
            `Nombre de liens réparés: ${repairedCount}\n\nDétails:\n${report.join('\n')}`
        );
    }

    console.log(`[Maintenance] Terminé. ${repairedCount} liens réparés.`);
    await mongoose.disconnect();
}

repairSeriesLinks().catch(console.error);
