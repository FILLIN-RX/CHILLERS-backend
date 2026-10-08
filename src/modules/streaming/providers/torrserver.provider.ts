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
import { resolveTmdbYear } from '../torrents/utils/tmdb-helper';

/**
 * Budget interne du provider P2P. ProviderManager l'avorte à 60 s
 * (TORRENT_TIMEOUT) : on se cale en dessous pour qu'une recherche longue ne
 * consomme pas le temps des métadonnées, et qu'un échec reste lisible plutôt
 * qu'un AbortError en plein addTorrent.
 */
const TORRENT_BUDGET_MS = 50_000;

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

    const deadlineAt = Date.now() + TORRENT_BUDGET_MS;
    const year = await resolveTmdbYear(query);
    const label =
      type === 'movie'
        ? `"${query.title}"${year ? ` (${year})` : ''}`
        : `"${query.title}" S${query.season}E${query.episode}`;
    console.log(`[TorrServer] Recherche torrent pour ${label}`);

    const candidates = await searchTorrents(
      {
        title: query.title,
        year,
        season: type === 'episode' ? query.season : undefined,
        episode: type === 'episode' ? query.episode : undefined,
      },
      deadlineAt
    );

    if (candidates.length === 0) {
      console.log(`[TorrServer] Aucun torrent trouvé pour ${label}`);
      return null;
    }

    const maxAttempts = Math.min(candidates.length, 3);
    for (let i = 0; i < maxAttempts; i++) {
      if (Date.now() >= deadlineAt - 5000) break;
      const candidate = candidates[i];
      const sizeGB = candidate.size > 0 ? (candidate.size / 1024 ** 3).toFixed(2) : '?';
      console.log(
        `[TorrServer] Candidat ${i + 1}/${maxAttempts}: "${candidate.title}" | ${candidate.seeders} seeds | ${sizeGB} GB | ${candidate.indexer}`
      );

      try {
        const source = await resolveTorrentLink(candidate);
        const hash = await addTorrent(source, candidate.title, deadlineAt);

        console.log(`[TorrServer] Hash ${hash} — attente des métadonnées...`);
        const fileInfo = await waitForFileInfo(
          hash,
          {
            season: type === 'episode' ? query.season : undefined,
            episode: type === 'episode' ? query.episode : undefined,
          },
          deadlineAt
        );

        if (!fileInfo) {
          console.log(`[TorrServer] Métadonnées introuvables pour "${candidate.title}" → essai suivant`);
          continue;
        }

        console.log(
          `[TorrServer] Fichier principal: "${fileInfo.filename}" (${(fileInfo.length / 1024 ** 3).toFixed(2)} GB)`
        );
        await warmUpTorrent(hash, fileInfo.index, deadlineAt);

        return {
          provider: this.name,
          embedUrl: buildStreamUrl(hash, fileInfo.index),
          type,
        };
      } catch (err: any) {
        console.warn(`[TorrServer] Échec candidat "${candidate.title}": ${err?.message || err}`);
      }
    }

    console.log(`[TorrServer] Aucun candidat P2P n'a abouti pour ${label} → skip`);
    return null;
  }
}
