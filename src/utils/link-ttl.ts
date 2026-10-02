/**
 * link-ttl.ts
 * Détecte si un lien signé (Uqload, Vidzy.cc, etc.) est expiré
 * en parsant le paramètre query `e=` (timestamp UNIX ou durée relative).
 *
 * Format observé dans les URLs :
 *   ?t=<token>&s=<start>&e=<epoch_or_duration>&f=<file>&sp=<speed>&i=<ip>
 *
 * Quand `e` est un timestamp UNIX absolu (>= 1_000_000_000) on le compare
 * à l'heure actuelle. Sinon on ne peut pas déduire l'expiration sans la
 * date de création → on considère le lien valide (optimiste).
 */
export function isSignedLinkExpired(url: string): boolean {
  if (!url || url === '#') return false;
  try {
    const u = new URL(url);
    const eParam = u.searchParams.get('e');
    if (!eParam) return false;

    const expValue = parseInt(eParam, 10);
    if (isNaN(expValue)) return false;

    if (expValue >= 1_000_000_000) {
      // Epoch UNIX absolu (secondes)
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expired = nowSeconds > expValue;
      if (expired) {
        console.warn(`[LinkTTL] Lien expiré (e=${expValue}, now=${nowSeconds}): ${url.slice(0, 80)}...`);
      }
      return expired;
    }

    // Durée relative en secondes (ex: e=43200 = 12h) — sans date de création
    // on ne peut pas calculer l'expiration → on fait confiance (optimiste)
    return false;
  } catch {
    return false;
  }
}

/**
 * Retourne le timestamp d'expiration en millisecondes (pour affichage/logs),
 * ou null si non déterminable.
 */
export function getLinkExpiry(url: string): Date | null {
  try {
    const u = new URL(url);
    const eParam = u.searchParams.get('e');
    if (!eParam) return null;
    const expValue = parseInt(eParam, 10);
    if (isNaN(expValue) || expValue < 1_000_000_000) return null;
    return new Date(expValue * 1000);
  } catch {
    return null;
  }
}
