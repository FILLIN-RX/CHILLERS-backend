import app from './app';
import { connectDB } from './config/db';
import bcrypt from 'bcryptjs';
import Admin from './models/Admin';

const PORT = process.env.PORT || 4000;

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

connectDB().then(async () => {
  await seedAdmin();
  app.listen(PORT, () => {
    console.log(`[Chiller API] Running on http://localhost:${PORT}`);
    console.log(`[Chiller System] Cron manager attached and running.`);
  });
});
