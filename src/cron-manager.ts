import cron, { ScheduledTask } from 'node-cron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { appendLog } from './config/log-buffer';

const isDev = process.env.NODE_ENV !== 'production';

let cronTasks: ScheduledTask[] = [];
let isRunning = false;
const runningProcesses: Map<string, ChildProcess> = new Map();

function resolveScript(relativePath: string): string {
    const fullPath = path.join(__dirname, relativePath);
    if (!isDev) return fullPath;
    const tsPath = fullPath.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsPath)) return tsPath;
    return fullPath;
}

function runProcess(name: string, command: string, args: string[]) {
    const startTime = new Date().toISOString();
    const header = `[Cron] Lancement : ${name}`;
    console.log(`[${startTime}] ${header}`);
    appendLog(header);

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    runningProcesses.set(name, child);

    child.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n').filter((l: string) => l)) {
            const msg = `[${name}] ${line}`;
            console.log(msg);
            appendLog(msg);
        }
    });

    child.stderr.on('data', (data) => {
        for (const line of data.toString().split('\n').filter((l: string) => l)) {
            const msg = `[${name}] ${line}`;
            console.error(msg);
            appendLog(msg);
        }
    });

    child.on('close', (code) => {
        runningProcesses.delete(name);
        const endTime = new Date().toISOString();
        const msg = code === 0
            ? `[Cron] Terminé avec succès : ${name}`
            : `[Cron] ERREUR : ${name} (code: ${code})`;
        console.log(`[${endTime}] ${msg}`);
        appendLog(msg);
    });
}

export function stopTask(name: string): boolean {
    const child = runningProcesses.get(name);
    if (!child) return false;
    appendLog(`[Admin] Arrêt demandé : ${name}`);
    child.kill('SIGTERM');
    return true;
}

export function getRunningTasks(): string[] {
    return Array.from(runningProcesses.keys());
}

function runScript(name: string, scriptRelativePath: string) {
    runProcess(name, 'npx', ['tsx', resolveScript(scriptRelativePath)]);
}

function runNodeScript(name: string, scriptRelativePath: string) {
    runProcess(name, 'node', [resolveScript(scriptRelativePath)]);
}

export const runner = isDev ? runScript : runNodeScript;

export function runScrapingTasks() {
    if (process.env.SCRAPER_API_URL) {
        console.log(`[${new Date().toISOString()}] [Cron] SCRAPER_API_URL défini, scraping délégué au scraper distant`);
        return;
    }
    console.log(`[${new Date().toISOString()}] [Cron] Lancement des tâches de scraping...`);
    runner('Scraping Films', 'scraping/core/scrape-films.js');
    runner('Scraping Séries', 'scraping/core/scrape-series.js');
}

export function runMaintenanceTasks() {
    if (process.env.SCRAPER_API_URL) {
        console.log(`[${new Date().toISOString()}] [Cron] SCRAPER_API_URL défini, maintenance déléguée au scraper distant`);
        return;
    }
    console.log(`[${new Date().toISOString()}] [Cron] Lancement des tâches de maintenance...`);
    runner('Vérification Liens Morts', 'scraping/maintenance/check-all-links.js');
    runner('Maintenance Liens', 'scraping/maintenance/maintainer.js');
    runner('Linking TMDB Films', 'scraping/maintenance/link-movies-tmdb.js');
    runner('Linking TMDB Séries', 'scraping/maintenance/link-series-tmdb.js');
    runner('Organize Séries Doodstream', 'scraping/maintenance/organize-series.js');
    runner('Sync Séries → MongoDB', 'scraping/maintenance/sync-series-to-mongo.js');
}

export function startCron() {
    if (isRunning) return;
    cronTasks = [
        cron.schedule('*/10 * * * *', runMaintenanceTasks),
        cron.schedule('0 3 * * *', runScrapingTasks),
    ];
    isRunning = true;
    appendLog('[Cron] Tâches planifiées démarrées (toutes les 10min + scraping 03:00)');
    console.log('[Cron] Tâches planifiées démarrées.');
}

export function stopCron() {
    if (!isRunning) return;
    cronTasks.forEach(t => t.stop());
    cronTasks = [];
    isRunning = false;
    appendLog('[Cron] Tâches planifiées arrêtées');
    console.log('[Cron] Tâches planifiées arrêtées.');
}

export function getCronStatus() {
    return { running: isRunning, tasks: cronTasks.length };
}
