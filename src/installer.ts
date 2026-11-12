import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export type InstallOptions = {
    /** Remove node_modules and package-lock.json before installing (previous behavior). */
    cleanInstall: boolean;
    /** Max number of `npm install` processes running at the same time. 0 or less = auto. */
    concurrency: number;
    /** Abort running / pending installs. */
    signal?: AbortSignal;
    /** Called when an install starts. */
    onStart?: (dir: string) => void;
    /** Called when an install finishes (success or failure). */
    onFinish?: (result: InstallResult, finished: number, total: number) => void;
    /** Overrides the npm command (for tests). */
    npmCommand?: string;
};

export type InstallResult = {
    /** Directory relative to the project root ('' = project root). */
    dir: string;
    /** Absolute directory path. */
    absPath: string;
    success: boolean;
    /** Combined stdout / stderr of the install. */
    output: string;
    durationMs: number;
    error?: string;
};

const SKIP_DIRS = new Set(['node_modules']);

/** Default parallelism: number of CPUs, capped at 4 to avoid hammering the network / disk. */
export function defaultConcurrency(): number {
    return Math.max(1, Math.min(os.cpus().length, 4));
}

/** Normalize a user / setting supplied relative dir ('' = root, strip slashes, unify separators). */
export function normalizeDir(dir: string): string {
    return dir.trim().replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '');
}

/**
 * Recursively find every directory (relative to `root`) that contains `targetFileName`.
 * Skips node_modules and dot-directories. Sub directories are scanned in parallel.
 * Returns sorted, de-duplicated relative paths using '/' ('' = root).
 */
export async function findDirsWithFile(root: string, targetFileName = 'package.json'): Promise<string[]> {
    const results: string[] = [];

    async function walk(rel: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
        } catch {
            return; // unreadable directory: ignore
        }
        const subDirs: Promise<void>[] = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
                continue;
            }
            const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                subDirs.push(walk(childRel));
            } else if (entry.isFile() && entry.name === targetFileName) {
                results.push(rel);
            }
        }
        await Promise.all(subDirs);
    }

    await walk('');
    return [...new Set(results)].sort();
}

/** Run `worker` over `items` with at most `limit` running concurrently. Keeps input order in the result. */
export async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}

/** Run `npm install` asynchronously in `cwd`. Never throws; failures are reported in the result. */
function runNpmInstall(cwd: string, npmCommand: string, signal?: AbortSignal): Promise<{ code: number | null; output: string; error?: string }> {
    return new Promise(resolve => {
        let output = '';
        const child = spawn(npmCommand, ['install'], {
            cwd,
            // npm is a .cmd file on Windows and needs a shell there
            shell: process.platform === 'win32',
            env: process.env,
            signal,
        });
        child.stdout?.on('data', chunk => { output += chunk.toString(); });
        child.stderr?.on('data', chunk => { output += chunk.toString(); });
        child.on('error', err => resolve({ code: null, output, error: err.message }));
        child.on('close', code => resolve({ code, output }));
    });
}

/** Install one directory. Never throws. */
export async function installDir(projectPath: string, dir: string, options: InstallOptions): Promise<InstallResult> {
    const absPath = path.join(projectPath, dir);
    const started = Date.now();
    const result = (success: boolean, output: string, error?: string): InstallResult =>
        ({ dir, absPath, success, output, error, durationMs: Date.now() - started });

    try {
        const stat = await fs.stat(path.join(absPath, 'package.json'));
        if (!stat.isFile()) {
            return result(false, '', `package.json not found in ${absPath}`);
        }
    } catch {
        return result(false, '', `package.json not found in ${absPath}`);
    }

    if (options.signal?.aborted) {
        return result(false, '', 'cancelled');
    }

    if (options.cleanInstall) {
        try {
            await Promise.all([
                fs.rm(path.join(absPath, 'node_modules'), { recursive: true, force: true, maxRetries: 3 }),
                fs.rm(path.join(absPath, 'package-lock.json'), { force: true }),
            ]);
        } catch (err: any) {
            return result(false, '', `failed to clean: ${err?.message ?? err}`);
        }
    }

    const npm = options.npmCommand ?? 'npm';
    const { code, output, error } = await runNpmInstall(absPath, npm, options.signal);
    if (options.signal?.aborted) {
        return result(false, output, 'cancelled');
    }
    if (error) {
        return result(false, output, error);
    }
    return code === 0 ? result(true, output) : result(false, output, `npm install exited with code ${code}`);
}

/**
 * Install all given directories in parallel (bounded by `options.concurrency`).
 * Duplicate directories are removed so the same folder is never installed twice at once.
 * A failure in one directory does not stop the others.
 */
export async function installDirs(projectPath: string, dirs: string[], options: InstallOptions): Promise<InstallResult[]> {
    const uniqueDirs = [...new Set(dirs.map(normalizeDir))];
    const limit = options.concurrency > 0 ? options.concurrency : defaultConcurrency();
    let finished = 0;
    return runWithConcurrency(uniqueDirs, limit, async dir => {
        options.onStart?.(dir);
        const res = await installDir(projectPath, dir, options);
        finished++;
        options.onFinish?.(res, finished, uniqueDirs.length);
        return res;
    });
}
