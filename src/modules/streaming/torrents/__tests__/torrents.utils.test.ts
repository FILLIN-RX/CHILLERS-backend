import { scoreTorrent, pickVideoFile, buildSearchQueries, sortTorrents, TorrentCandidate } from '../torrents.utils';

function candidate(overrides: Partial<TorrentCandidate> = {}): TorrentCandidate {
  return {
    title: 'Avatar 2009 1080p BluRay',
    indexer: 'YTS',
    size: 2.5 * 1024 ** 3,
    seeders: 100,
    ...overrides,
  };
}

describe('scoreTorrent', () => {
  it('favorise les seeders et une taille 720p/1080p', () => {
    const good = candidate({ seeders: 500, size: 2 * 1024 ** 3 });
    const poor = candidate({ seeders: 1, size: 0.1 * 1024 ** 3 });
    expect(scoreTorrent(good)).toBeGreaterThan(scoreTorrent(poor));
  });

  it('pénalise lourdement les qualités pourries (CAM/TS)', () => {
    const cam = candidate({ title: 'Avatar 2009 CAM', seeders: 500 });
    const good = candidate({ seeders: 10 });
    expect(scoreTorrent(cam)).toBeLessThan(scoreTorrent(good));
  });

  it('récompense les résolutions 720p/1080p dans le titre', () => {
    const hd = candidate({ title: 'Avatar 2009 1080p' });
    const sd = candidate({ title: 'Avatar 2009' });
    expect(scoreTorrent(hd)).toBeGreaterThan(scoreTorrent(sd));
  });

  it('préfère les indexeurs réputés', () => {
    const yts = candidate({ indexer: 'YTS' });
    const random = candidate({ indexer: 'RandomIndexer' });
    expect(scoreTorrent(yts)).toBeGreaterThan(scoreTorrent(random));
  });
});

describe('sortTorrents', () => {
  it('trie par score décroissant', () => {
    const sorted = sortTorrents([
      candidate({ seeders: 5 }),
      candidate({ seeders: 900, title: 'Avatar 2009 1080p BluRay CAM' }),
      candidate({ seeders: 300 }),
    ]);
    expect(scoreTorrent(sorted[0])).toBeGreaterThanOrEqual(scoreTorrent(sorted[1]));
    expect(scoreTorrent(sorted[1])).toBeGreaterThanOrEqual(scoreTorrent(sorted[2]));
  });
});

describe('pickVideoFile', () => {
  const files = [
    { id: 1, path: '/torrent/Série.S01E01.mkv', length: 1000 },
    { id: 2, path: '/torrent/Série.S01E02.mkv', length: 1100 },
    { id: 3, path: '/torrent/Underwater Footage.mp4', length: 9000 },
    { id: 4, path: '/torrent/subtitle.srt', length: 50 },
  ];

  it('ignore les non-vidéos et prend le plus gros fichier par défaut', () => {
    const info = pickVideoFile(files);
    expect(info).toEqual({ index: 3, filename: 'Underwater Footage.mp4', length: 9000 });
  });

  it('privilégie le fichier correspondant à S01E02', () => {
    const info = pickVideoFile(files, 1, 2);
    expect(info?.index).toBe(2);
    expect(info?.filename).toBe('Série.S01E02.mkv');
  });

  it('supporte le format alternatif 1x2', () => {
    const info = pickVideoFile([...files, { id: 5, path: '/torrent/alt 1x2.mp4', length: 500 }], 1, 2);
    expect([2, 5]).toContain(info?.index);
  });

  it('retombe sur le plus gros fichier si aucun SxxExx ne correspond', () => {
    const info = pickVideoFile(files, 3, 7);
    expect(info?.index).toBe(3);
  });

  it('retourne null sans aucun fichier vidéo', () => {
    expect(pickVideoFile([{ id: 1, path: '/x.srt', length: 10 }])).toBeNull();
  });
});

describe('buildSearchQueries', () => {
  it('priorise le tag SxxExx pour les épisodes', () => {
    expect(buildSearchQueries({ title: 'Breaking Bad', season: 1, episode: 2 })[0]).toBe(
      'Breaking Bad S01E02'
    );
  });

  it('inclut l’année entre parenthèses pour les films', () => {
    const queries = buildSearchQueries({ title: 'Avatar', year: 2009 });
    expect(queries).toContain('Avatar (2009)');
    expect(queries[0]).toBe('Avatar (2009)');
  });

  it('déduplique les requêtes', () => {
    const queries = buildSearchQueries({ title: 'Avatar', year: 2009 });
    expect(new Set(queries).size).toBe(queries.length);
  });
});
