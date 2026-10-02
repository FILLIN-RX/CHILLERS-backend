/**
 * Détection des fichiers Uqload inactifs.
 *
 * Uqload supprime les fichiers sans activité (téléchargement) depuis 60 jours.
 * Ce module liste tous les fichiers du compte, récupère leur date de dernier
 * téléchargement via /file/info, et renvoie ceux qui sont inactifs depuis plus
 * de `inactiveDays` jours (défaut: 50) afin de pouvoir agir avant suppression.
 */
import { UqloadClient } from './uqload.client';
import { UqloadFileInfo } from './uqload.types';

export const UQLOAD_DELETE_DAYS = 60;

export interface InactiveUqloadFile {
  fileCode: string;
  title: string;
  link: string;
  views: string;
  uploaded: string;
  lastDownload: string | null;
  inactiveDays: number;
  fileInfo?: UqloadFileInfo;
}

const INFO_BATCH = 50;

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

export class UqloadInactiveScanner {
  constructor(private client: UqloadClient) {}

  /**
   * Liste tous les fichiers du compte (toutes pages).
   */
  async listAllFiles(): Promise<Array<{ file_code: string; title: string; link: string; views: string; uploaded: string }>> {
    const files = [];
    let page = 1;
    let totalPages = 1;

    do {
      const result = await this.client.listFiles({ per_page: 100, page });
      for (const f of result.files || []) {
        files.push({ file_code: f.file_code, title: f.title, link: f.link, views: f.views, uploaded: f.uploaded });
      }
      totalPages = result.pages || 1;
      page++;
    } while (page <= totalPages && page <= 50);

    return files;
  }

  /**
   * Récupère les infos (dont file_last_download) pour une liste de codes,
   * par lots de 50 (l'API accepte une liste séparée par des virgules).
   */
  async fetchInfos(codes: string[]): Promise<Map<string, UqloadFileInfo>> {
    const map = new Map<string, UqloadFileInfo>();
    for (let i = 0; i < codes.length; i += INFO_BATCH) {
      const batch = codes.slice(i, i + INFO_BATCH);
      const res = await this.client.getFileInfo(batch.join(','));
      for (const info of res.result || []) {
        map.set(info.file_code, info);
      }
    }
    return map;
  }

  /**
   * Renvoie les fichiers inactifs depuis plus de `inactiveDays` jours.
   */
  async findInactive(inactiveDays = 50): Promise<InactiveUqloadFile[]> {
    const files = await this.listAllFiles();
    if (files.length === 0) return [];

    const codes = files.map(f => f.file_code);
    const infos = await this.fetchInfos(codes);

    const inactive: InactiveUqloadFile[] = [];

    for (const f of files) {
      const info = infos.get(f.file_code);
      const lastDownload = parseDate(info?.file_last_download);
      const uploaded = parseDate(f.uploaded);
      const lastActivity = lastDownload ?? uploaded;
      if (!lastActivity) continue;

      const inactiveDaysActual = daysSince(lastActivity);
      if (inactiveDaysActual >= inactiveDays) {
        inactive.push({
          fileCode: f.file_code,
          title: f.title,
          link: f.link,
          views: f.views,
          uploaded: f.uploaded,
          lastDownload: info?.file_last_download || null,
          inactiveDays: inactiveDaysActual,
          fileInfo: info,
        });
      }
    }

    return inactive.sort((a, b) => b.inactiveDays - a.inactiveDays);
  }
}
