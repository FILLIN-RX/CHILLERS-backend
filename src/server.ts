import './config/env';
import app from './app';
import { connectDB } from './config/db';
import { startCron, runDeployTasksOnce } from './cron-manager';
import bcrypt from 'bcryptjs';
import Admin from './models/Admin';

const PORT = process.env.PORT || 4000;

/**
 * En production, refuse de démarrer avec des secrets par défaut/faibles.
 * Évite qu'un déploiement tourne avec admin/admin ou un JWT_SECRET connu.
 */
function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'chiller-admin-secret-change-me') {
    problems.push('JWT_SECRET manquant ou par défaut');
  }
  if (problems.length > 0) {
    throw new Error(
      `[Chiller] Démarrage refusé en production — secrets non sécurisés: ${problems.join(', ')}`
    );
  }
}

async function seedAdmin() {
  const count = await Admin.countDocuments();
  if (count === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin';
    const hashed = await bcrypt.hash(password, 10);
    await Admin.create({ username, password: hashed });
    console.log(`[Admin] Compte admin créé: ${username}`);
  }
}

assertProductionSecrets();

connectDB().then(async () => {
  await seedAdmin();
  app.listen(PORT, () => {
    console.log(`[Chiller API] Running on http://localhost:${PORT}`);
    // Démarre le scheduler (scraping + maintenance) sauf opt-out explicite.
    if (process.env.DISABLE_CRON === 'true') {
      console.log(`[Chiller System] Cron manager disabled (DISABLE_CRON=true).`);
    } else {
      startCron();
      console.log(`[Chiller System] Cron manager attached and running.`);
    }
    // Migration DoodStream → Uqload une fois par déploiement (non bloquant).
    runDeployTasksOnce().catch((err) => console.error('[Deploy] Migration Uqload échouée:', err));
  });
});
