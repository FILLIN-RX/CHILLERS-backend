import dotenv from 'dotenv';
import path from 'path';

// À importer EN PREMIER (avant tout autre module) pour que les constantes
// lues au chargement (JWT_SECRET, TMDB_TOKEN, etc.) voient bien le .env.
dotenv.config({ path: path.join(__dirname, '../../.env') });
