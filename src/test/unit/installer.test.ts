/*
 * Tests for src/installer.ts that run outside VS Code.
 * They use the REAL npm and the public registry to check that installs actually work.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs, readFileSync, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { excludeWorkspaceMembers, expandBraces, findDirsWithFile, installDirs, isInside, matchWorkspacePattern, normalizeDir, runWithConcurrency } from '../../installer';

const isWin = process.platform === 'win32';

async function writeJson(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function pkg(name: string, dependencies: Record<string, string>) {
    return { name, version: '1.0.0', private: true, dependencies };
}

function installedVersion(dir: string, dep: string): string {
    return JSON.parse(readFileSync(path.join(dir, 'node_modules', dep, 'package.json'), 'utf8')).version;
}

/** `npm ls --all` exits non-zero if the tree is broken / missing / invalid. */
function npmLsOk(dir: string): void {
    execFileSync('npm', ['ls', '--all'], { cwd: dir, stdio: 'pipe', shell: isWin });
}

type FakeNpmOptions = {
    /** How long the fake npm itself runs. */
    sleepMs: number;
    /** Start a CHILD process that writes `MARKER` into the cwd after this delay. */
    markerAfterMs?: number;
    /** The child ignores SIGTERM (needs SIGKILL / taskkill /F). */
    childIgnoresSigterm?: boolean;
    /** The child inherits stdout/stderr, so 'close' only fires when the child is gone. */
    childInheritsStdio?: boolean;
};

/**
 * Create a fake `npm` command that works on every OS (a .cmd wrapper on Windows, a sh wrapper elsewhere).
 * The optional child is used to check that cancel kills the whole process tree.
 */
async function createFakeNpm(dir: string, name: string, opts: FakeNpmOptions): Promise<string> {
    const script = path.join(dir, `${name}.js`);
    const childCode = `${opts.childIgnoresSigterm ? "process.on('SIGTERM', () => {});" : ''}`
        + `setTimeout(() => require('fs').writeFileSync('MARKER', 'x'), ${opts.markerAfterMs});`;
    const child = opts.markerAfterMs === undefined ? '' : `
require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: ${opts.childInheritsStdio ? "'inherit'" : "'ignore'"} });`;
    await fs.writeFile(script, `${child}
setTimeout(() => console.log('installed'), ${opts.sleepMs});
`);
    if (isWin) {
        const cmd = path.join(dir, `${name}.cmd`);
        await fs.writeFile(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
        return cmd;
    }
    const sh = path.join(dir, `${name}.sh`);
    await fs.writeFile(sh, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    return sh;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let tmpRoot: string;

suite('installer', () => {
    suiteSetup(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-installs-test-'));
    });
    suiteTeardown(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    test('normalizeDir', () => {
        assert.strictEqual(normalizeDir(''), '');
        assert.strictEqual(normalizeDir('./'), '');
        assert.strictEqual(normalizeDir('/a/b/'), 'a/b');
        assert.strictEqual(normalizeDir('a\\b'), 'a/b');
        assert.strictEqual(normalizeDir('./a'), 'a');
        assert.strictEqual(normalizeDir(' a '), 'a');
        assert.strictEqual(normalizeDir('.'), '');
        assert.strictEqual(normalizeDir('././a/'), 'a');
        assert.strictEqual(normalizeDir('.config'), '.config');
        assert.strictEqual(normalizeDir('..'), '..');
        assert.strictEqual(normalizeDir('../other'), '../other');
    });

    test('findDirsWithFile finds nested dirs, skips node_modules and dot dirs', async () => {
        const root = path.join(tmpRoot, 'find');
        await writeJson(path.join(root, 'package.json'), {});
        await writeJson(path.join(root, 'a', 'package.json'), {});
        await writeJson(path.join(root, 'a', 'b', 'package.json'), {});
        await writeJson(path.join(root, 'c', 'd', 'e', 'package.json'), {});
        await writeJson(path.join(root, 'a', 'node_modules', 'x', 'package.json'), {});
        await writeJson(path.join(root, '.hidden', 'package.json'), {});
        await fs.mkdir(path.join(root, 'empty'));

        const dirs = await findDirsWithFile(root, 'package.json');
        assert.deepStrictEqual(dirs, ['', 'a', 'a/b', 'c/d/e']);
    });

    test('runWithConcurrency respects the limit and keeps order', async () => {
        let running = 0;
        let maxRunning = 0;
        const res = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async n => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(r => setTimeout(r, 30));
            running--;
            return n * 10;
        });
        assert.deepStrictEqual(res, [10, 20, 30, 40, 50, 60, 70]);
        assert.strictEqual(maxRunning, 3);
    });

    test('installs really run in parallel (fake npm sleeping 1s)', async function () {
        const root = path.join(tmpRoot, 'parallel');
        const fakeNpm = await createFakeNpm(tmpRoot, 'fake-npm', { sleepMs: 1000 });
        const dirs = ['p1', 'p2', 'p3', 'p4'];
        for (const d of dirs) { await writeJson(path.join(root, d, 'package.json'), pkg(d, {})); }

        let t = Date.now();
        const parallel = await installDirs(root, dirs, { cleanInstall: false, concurrency: 4, npmCommand: fakeNpm });
        const parallelMs = Date.now() - t;

        t = Date.now();
        const serial = await installDirs(root, dirs, { cleanInstall: false, concurrency: 1, npmCommand: fakeNpm });
        const serialMs = Date.now() - t;

        assert.ok(parallel.every(r => r.success) && serial.every(r => r.success));
        console.log(`      fake npm x4: parallel=${parallelMs}ms serial=${serialMs}ms`);
        assert.ok(parallelMs < 2500, `parallel took ${parallelMs}ms`);
        assert.ok(serialMs >= 4000, `serial took ${serialMs}ms`);
    });

    test('real npm install succeeds in multiple dirs in parallel (root + nested)', async () => {
        const root = path.join(tmpRoot, 'real');
        await writeJson(path.join(root, 'package.json'), pkg('root', { 'is-number': '7.0.0' }));
        await writeJson(path.join(root, 'front', 'package.json'), pkg('front', { 'chalk': '4.1.2' }));
        await writeJson(path.join(root, 'back', 'package.json'), pkg('back', { 'ms': '2.1.3' }));
        await writeJson(path.join(root, 'packages', 'lib', 'package.json'), pkg('lib', { 'is-odd': '3.0.1' }));

        const dirs = await findDirsWithFile(root);
        assert.deepStrictEqual(dirs, ['', 'back', 'front', 'packages/lib']);

        const started: string[] = [];
        const results = await installDirs(root, dirs, { cleanInstall: true, concurrency: 4, onStart: d => started.push(d) });

        for (const r of results) {
            assert.ok(r.success, `${r.dir} failed: ${r.error}\n${r.output}`);
            assert.ok(existsSync(path.join(r.absPath, 'package-lock.json')), `${r.dir}: lock missing`);
            npmLsOk(r.absPath);
        }
        assert.strictEqual(started.length, 4);
        assert.strictEqual(installedVersion(root, 'is-number'), '7.0.0');
        assert.strictEqual(installedVersion(path.join(root, 'front'), 'chalk'), '4.1.2');
        // transitive deps installed too
        assert.ok(existsSync(path.join(root, 'front', 'node_modules', 'ansi-styles', 'package.json')));
        assert.strictEqual(installedVersion(path.join(root, 'back'), 'ms'), '2.1.3');
        assert.strictEqual(installedVersion(path.join(root, 'packages', 'lib'), 'is-odd'), '3.0.1');
        // is-odd depends on is-number@^6 -> must be the nested project's own copy, not the root's 7.0.0
        assert.strictEqual(installedVersion(path.join(root, 'packages', 'lib'), 'is-number'), '6.0.0');
    });

    test('cleanInstall=true removes old node_modules and lock; false keeps the lock file', async () => {
        const dir = path.join(tmpRoot, 'clean');
        // range allows 6.x and 7.x; lock pins 6.0.0
        await writeJson(path.join(dir, 'package.json'), pkg('clean', { 'is-number': '6.0.0' }));
        execFileSync('npm', ['install'], { cwd: dir, stdio: 'pipe', shell: isWin });
        // widen the range: the lock (6.0.0) still satisfies it, so a non-clean install keeps 6.0.0
        await writeJson(path.join(dir, 'package.json'), pkg('clean', { 'is-number': '>=6.0.0 <8.0.0' }));
        assert.strictEqual(installedVersion(dir, 'is-number'), '6.0.0');

        // keep lock -> stays on 6.0.0
        let [res] = await installDirs(dir, [''], { cleanInstall: false, concurrency: 1 });
        assert.ok(res.success, res.error);
        assert.strictEqual(installedVersion(dir, 'is-number'), '6.0.0');
        assert.match(readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), /is-number-6\.0\.0\.tgz/);
        await fs.writeFile(path.join(dir, 'node_modules', 'is-number', 'STALE_MARKER'), 'x');

        // clean -> lock deleted, resolves latest 7.x, marker gone
        [res] = await installDirs(dir, [''], { cleanInstall: true, concurrency: 1 });
        assert.ok(res.success, res.error);
        assert.strictEqual(installedVersion(dir, 'is-number'), '7.0.0');
        assert.ok(!existsSync(path.join(dir, 'node_modules', 'is-number', 'STALE_MARKER')));
        npmLsOk(dir);
    });

    test('one failing dir does not stop the others; duplicates installed once', async () => {
        const root = path.join(tmpRoot, 'fail');
        await writeJson(path.join(root, 'ok', 'package.json'), pkg('ok', { 'ms': '2.1.3' }));
        await writeJson(path.join(root, 'bad', 'package.json'), pkg('bad', { 'this-package-should-not-exist-npm-installs-xyz': '1.0.0' }));

        const results = await installDirs(root, ['ok', 'bad', './ok', 'missing-dir'], { cleanInstall: true, concurrency: 4 });
        assert.deepStrictEqual(results.map(r => r.dir), ['ok', 'bad', 'missing-dir']);
        const byDir = Object.fromEntries(results.map(r => [r.dir, r]));
        assert.ok(byDir.ok.success, byDir.ok.error);
        assert.strictEqual(installedVersion(path.join(root, 'ok'), 'ms'), '2.1.3');
        assert.ok(!byDir.bad.success);
        assert.match(byDir.bad.error!, /exited with code/);
        assert.match(byDir.bad.output, /404|E404/);
        assert.ok(!byDir['missing-dir'].success);
        assert.match(byDir['missing-dir'].error!, /package.json not found/);
    });

    test('cancel kills the whole process tree and skips dirs not started yet', async () => {
        const root = path.join(tmpRoot, 'cancel');
        // the fake npm's child writes MARKER after 2s; the fake npm itself would run 5s
        const fakeNpm = await createFakeNpm(tmpRoot, 'fake-npm-slow', { sleepMs: 5000, markerAfterMs: 2000 });
        const dirs = ['a', 'b', 'c'];
        for (const d of dirs) { await writeJson(path.join(root, d, 'package.json'), pkg(d, {})); }
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 500);
        const started: string[] = [];
        const finished: number[] = [];
        const t = Date.now();
        const results = await installDirs(root, dirs, {
            cleanInstall: false, concurrency: 1, npmCommand: fakeNpm, signal: abort.signal,
            onStart: d => started.push(d),
            onFinish: (_r, n) => finished.push(n),
        });
        assert.ok(Date.now() - t < 2000, `cancel took ${Date.now() - t}ms`);
        assert.ok(results.every(r => !r.success && r.error === 'cancelled'), JSON.stringify(results));
        assert.deepStrictEqual(started, ['a'], 'dirs not started before cancel must not be reported as started');
        assert.deepStrictEqual(finished, [1, 2, 3], 'progress must still reach total');
        // if any process of the tree survived, it writes MARKER ~2s after start
        await sleep(2500);
        for (const d of dirs) {
            assert.ok(!existsSync(path.join(root, d, 'MARKER')), `${d}: a child process survived the cancel`);
        }
    });

    test('cancel kills a child that ignores SIGTERM', async () => {
        const root = path.join(tmpRoot, 'cancel-term');
        // POSIX: SIGTERM is ignored, SIGKILL follows after 5s. Windows: taskkill /F kills it at once.
        const fakeNpm = await createFakeNpm(tmpRoot, 'fake-npm-ignore-term', { sleepMs: 10000, markerAfterMs: 6500, childIgnoresSigterm: true });
        await writeJson(path.join(root, 'package.json'), pkg('term', {}));
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 500);
        const [res] = await installDirs(root, [''], { cleanInstall: false, concurrency: 1, npmCommand: fakeNpm, signal: abort.signal });
        assert.strictEqual(res.error, 'cancelled');
        await sleep(7500);
        assert.ok(!existsSync(path.join(root, 'MARKER')), 'the child survived the cancel');
    });

    test('cancel after npm itself exited still kills its remaining children, and resolves', async function () {
        // Windows cannot find the children of an already exited process (taskkill /T needs the parent).
        if (isWin) { this.skip(); }
        const root = path.join(tmpRoot, 'cancel-orphan');
        // npm exits at once; its child keeps stdout open (so no 'close' yet) and would write MARKER at 2s
        const fakeNpm = await createFakeNpm(tmpRoot, 'fake-npm-orphan', { sleepMs: 0, markerAfterMs: 2000, childInheritsStdio: true });
        await writeJson(path.join(root, 'package.json'), pkg('orphan', {}));
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 500);
        const t = Date.now();
        const [res] = await installDirs(root, [''], { cleanInstall: false, concurrency: 1, npmCommand: fakeNpm, signal: abort.signal });
        assert.strictEqual(res.error, 'cancelled');
        assert.ok(Date.now() - t < 1500, `cancel took ${Date.now() - t}ms`);
        await sleep(2000);
        assert.ok(!existsSync(path.join(root, 'MARKER')), 'the child survived the cancel');
    });

    test('a nonexistent npm command fails once without hanging', async () => {
        const root = path.join(tmpRoot, 'no-npm');
        await writeJson(path.join(root, 'package.json'), pkg('no-npm', {}));
        const finished: number[] = [];
        const [res] = await installDirs(root, [''], {
            cleanInstall: false, concurrency: 1, npmCommand: path.join(tmpRoot, 'does-not-exist-npm'), onFinish: (_r, n) => finished.push(n),
        });
        assert.ok(!res.success);
        assert.deepStrictEqual(finished, [1]);
    });

    test('refuses dirs outside the project and never deletes anything there', async () => {
        const root = path.join(tmpRoot, 'outside', 'project');
        const other = path.join(tmpRoot, 'outside', 'other');
        await writeJson(path.join(root, 'package.json'), pkg('project', {}));
        await writeJson(path.join(other, 'package.json'), pkg('other', {}));
        await fs.writeFile(path.join(other, 'package-lock.json'), '{}');
        await fs.mkdir(path.join(other, 'node_modules', 'keep'), { recursive: true });

        const results = await installDirs(root, ['../other', '..', 'sub/../../other'], { cleanInstall: true, concurrency: 2 });
        for (const r of results) {
            assert.ok(!r.success);
            assert.match(r.error!, /outside the project/);
        }
        assert.ok(existsSync(path.join(other, 'package-lock.json')));
        assert.ok(existsSync(path.join(other, 'node_modules', 'keep')));

        assert.ok(isInside(root, root));
        assert.ok(isInside(root, path.join(root, 'a', 'b')));
        assert.ok(isInside(root, path.join(root, '..foo')), 'a dir named "..foo" is inside');
        assert.ok(!isInside(root, path.dirname(root)));
        assert.ok(!isInside(root, other));
    });

    test('workspace glob matching', () => {
        assert.deepStrictEqual(expandBraces('{apps,libs}/*'), ['apps/*', 'libs/*']);
        assert.deepStrictEqual(expandBraces('a/{b,c{d,e}}/f'), ['a/b/f', 'a/cd/f', 'a/ce/f']);
        const m = matchWorkspacePattern;
        assert.ok(m('packages/a', 'packages/*'));
        assert.ok(m('packages/a', './packages/*/'));
        assert.ok(!m('packages/a/examples/demo', 'packages/*'));
        assert.ok(!m('packages', 'packages/*'));
        assert.ok(m('apps/x/web', 'apps/*/web'));
        assert.ok(!m('apps/x/api', 'apps/*/web'));
        assert.ok(m('libs/b', '{packages,libs}/*'));
        assert.ok(!m('tools', '{packages,libs}/*'));
        assert.ok(m('packages/a/b', 'packages/**'));
        assert.ok(m('a/b/c/plugin', '**/plugin'));
        assert.ok(m('plugin', '**/plugin'));
        assert.ok(m('pkg-core', 'pkg-*'));
        assert.ok(m('p1', 'p[0-9]'));
        assert.ok(!m('pa', 'p[!a]'));
        assert.ok(m('tools', 'tools'));
        assert.ok(!m('a.b', 'a+b'), 'regex characters are literal');
        assert.ok(!m('x', '../x'));
        assert.ok(!m('x', '*/..'));
    });

    suite('excludeWorkspaceMembers', () => {
        async function layout(name: string, rootJson: Record<string, unknown>, dirs: string[]): Promise<string> {
            const root = path.join(tmpRoot, 'ws', name);
            await writeJson(path.join(root, 'package.json'), { name, private: true, ...rootJson });
            for (const d of dirs) { await writeJson(path.join(root, d, 'package.json'), pkg(d.replace(/\W/g, '-'), {})); }
            return root;
        }
        async function run(root: string) { return excludeWorkspaceMembers(root, await findDirsWithFile(root)); }

        test('spec: npm array form -> [\'\', \'tools\']', async () => {
            const root = await layout('npm', { workspaces: ['packages/*'] }, ['packages/a', 'tools']);
            const res = await run(root);
            assert.deepStrictEqual(res.dirs, ['', 'tools']);
            assert.deepStrictEqual(res.skipped, [{ dir: 'packages/a', workspaceRoot: '' }]);
        });

        test('spec: yarn object form gives the same result', async () => {
            const root = await layout('yarn', { workspaces: { packages: ['packages/*'], nohoist: ['**/x'] } }, ['packages/a', 'tools']);
            assert.deepStrictEqual((await run(root)).dirs, ['', 'tools']);
        });

        test('only dirs matching a pattern are skipped; nested non-members are kept', async () => {
            const root = await layout('nested', { workspaces: ['packages/*', 'apps/*/web'] },
                ['packages/a', 'packages/a/examples/demo', 'apps/x/web', 'apps/x/api', 'tools']);
            const res = await run(root);
            assert.deepStrictEqual(res.dirs, ['', 'apps/x/api', 'packages/a/examples/demo', 'tools']);
            assert.deepStrictEqual(res.skipped.map(s => s.dir), ['apps/x/web', 'packages/a']);
        });

        test('braces, "*", explicit paths and negation', async () => {
            const braces = await layout('braces', { workspaces: ['{packages,libs}/*'] }, ['packages/a', 'libs/b', 'tools']);
            assert.deepStrictEqual((await run(braces)).dirs, ['', 'tools']);
            const star = await layout('star', { workspaces: ['*'] }, ['a', 'b', 'a/deep']);
            assert.deepStrictEqual((await run(star)).dirs, ['', 'a/deep']);
            const neg = await layout('neg', { workspaces: ['./tools', 'packages/*', '!packages/a'] }, ['packages/a', 'packages/b', 'tools']);
            assert.deepStrictEqual((await run(neg)).dirs, ['', 'packages/a'], 'a negated dir is not a member, so it is installed on its own');
        });

        test('workspace root in a sub dir: only its members are skipped (npm and yarn forms)', async () => {
            for (const [name, workspaces] of [['sub-npm', ['packages/*']], ['sub-yarn', { packages: ['packages/*'] }]] as const) {
                const root = path.join(tmpRoot, 'ws', name);
                await writeJson(path.join(root, 'package.json'), pkg(name, {}));
                await writeJson(path.join(root, 'mono', 'package.json'), { name: 'mono', private: true, workspaces });
                await writeJson(path.join(root, 'mono', 'packages', 'a', 'package.json'), pkg('a', {}));
                await writeJson(path.join(root, 'tools', 'package.json'), pkg('tools', {}));
                const res = await run(root);
                assert.deepStrictEqual(res.dirs, ['', 'mono', 'tools'], name);
                assert.deepStrictEqual(res.skipped, [{ dir: 'mono/packages/a', workspaceRoot: 'mono' }], name);
            }
        });

        test('no workspaces: result unchanged', async () => {
            const root = await layout('none', {}, ['back', 'front', 'packages/lib']);
            const dirs = await findDirsWithFile(root);
            const res = await excludeWorkspaceMembers(root, dirs);
            assert.deepStrictEqual(res.dirs, ['', 'back', 'front', 'packages/lib']);
            assert.deepStrictEqual(res.skipped, []);
            // empty workspaces / invalid package.json are treated as normal projects
            await writeJson(path.join(root, 'package.json'), { name: 'none', workspaces: [] });
            await fs.writeFile(path.join(root, 'back', 'package.json'), '{ broken');
            assert.deepStrictEqual((await excludeWorkspaceMembers(root, dirs)).dirs, dirs);
        });
    });
});
