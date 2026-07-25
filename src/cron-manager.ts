import cron, { ScheduledTask } from 'node-cron';
import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { appendLog } from './config/log-buffer';

const isDev = process.env.NODE_ENV !== 'production';

let cronTasks: ScheduledTask[] = [];
let isRunning = false;
const runningProcesses: Map<string, ChildProcess> = new Map();

// Répertoire des fichiers PID : <backend>/.runtime/
const RUNTIME_DIR = path.join(__dirname, '..', '.runtime');
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); } catch { /* déjà là */ }

// Délai d'attente entre SIGTERM et SIGKILL lors d'un arrêt graceful.
const GRACEFUL_KILL_MS = 5000;

// Mapping centralisé : nom logique → chemin du script
// Sert à la fois au scheduler et à l'endpoint POST /admin/cron/run/:taskName
export const ALL_TASKS: Record<string, { label: string; path: string; command: 'tsx' | 'node' }> = {
    'scraping-films':           { label: 'Scraping Films',            path: 'scraping/core/scrape-films.js',                 command: 'node' },
    'scraping-series':          { label: 'Scraping Séries',           path: 'scraping/core/scrape-series.ts',                command: 'tsx' },
    'maintenance-liens':        { label: 'Maintenance Liens',         path: 'scraping/maintenance/maintainer.ts',           command: 'tsx' },
    'reparation-films':         { label: 'Réparation Films',          path: 'scraping/maintenance/maintainer-movies.ts',    command: 'tsx' },
    'check-all-links':          { label: 'Vérification Liens Morts',  path: 'scraping/maintenance/check-all-links.ts',      command: 'tsx' },
    'link-movies-tmdb':         { label: 'Linking TMDB Films',        path: 'scraping/maintenance/link-movies-tmdb.ts',     command: 'tsx' },
    'link-series-tmdb':         { label: 'Linking TMDB Séries',       path: 'scraping/maintenance/link-series-tmdb.ts',     command: 'tsx' },
    'organize-series':          { label: 'Organize Séries Doodstream', path: 'scraping/maintenance/organize-series.ts',     command: 'tsx' },
    'sync-series-mongo':        { label: 'Sync Séries → MongoDB',     path: 'scraping/maintenance/sync-series-to-mongo.ts', command: 'tsx' },
    'fix-series-seasons':       { label: 'Fix Seasons Séries',        path: 'scraping/maintenance/fix-series-seasons.ts',   command: 'tsx' },
    'upload-doodstream-movies': { label: 'Upload Films DoodStream',   path: 'scraping/maintenance/upload-doodstream.ts',    command: 'tsx' },
    'upload-doodstream-series': { label: 'Upload Séries DoodStream',  path: 'scraping/maintenance/upload-series-doodstream.ts', command: 'tsx' },
    'link-movies':              { label: 'Link Movies (legacy)',      path: 'scripts/link-movies-tmdb.ts',                  command: 'tsx' },
    'link-series':              { label: 'Link Series (legacy)',      path: 'scripts/link-series-tmdb.ts',                  command: 'tsx' },
};

function pidFileFor(name: string): string {
    return path.join(RUNTIME_DIR, `${name}.pid`);
}

function readPidFile(name: string): number | null {
    try {
        const raw = fs.readFileSync(pidFileFor(name), 'utf8').trim();
        const pid = parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;
        return pid;
    } catch {
        return null;
    }
}

function writePidFile(name: string, pid: number): void {
    try { fs.writeFileSync(pidFileFor(name), String(pid), 'utf8'); } catch { /* best effort */ }
}

function clearPidFile(name: string): void {
    try { fs.unlinkSync(pidFileFor(name)); } catch { /* déjà supprimé */ }
}

function isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        // kill(pid, 0) ne fait que tester l'existence du process, sans signal.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function resolveScript(relativePath: string): string {
    let fullPath = path.join(__dirname, relativePath);
    const tsPath = fullPath.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsPath)) return tsPath;
    return fullPath;
}

/**
 * Tue un arbre de process complet (le PGID du child + tous ses descendants).
 * SIGTERM d'abord, attend `graceMs`, puis SIGKILL si toujours vivant.
 */
function killTree(child: ChildProcess | { pid: number }, graceMs = GRACEFUL_KILL_MS): Promise<boolean> {
    const pid = (child as any).pid;
    if (!pid || !Number.isFinite(pid) || pid <= 0) return Promise.resolve(false);

    const pgid = -pid; // PGID = -PID quand detached: true
    return new Promise((resolve) => {
        try { process.kill(pgid, 'SIGTERM'); } catch { /* le groupe peut déjà être mort */ }
        const killTimer = setTimeout(() => {
            if (isPidAlive(pid)) {
                try { process.kill(pgid, 'SIGKILL'); } catch { /* ignore */ }
            }
            resolve(isPidAlive(pid));
        }, graceMs);
        // Si le process exit avant le timer, on résout immédiatement.
        try {
            (child as any).once?.('exit', () => {
                clearTimeout(killTimer);
                resolve(false);
            });
        } catch { /* ChildProcess-like sans .once, pas grave */ }
    });
}

function runProcess(name: string, command: string, args: string[]) {
    const startTime = new Date().toISOString();
    const header = `[Cron] Lancement : ${name}`;
    console.log(`[${startTime}] ${header}`);
    appendLog(header);

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) writePidFile(name, child.pid);
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
        clearPidFile(name);
        const endTime = new Date().toISOString();
        const msg = code === 0
            ? `[Cron] Terminé avec succès : ${name}`
            : `[Cron] ERREUR : ${name} (code: ${code})`;
        console.log(`[${endTime}] ${msg}`);
        appendLog(msg);
    });
}

function runScript(name: string, scriptRelativePath: string) {
    runProcess(name, 'npx', ['tsx', resolveScript(scriptRelativePath)]);
}

function runNodeScript(name: string, scriptRelativePath: string) {
    runProcess(name, 'node', [resolveScript(scriptRelativePath)]);
}

export const runner = runScript;

/**
 * Lance une tâche connue (par son label lisible) en utilisant ALL_TASKS.
 * Si la tâche est déjà en cours, ne fait rien et retourne false.
 */
export function runTaskByLabel(label: string): boolean {
    const entry = Object.values(ALL_TASKS).find(t => t.label === label);
    if (!entry) {
        appendLog(`[Cron] Tâche inconnue : ${label}`);
        return false;
    }
    if (isTaskRunning(label)) {
        appendLog(`[Cron] Tâche déjà en cours : ${label}`);
        return false;
    }
    if (entry.command === 'node') {
        runNodeScript(entry.label, entry.path);
    } else {
        runScript(entry.label, entry.path);
    }
    return true;
}

/**
 * Lance une tâche par son identifiant (clé ALL_TASKS).
 */
export function runTaskById(id: string): boolean {
    const entry = ALL_TASKS[id];
    if (!entry) return false;
    if (isTaskRunning(entry.label)) return false;
    if (entry.command === 'node') {
        runNodeScript(entry.label, entry.path);
    } else {
        runScript(entry.label, entry.path);
    }
    return true;
}

/**
 * Source de vérité OS : scanne les process vivants et retourne
 * la liste des labels connus en cours d'exécution.
 */
export function getRunningTasks(): string[] {
    const out = new Set<string>();
    // 1. Process trackés par le backend (et toujours vivants)
    for (const [name, child] of runningProcesses) {
        if (child.pid && isPidAlive(child.pid)) out.add(name);
        else runningProcesses.delete(name);
    }
    // 2. Process orphelins (lancés hors backend mais matchant une signature connue)
    for (const entry of Object.values(ALL_TASKS)) {
        if (out.has(entry.label)) continue;
        if (scanProcessForLabel(entry.label)) out.add(entry.label);
    }
    return Array.from(out);
}

/**
 * Liste brute des process OS qui matchent une signature de scraper.
 * Utile pour le panneau debug et pour détecter des fantômes.
 */
export function listOsProcesses(): Array<{ label: string; pid: number; cmd: string }> {
    const results: Array<{ label: string; pid: number; cmd: string }> = [];
    let lines: string;
    try {
        // ps -eo pid,cmd pour avoir PID + commande
        lines = execSync('ps -eo pid=,cmd=', { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    } catch {
        return results;
    }
    for (const raw of lines.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const cmd = match[2];
        for (const entry of Object.values(ALL_TASKS)) {
            // On détecte via le chemin du script dans la commande
            const scriptBasename = entry.path.split('/').pop()?.replace(/\.ts$/, '').replace(/\.js$/, '');
            if (!scriptBasename) continue;
            if (cmd.includes(scriptBasename) && (cmd.includes('tsx') || cmd.includes('node'))) {
                results.push({ label: entry.label, pid, cmd });
                break;
            }
        }
    }
    return results;
}

function scanProcessForLabel(label: string): boolean {
    const entry = Object.values(ALL_TASKS).find(t => t.label === label);
    if (!entry) return false;
    const scriptBasename = entry.path.split('/').pop()?.replace(/\.ts$/, '').replace(/\.js$/, '');
    if (!scriptBasename) return false;
    try {
        const out = execSync(`ps -eo pid=,cmd=`, { encoding: 'utf8' });
        return out.split('\n').some(line => {
            const l = line.trim();
            return l && l.includes(scriptBasename) && (l.includes('tsx') || l.includes('node'));
        });
    } catch {
        return false;
    }
}

/**
 * Indique si une tâche est en cours (basé sur la source de vérité OS).
 */
export function isTaskRunning(label: string): boolean {
    return getRunningTasks().includes(label);
}

/**
 * Tente un arrêt SIGTERM→SIGKILL d'une tâche par son label.
 * Retourne true si le process a été tué.
 */
export async function stopTask(name: string): Promise<boolean> {
    const tracked = runningProcesses.get(name);
    if (tracked && tracked.pid) {
        const stillAlive = await killTree(tracked);
        if (!stillAlive) {
            runningProcesses.delete(name);
            clearPidFile(name);
            appendLog(`[Admin] Arrêt demandé et effectué : ${name}`);
            return true;
        }
    }
    // Fallback : si le process est orphelin (PID dans le fichier mais pas dans la Map)
    const pid = readPidFile(name);
    if (pid && isPidAlive(pid)) {
        const stillAlive = await killTree({ pid });
        if (!stillAlive) {
            clearPidFile(name);
            appendLog(`[Admin] Arrêt orphelin effectué : ${name} (pid ${pid})`);
            return true;
        }
        return false;
    }
    appendLog(`[Admin] Aucune tâche en cours à arrêter : ${name}`);
    return false;
}

/**
 * Tente un arrêt par PID (pour les fantômes non trackés).
 */
export async function stopByPid(pid: number): Promise<boolean> {
    if (!isPidAlive(pid)) return false;
    const stillAlive = await killTree({ pid });
    appendLog(`[Admin] Kill orphelin pid ${pid} → ${stillAlive ? 'échec' : 'OK'}`);
    return !stillAlive;
}

/**
 * Détecte la présence d'une crontab système qui appelle nos anciens scripts.
 */
export function getSystemCronStatus(): { present: boolean; lines: string[] } {
    try {
        const out = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
        const allLines = out.split('\n').map(l => l.trim()).filter(Boolean);
        const relevant = allLines.filter(l =>
            l.includes('cron-link-') || l.includes('CHILLERS') || l.includes('tsx src/scripts/')
        );
        return { present: relevant.length > 0, lines: relevant };
    } catch {
        return { present: false, lines: [] };
    }
}

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
    runner('Vérification Liens Morts', 'scraping/maintenance/check-all-links.ts');
    runner('Maintenance Liens', 'scraping/maintenance/maintainer.ts');
    runner('Linking TMDB Films', 'scraping/maintenance/link-movies-tmdb.ts');
    runner('Linking TMDB Séries', 'scraping/maintenance/link-series-tmdb.ts');
    runner('Organize Séries Doodstream', 'scraping/maintenance/organize-series.ts');
    runner('Sync Séries → MongoDB', 'scraping/maintenance/sync-series-to-mongo.ts');
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

export async function stopCron() {
    if (!isRunning) return;
    cronTasks.forEach(t => t.stop());
    cronTasks = [];
    isRunning = false;
    // Graceful kill de toutes les tâches en cours
    const entries = Array.from(runningProcesses.entries());
    await Promise.all(entries.map(async ([name, child]) => {
        if (child.pid) {
            await killTree(child);
        }
        runningProcesses.delete(name);
    }));
    appendLog('[Cron] Tâches planifiées arrêtées');
    console.log('[Cron] Tâches planifiées arrêtées.');
}

export function getCronStatus() {
    return { running: isRunning, tasks: cronTasks.length };
}

// ── Tâches de déploiement (exécutées une fois par déploiement) ──────────────
const DEPLOY_LOCK = path.join(RUNTIME_DIR, 'deploy-uqload.done');

/** Résout un script (dist .js en prod, src .ts en dev) sous dist|src/scripts/. */
function resolveDeployScript(base: string): { cmd: string; args: string[] } | null {
    const tsPath = path.join(__dirname, 'scripts', `${base}.ts`);
    const jsPath = path.join(__dirname, 'scripts', `${base}.js`);
    if (fs.existsSync(tsPath)) return { cmd: 'npx', args: ['tsx', tsPath] };
    if (fs.existsSync(jsPath)) return { cmd: 'node', args: [jsPath] };
    return null;
}

/** Spawn synchrone-attendable d'un script one-shot ; log stdout/stderr. */
function spawnOnce(name: string, cmd: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (data) => {
            for (const line of data.toString().split('\n').filter((l: string) => l)) {
                const msg = `[${name}] ${line}`;
                console.log(msg);
                appendLog(msg);
            }
        });
        child.stderr?.on('data', (data) => {
            for (const line of data.toString().split('\n').filter((l: string) => l)) {
                const msg = `[${name}] ${line}`;
                console.error(msg);
                appendLog(msg);
            }
        });
        child.on('close', (code) => resolve(code ?? -1));
        child.on('error', (err) => {
            appendLog(`[${name}] erreur de lancement : ${err.message}`);
            resolve(-1);
        });
    });
}

/**
 * Migration DoodStream → Uqload lancée UNE fois par déploiement, en arrière-plan
 * (ne bloque pas le démarrage du serveur) :
 *   1. migrate-dood-to-uqload  (upload distant → remplit uqloadCode)
 *   2. upload-uqload --verify  (résout les liens directs quand le fichier est prêt)
 *
 * - Désactivable via RUN_UQLOAD_MIGRATION_ON_DEPLOY=false.
 * - Ignorée si UQLOAD_API_KEY absente.
 * - Un fichier verrou dans .runtime/ garantit "une fois par déploiement"
 *   (le disque Render est recréé à chaque déploiement, mais un simple restart
 *   du process ne relance donc pas la migration).
 */
export async function runDeployTasksOnce(): Promise<void> {
    if (process.env.RUN_UQLOAD_MIGRATION_ON_DEPLOY === 'false') {
        console.log('[Deploy] Migration Uqload désactivée (RUN_UQLOAD_MIGRATION_ON_DEPLOY=false).');
        return;
    }
    if (!process.env.UQLOAD_API_KEY) {
        console.log('[Deploy] UQLOAD_API_KEY absente → migration Uqload ignorée.');
        return;
    }
    if (fs.existsSync(DEPLOY_LOCK)) {
        console.log('[Deploy] Migration Uqload déjà exécutée pour ce déploiement.');
        return;
    }
    try { fs.writeFileSync(DEPLOY_LOCK, new Date().toISOString(), 'utf8'); } catch { /* best effort */ }

    const migrate = resolveDeployScript('migrate-dood-to-uqload');
    const upload = resolveDeployScript('upload-uqload');
    if (!migrate || !upload) {
        appendLog('[Deploy] Scripts Uqload introuvables → migration ignorée.');
        return;
    }

    appendLog('[Deploy] Migration DoodStream → Uqload (une fois)…');
    await spawnOnce('deploy-migrate-uqload', migrate.cmd, migrate.args);
    await spawnOnce('deploy-verify-uqload', upload.cmd, [...upload.args, '--verify']);
    appendLog('[Deploy] Migration Uqload terminée.');
}
