import fs from 'fs';
import path from 'path';

/**
 * Remonte depuis __dirname jusqu'à trouver le package.json du backend
 * (chiller-backend). Marche que le module soit appelé depuis src/ ou dist/.
 */
function findBackendRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            try {
                const data = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
                if (data.name === 'chiller-backend') return dir;
            } catch {
                // ignore JSON parse errors, continue searching
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback raisonnable : on suppose que ce fichier est dans src/config ou dist/config
    return path.resolve(__dirname, '../..');
}

const ROOT = findBackendRoot();

/**
 * Toutes les données de scraping vivent dans src/scraping/core/ — c'est la
 * source de vérité versionnée. dist/ est généré et ne contient pas les JSON.
 * On pointe donc toujours vers src/, peu importe depuis quel fichier compilé
 * on appelle ce helper.
 */
export const CORE_DIR = path.join(ROOT, 'src/scraping/core');
export const UPLOADED_PATH = path.join(CORE_DIR, 'uploaded.json');
export const SERIES_OUTPUT_PATH = path.join(CORE_DIR, 'series-output.json');
export const SERIES_PATH = path.join(CORE_DIR, 'series.json');
export const FILM_JSON_PATH = path.join(CORE_DIR, 'film.json');

export const BACKEND_ROOT = ROOT;
