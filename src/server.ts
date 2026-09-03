import './config/env';
import app from './app';
import { connectDB } from './config/db';
import bcrypt from 'bcryptjs';
import Admin from './models/Admin';
import { SubscriptionPlan } from './models/SubscriptionPlan';

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

async function seedPlans() {
  const count = await SubscriptionPlan.countDocuments();
  if (count === 0) {
    await SubscriptionPlan.create([
      { code: 'free', name: 'Gratuit', price: 0, durationMonths: 1, features: { maxDevices: 1, maxResolution: '720p', hasContinueWatching: false, hasWatchHistory: false, hasDownloads: false } },
      { code: 'standard', name: 'Standard', price: 4.99, durationMonths: 1, features: { maxDevices: 2, maxResolution: '1080p', hasContinueWatching: true, hasWatchHistory: true, hasDownloads: false } },
      { code: 'premium', name: 'Premium', price: 9.99, durationMonths: 1, features: { maxDevices: 4, maxResolution: '4K', hasContinueWatching: true, hasWatchHistory: true, hasDownloads: true } }
    ]);
    console.log('[Admin] Plans d\'abonnement créés (Free, Standard, Premium)');
  }
}

connectDB().then(async () => {
  await seedAdmin();
  await seedPlans();
  app.listen(PORT, () => {
    console.log(`[Chiller API] Running on http://localhost:${PORT}`);
    console.log(`[Chiller System] Cron géré par GitHub Actions. Le backend ne lance plus de tâches automatiques.`);
  });
});
