import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { appendLog } from './config/log-buffer';

const isDev = process.env.NODE_ENV !== 'production';

const runningProcesses: Map<string, ChildProcess> = new Map();

// Répertoire des fichiers PID : <backend>/.runtime/
const RUNTIME_DIR = path.join(__dirname, '..', '.runtime');
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); } catch { /* déjà là */ }

// Délai d'attente entre SIGTERM et SIGKILL lors d'un arrêt graceful.
const GRACEFUL_KILL_MS = 5000;

// Mapping centralisé : nom logique → chemin du script
// Sert à la fois au scheduler et à l'endpoint POST /admin/cron/run/:taskName
export const ALL_TASKS: Record<string, { label: string; path: string; command: 'tsx' | 'node' }> = {
    'scraping-films':           { label: 'Scraping Films',            path: 'scraping/core/scrape-films.ts',                 command: 'tsx' },
    'scraping-series':          { label: 'Scraping Séries',           path: 'scraping/core/scrape-series.ts',                command: 'tsx' },
    'scraping-animes':          { label: 'Scraping Animes',           path: 'scraping/core/scrape-animes.ts',                command: 'tsx' },
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
    'keepalive-uqload':         { label: 'KeepAlive Uqload',          path: 'scraping/maintenance/keepalive-uqload.ts',         command: 'tsx' },
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

function resolveScript(relativePath: string): { command: string; args: string[] } {
    const isProd = process.env.NODE_ENV === 'production' || __dirname.includes('dist');

    if (isProd) {
        const jsRel = relativePath.replace(/\.ts$/, '.js');
        const distPath = path.join(__dirname, jsRel);
        if (fs.existsSync(distPath)) {
            return { command: 'node', args: [distPath] };
        }
    }

    let fullPath = path.join(__dirname, relativePath);
    if (fs.existsSync(fullPath)) {
        if (fullPath.endsWith('.js')) return { command: 'node', args: [fullPath] };
        return { command: 'npx', args: ['tsx', fullPath] };
    }

    const tsPath = fullPath.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsPath)) {
        return { command: 'npx', args: ['tsx', tsPath] };
    }

    const jsPath = fullPath.replace(/\.ts$/, '.js');
    if (fs.existsSync(jsPath)) {
        return { command: 'node', args: [jsPath] };
    }

    const distFallback = fullPath.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
    if (fs.existsSync(distFallback)) {
        return { command: 'node', args: [distFallback] };
    }

    const srcFallback = fullPath.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
    if (fs.existsSync(srcFallback)) {
        return { command: 'npx', args: ['tsx', srcFallback] };
    }

    return { command: 'node', args: [fullPath] };
}

function killTree(child: ChildProcess | { pid: number }, graceMs = GRACEFUL_KILL_MS): Promise<boolean> {
    const pid = (child as any).pid;
    if (!pid || !Number.isFinite(pid) || pid <= 0) return Promise.resolve(false);

    const pgid = -pid;
    return new Promise((resolve) => {
        try { process.kill(pgid, 'SIGTERM'); } catch { }
        const killTimer = setTimeout(() => {
            if (isPidAlive(pid)) {
                try { process.kill(pgid, 'SIGKILL'); } catch { }
            }
            resolve(isPidAlive(pid));
        }, graceMs);
        try {
            (child as any).once?.('exit', () => {
                clearTimeout(killTimer);
                resolve(false);
            });
        } catch { }
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
    const resolved = resolveScript(scriptRelativePath);
    runProcess(name, resolved.command, resolved.args);
}

function runNodeScript(name: string, scriptRelativePath: string) {
    const resolved = resolveScript(scriptRelativePath);
    runProcess(name, resolved.command, resolved.args);
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
    for (const [name, child] of runningProcesses) {
        if (child.pid && isPidAlive(child.pid)) {
            out.add(name);
        } else {
            runningProcesses.delete(name);
        }
    }
    return Array.from(out);
}

export function listOsProcesses(): Array<{ label: string; pid: number; cmd: string }> {
    const results: Array<{ label: string; pid: number; cmd: string }> = [];
    for (const [label, child] of runningProcesses) {
        if (child.pid && isPidAlive(child.pid)) {
            results.push({ label, pid: child.pid, cmd: `node/tsx ${label}` });
        }
    }
    return results;
}

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

/**
 * Le cron automatique est désormais géré par GitHub Actions.
 * Ces fonctions restent disponibles pour l'admin panel (déclenchement manuel).
 */
