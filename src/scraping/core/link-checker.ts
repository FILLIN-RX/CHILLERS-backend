import axios from 'axios';

/**
 * Vérifie si un lien vidéo est toujours valide (statut HTTP 200).
 */
export async function isLinkDead(url: string): Promise<boolean> {
  try {
    // On utilise HEAD pour ne pas télécharger la vidéo entière
    const response = await axios.head(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return response.status !== 200;
  } catch (error) {
    console.log(`[LinkCheck] Dead link detected: ${url}`);
    return true; // Si erreur (404, timeout), considéré mort
  }
}
