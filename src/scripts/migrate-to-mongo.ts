import { connectDB } from '../config/db';
import Movie from '../models/Movie';
import Serie from '../models/Serie';
import fs from 'fs';
import path from 'path';

async function migrate() {
    await connectDB();
    const CORE_DIR = path.join(__dirname, '../scraping/core');
    
    // Migrate Films
    console.log("Migrating Films...");
    const filmsObj = JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'uploaded.json'), 'utf-8'));
    const films = Object.values(filmsObj); // Convert object values to array
    const movieOps = films.map((f: any) => ({
        updateOne: { filter: { titre: f.titre }, update: { $set: f }, upsert: true }
    }));
    await Movie.bulkWrite(movieOps);
    console.log(`Migrated ${movieOps.length} films.`);

    // Migrate Series
    console.log("Migrating Series...");
    const seriesObj = JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'series-output.json'), 'utf-8'));
    const series = Object.values(seriesObj); // Convert object values to array
    const serieOps = series.map((s: any) => ({
        updateOne: { filter: { titre: s.titre }, update: { $set: s }, upsert: true }
    }));

    await Serie.bulkWrite(serieOps);
    console.log(`Migrated ${serieOps.length} series.`);
    
    process.exit(0);
}

migrate().catch(console.error);
