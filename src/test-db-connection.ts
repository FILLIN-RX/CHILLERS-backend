import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Charger les variables depuis le .env
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testConnection() {
    const uri = process.env.MONGO_URI;
    
    if (!uri) {
        console.error("ERREUR: MONGO_URI n'est pas défini dans le fichier .env");
        process.exit(1);
    }

    console.log("Tentative de connexion à MongoDB...");
    
    try {
        await mongoose.connect(uri);
        console.log("✅ Connexion réussie à MongoDB !");
        
        // Tester une opération simple (lister les collections)
        const db = mongoose.connection.db;
        if (!db) throw new Error("Database not connected");
        const collections = await db.listCollections().toArray();
        console.log("Collections trouvées :", collections.map(c => c.name));
        
        await mongoose.disconnect();
        console.log("Connexion fermée.");
    } catch (error) {
        console.error("❌ Erreur de connexion :", error);
        process.exit(1);
    }
}

testConnection();
