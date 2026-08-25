// @ts-nocheck
import mongoose_1 from "mongoose";
import * as live_model_1 from "./live.model";
// Connexion Mongo DÉDIÉE au module Live TV (section isolée) :
// on ne touche pas à la connexion principale de CHILLERS (config/db.ts).
// La connexion est paresseuse : créée au premier appel, jamais au démarrage
// du serveur, pour ne pas bloquer l'app principale si la base live est down.
let liveConnPromise = null;
export function getLiveDb() {
    if (!liveConnPromise) {
        liveConnPromise = (async () => {
            const uri = process.env.MONGO_URI;
            if (!uri) {
                throw new Error('MONGO_URI non défini dans le .env');
            }
            const conn = mongoose_1.createConnection(uri, {
                serverSelectionTimeoutMS: 10000,
            });
            await new Promise((resolve, reject) => {
                conn.once('connected', () => resolve());
                conn.once('error', (err) => reject(err));
            });
            console.log(`[LiveTV] Connecté à la base dédiée: ${conn.host}/${conn.name}`);
            return conn;
        })().catch((err) => {
            liveConnPromise = null;
            throw err;
        });
    }
    return liveConnPromise;
}
export async function getLiveChannelModel() {
    const conn = await getLiveDb();
    return conn.model('LiveChannel', live_model_1.liveChannelSchema);
}
