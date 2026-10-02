/**
 * TorrServerProvider — fallback de dernier recours de la chaîne de streaming.
 *
 * Flux : recherche Prowlarr (score seeds/taille/qualité) → ajout du torrent
 * dans TorrServer → attente des métadonnées → choix du fichier vidéo
 * (SxxExx pour les épisodes) → préchargement P2P → URL de transcode.
 *
 * Positionné en DERNIER dans la chaîne : supports() renvoie toujours false
 * pour que ProviderManager le traite en fallback (les 4 providers classiques
 * ont toujours la priorité).
 */

import { StreamingProvider, StreamQuery, StreamResult } from './provider.interface';
import { isTorrentsConfigured } from '../torrents/config';
import { searchTorrents, resolveTorrentLink } from '../torrents/prowlarr.service';
import {
  addTorrent,
  waitForFileInfo,
  warmUpTorrent,
  buildStreamUrl,
} from '../torrents/torrents.service';
import { resolveTmdbYear } from '../torrents/tmdb-helper';

export class TorrServerProvider implements StreamingProvider {
  readonly name = 'torrserver';

  /** Toujours en fallback : le manager tente d'abord les providers supports()=true. */
  supports(): boolean {
    return false;
  }

  async getMovieStream(query: StreamQuery): Promise<StreamResult | null> {
    return this.prepareStream(query, 'movie');
  }

  async getEpisodeStream(query: StreamQuery): Promise<StreamResult | null> {
    return this.prepareStream(query, 'episode');
  }

  private async prepareStream(
    query: StreamQuery,
    type: 'movie' | 'episode'
  ): Promise<StreamResult | null> {
    if (!query.title || !isTorrentsConfigured()) return null;

    const year = await resolveTmdbYear(query);
    const label =
      type === 'movie'
        ? `"${query.title}"${year ? ` (${year})` : ''}`
        : `"${query.title}" S${query.season}E${query.episode}`;
    console.log(`[TorrServer] Recherche torrent pour ${label}`);

    const candidates = await searchTorrents({
      title: query.title,
      year,
      season: type === 'episode' ? query.season : undefined,
      episode: type === 'episode' ? query.episode : undefined,
    });

    if (candidates.length === 0) {
      console.log(`[TorrServer] Aucun torrent trouvé pour ${label}`);
      return null;
    }

    const best = candidates[0];
    const sizeGB = best.size > 0 ? (best.size / 1024 ** 3).toFixed(2) : '?';
    console.log(
      `[TorrServer] Meilleur choix: "${best.title}" | ${best.seeders} seeds | ${sizeGB} GB | ${best.indexer}`
    );

    const source = await resolveTorrentLink(best);
    const hash = await addTorrent(source, best.title);

    console.log(`[TorrServer] Hash ${hash} — attente des métadonnées...`);
    const fileInfo = await waitForFileInfo(hash, {
      season: type === 'episode' ? query.season : undefined,
      episode: type === 'episode' ? query.episode : undefined,
    });

    if (!fileInfo) {
      throw new Error('TorrServer: aucun fichier vidéo trouvé après attente des métadonnées');
    }

    console.log(
      `[TorrServer] Fichier principal: "${fileInfo.filename}" (${(fileInfo.length / 1024 ** 3).toFixed(2)} GB)`
    );
    await warmUpTorrent(hash, fileInfo.index);

    return {
      provider: this.name,
      embedUrl: buildStreamUrl(hash, fileInfo.index),
      type,
    };
  }
}
