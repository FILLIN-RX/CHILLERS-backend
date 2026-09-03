export type AudioLanguageType = 'VF' | 'VFF' | 'VFQ' | 'VOSTFR' | 'VO' | 'UNKNOWN';

export interface AudioLanguageDetection {
  langueAudio: AudioLanguageType;
  isFrenchAudio: boolean;
}

/**
 * Détecte la langue audio à partir des métadonnées de la vidéo (nom de fichier, URL, titre)
 */
export function detectAudioLanguage(data: {
  titre?: string;
  lien?: string;
  lienOriginal?: string;
  pageUrl?: string;
  uqloadLink?: string;
  sources?: Array<{ lien?: string; name?: string; url?: string; source?: string }>;
  episodes?: Array<{ lien?: string; title?: string }>;
}): AudioLanguageDetection {
  const parts: string[] = [];

  if (data.titre) parts.push(data.titre);
  if (data.lien) parts.push(data.lien);
  if (data.lienOriginal) parts.push(data.lienOriginal);
  if (data.pageUrl) parts.push(data.pageUrl);
  if (data.uqloadLink) parts.push(data.uqloadLink);

  if (Array.isArray(data.sources)) {
    for (const s of data.sources) {
      if (s.lien) parts.push(s.lien);
      if (s.name) parts.push(s.name);
      if (s.url) parts.push(s.url);
      if (s.source) parts.push(s.source);
    }
  }

  if (Array.isArray(data.episodes)) {
    for (const ep of data.episodes) {
      if (ep.lien) parts.push(ep.lien);
      if (ep.title) parts.push(ep.title);
    }
  }

  const rawText = parts.join(' ');
  let decodedText = rawText;
  try {
    decodedText = decodeURIComponent(rawText);
  } catch {
    decodedText = rawText;
  }
  const upper = decodedText.toUpperCase();

  // 1. VOSTFR / VOST : Sous-titré en français mais audio original
  if (/\b(VOSTFR|VOST)\b/.test(upper)) {
    return {
      langueAudio: 'VOSTFR',
      isFrenchAudio: false,
    };
  }

  // 2. VFF : Version Francophone Française (TrueFrench)
  if (/\b(VFF|TRUEFRENCH)\b/.test(upper)) {
    return {
      langueAudio: 'VFF',
      isFrenchAudio: true,
    };
  }

  // 3. VFQ : Version Francophone Québécoise
  if (/\b(VFQ)\b/.test(upper)) {
    return {
      langueAudio: 'VFQ',
      isFrenchAudio: true,
    };
  }

  // 4. VF / FRENCH / MULTI : Audio Français standard
  if (/\b(VF|FRENCH|MULTI)\b/.test(upper)) {
    return {
      langueAudio: 'VF',
      isFrenchAudio: true,
    };
  }

  // 5. VO / English
  if (/\b(ENG|ENGLISH|VO)\b/.test(upper)) {
    return {
      langueAudio: 'VO',
      isFrenchAudio: false,
    };
  }

  return {
    langueAudio: 'UNKNOWN',
    isFrenchAudio: false,
  };
}
