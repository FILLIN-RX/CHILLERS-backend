const LANGUAGE_MAP: Record<string, string> = {
  fr: 'fr-FR',
  en: 'en-US',
};

export function toTMDBLanguage(language?: string): string {
  if (!language) return 'fr-FR';
  return LANGUAGE_MAP[language] || language;
}
