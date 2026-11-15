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
    // strip leading "./" segments (and a lone "."), but keep ".." and dot-dirs such as ".config"
    return dir.trim().replace(/\\/g, '/').replace(/^(\.(\/+|$))+/, '').replace(/^\/+|\/+$/g, '');
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

/** True when `target` is `root` itself or somewhere below it. */
export function isInside(root: string, target: string): boolean {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Read the `workspaces` patterns of a package.json (npm array form or yarn `{ packages: [...] }` form). */
async function readWorkspaces(packageJsonPath: string): Promise<string[] | undefined> {
    try {
        const json = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
        const ws = json?.workspaces;
        const patterns = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : undefined;
        return patterns && patterns.length > 0 ? patterns : undefined;
    } catch {
        return undefined; // unreadable / invalid package.json: treat as a normal project
    }
}

export type WorkspaceFilterResult = {
    /** Dirs to install. */
    dirs: string[];
    /** Dirs left out because a workspace root above them installs them. */
    skipped: { dir: string; workspaceRoot: string }[];
};

/** Expand `{a,b}` groups (nesting allowed): "{apps,libs}/*" -> ["apps/*", "libs/*"]. */
export function expandBraces(pattern: string): string[] {
    const open = pattern.indexOf('{');
    if (open === -1) {
        return [pattern];
    }
    let depth = 0;
    const commas: number[] = [];
    for (let i = open; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '{') {
            depth++;
        } else if (c === '}' && --depth === 0) {
            const parts: string[] = [];
            let start = open + 1;
            for (const comma of [...commas, i]) {
                parts.push(pattern.slice(start, comma));
                start = comma + 1;
            }
            const rest = expandBraces(pattern.slice(i + 1));
            return parts.flatMap(part => expandBraces(pattern.slice(0, open) + part))
                .flatMap(head => rest.map(tail => head + tail));
        } else if (c === ',' && depth === 1) {
            commas.push(i);
        }
    }
    return [pattern]; // unbalanced: treat literally
}

/** Glob segment ("pkg-*", "[ab]?") -> RegExp for one path segment. */
function segmentRegExp(segment: string): RegExp {
    let re = '';
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (c === '*') {
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '[') {
            const close = segment.indexOf(']', i + 2);
            if (close === -1) {
                re += '\\[';
            } else {
                const body = segment.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
                re += `[${body}]`;
                i = close;
            }
        } else {
            re += c.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

/**
 * Match a relative dir ("packages/a") against one workspace glob, segment by segment:
 * `*` / `?` / `[...]` within a segment, `**` = zero or more segments, `{a,b}` alternatives.
 * Dot-dirs are never matched by wildcards (they are never collected by findDirsWithFile anyway).
 */
export function matchWorkspacePattern(dir: string, pattern: string): boolean {
    const dirSegs = dir === '' ? [] : dir.split('/');
    return expandBraces(pattern).some(expanded => {
        const patSegs = normalizeDir(expanded).split('/').filter(s => s !== '' && s !== '.');
        if (patSegs.length === 0 || patSegs.includes('..')) {
            return false; // the root itself / outside the workspace root: never a member here
        }
        const match = (pi: number, di: number): boolean => {
            if (pi === patSegs.length) {
                return di === dirSegs.length;
            }
            if (patSegs[pi] === '**') {
                for (let k = di; k <= dirSegs.length; k++) {
                    if (match(pi + 1, k)) { return true; }
                }
                return false;
            }
            return di < dirSegs.length && segmentRegExp(patSegs[pi]).test(dirSegs[di]) && match(pi + 1, di + 1);
        };
        return match(0, 0);
    });
}

/** True when `dir` (relative to its workspace root) is a member: matches a pattern and no `!negation`. */
function isWorkspaceMember(dir: string, patterns: string[]): boolean {
    const positive = patterns.filter(p => !p.startsWith('!'));
    const negative = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1));
    return positive.some(p => matchWorkspacePattern(dir, p)) && !negative.some(p => matchWorkspacePattern(dir, p));
}

/**
 * Leave out dirs that are members of an npm / yarn workspace (monorepo) found in `dirs`.
 * `npm install` at the workspace root installs its members, and running npm inside a member
 * at the same time would make two npm processes write the same node_modules.
 *
 * Only dirs matched by the root's `workspaces` globs are left out (globs are matched against
 * the found dirs, not expanded on disk). Other dirs below the workspace root, e.g. "tools" or
 * "packages/a/examples/demo", are independent projects and are kept.
 */
export async function excludeWorkspaceMembers(root: string, dirs: string[]): Promise<WorkspaceFilterResult> {
    const normalized = [...new Set(dirs.map(normalizeDir))].sort();
    const relativeTo = (dir: string, parent: string): string | undefined =>
        parent === '' ? (dir === '' ? undefined : dir) : dir.startsWith(`${parent}/`) ? dir.slice(parent.length + 1) : undefined;

    const workspaces = (await Promise.all(normalized.map(async dir => ({
        workspaceRoot: dir,
        patterns: ((await readWorkspaces(path.join(root, dir, 'package.json'))) ?? []).filter((p): p is string => typeof p === 'string'),
    })))).filter(w => w.patterns.length > 0);

    const result: WorkspaceFilterResult = { dirs: [], skipped: [] };
    for (const dir of normalized) {
        // `normalized` is sorted, so the outermost workspace root comes first
        const owner = workspaces.find(w => {
            const rel = relativeTo(dir, w.workspaceRoot);
            return rel !== undefined && isWorkspaceMember(rel, w.patterns);
        })?.workspaceRoot;
        if (owner === undefined) {
            result.dirs.push(dir);
        } else {
            result.skipped.push({ dir, workspaceRoot: owner });
        }
    }
    return result;
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

type NpmRunResult = { code: number | null; output: string; error?: string };

/** AbortSignal is an EventTarget at runtime (Node >= 15), but @types/node 16 does not declare it. */
type AbortEvents = {
    addEventListener(type: 'abort', listener: () => void): void;
    removeEventListener(type: 'abort', listener: () => void): void;
};

/** Time to wait after SIGTERM before force-killing the process group (POSIX). */
const KILL_GRACE_MS = 5000;
/** After cancel, stop waiting for 'close' after this long (a process that escaped the tree may keep the pipes open). */
const CANCEL_SETTLE_MS = KILL_GRACE_MS + 2000;

/**
 * Run `npm install` asynchronously in `cwd`. Never throws; failures are reported in the result.
 *
 * On cancel the whole process tree is killed (not only the direct child), and the promise
 * resolves only after the process has actually exited, so a re-run never overlaps a
 * still-running npm in the same folder.
 */
function runNpmInstall(cwd: string, npmCommand: string, abortSignal?: AbortSignal): Promise<NpmRunResult> {
    const signal = abortSignal as (AbortSignal & AbortEvents) | undefined;
    return new Promise(resolve => {
        const isWin = process.platform === 'win32';
        let output = '';
        let settled = false;
        let settleTimer: NodeJS.Timeout | undefined;

        const done = (r: NpmRunResult) => {
            if (settled) { return; }
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            if (settleTimer) { clearTimeout(settleTimer); }
            resolve(r);
        };

        // npm is a .cmd file on Windows and needs a shell there. With a shell the command line is
        // joined unescaped, so quote a command path containing spaces (only used by tests).
        const command = isWin && /\s/.test(npmCommand) && !npmCommand.startsWith('"') ? `"${npmCommand}"` : npmCommand;
        const child = spawn(command, ['install'], {
            cwd,
            shell: isWin,
            // POSIX: own process group so the whole tree (npm + lifecycle scripts) can be killed at once
            detached: !isWin,
            windowsHide: true,
            env: process.env,
        });

        const killTree = (sig: NodeJS.Signals) => {
            if (child.pid === undefined) { return; }
            if (isWin) {
                if (child.exitCode !== null || child.signalCode !== null) { return; }
                // /T kills cmd.exe and every descendant (npm -> node -> scripts)
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
                    .on('error', () => { /* taskkill unavailable: nothing more we can do */ });
            } else {
                // signal the whole process group even if npm itself has already exited:
                // lifecycle scripts it started may still be running in the group
                try { process.kill(-child.pid, sig); } catch { /* group already gone (ESRCH) */ }
            }
        };

        function onAbort() {
            killTree('SIGTERM');
            if (!isWin) {
                // runs even after 'close', so a member that ignores SIGTERM is still killed;
                // unref: never keep the process alive just for this
                setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
            }
            settleTimer = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                done({ code: null, output, error: 'cancelled' });
            }, CANCEL_SETTLE_MS);
        }

        if (signal?.aborted) { onAbort(); } else { signal?.addEventListener('abort', onAbort); }

        // decode as a stream so multi-byte characters split across chunks are not garbled
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (s: string) => { output += s; });
        child.stderr?.on('data', (s: string) => { output += s; });
        // 'error' without 'close' happens when the process could not be started
        child.on('error', err => { if (child.pid === undefined) { done({ code: null, output, error: err.message }); } });
        child.on('close', code => done({ code, output }));
    });
}

/** Install one directory. Never throws. */
export async function installDir(projectPath: string, dir: string, options: InstallOptions): Promise<InstallResult> {
    const absPath = path.join(projectPath, dir);
    const started = Date.now();
    const result = (success: boolean, output: string, error?: string): InstallResult =>
        ({ dir, absPath, success, output, error, durationMs: Date.now() - started });

    // never touch (and with cleanInstall, delete) anything outside the project, e.g. "../other"
    if (!isInside(projectPath, absPath)) {
        return result(false, '', `directory is outside the project: ${dir}`);
    }

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

    if (options.signal?.aborted) {
        return result(false, '', 'cancelled'); // cancelled while cleaning: don't start npm at all
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
        let res: InstallResult;
        if (options.signal?.aborted) {
            // cancelled before this dir started: don't report a start, but still count it as finished
            res = { dir, absPath: path.join(projectPath, dir), success: false, output: '', durationMs: 0, error: 'cancelled' };
        } else {
            options.onStart?.(dir);
            res = await installDir(projectPath, dir, options);
        }
        finished++;
        options.onFinish?.(res, finished, uniqueDirs.length);
        return res;
    });
}
