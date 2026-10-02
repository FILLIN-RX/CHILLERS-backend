import '../config/env';
import { syncSeed } from '../modules/live/live.service';

/**
 * Synchronise le catalogue curé de chaînes Live TV depuis le seed vers la
 * base MongoDB dédiée (LIVE_MONGO_URI), en enrichissant les flux/logos via
 * les playlists iptv-org.
 *
 * Usage :
 *   npm run sync-live-channels            # ajoute/rafraîchit sans écraser les éditions admin
 *   npm run sync-live-channels -- --update-streams   # force la MAJ des flux depuis iptv-org
 */
async function main() {
  const updateStreams = process.argv.includes('--update-streams');
  console.log(`[LiveTV] Synchronisation du seed${updateStreams ? ' (mise à jour des flux iptv-org)' : ''}...`);
  const result = await syncSeed({ updateStreams });
  console.log(`[LiveTV] Terminé : ${result.added} chaîne(s) ajoutée(s), ${result.updated} mise(s) à jour.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[LiveTV] Erreur lors de la synchronisation:', err);
  process.exit(1);
});
