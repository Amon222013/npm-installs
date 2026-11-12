/*
 * Tests for src/installer.ts that run outside VS Code.
 * They use the REAL npm and the public registry to check that installs actually work.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs, readFileSync, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDirsWithFile, installDirs, normalizeDir, runWithConcurrency } from '../../installer';

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
    execFileSync('npm', ['ls', '--all'], { cwd: dir, stdio: 'pipe', shell: process.platform === 'win32' });
}

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
        if (process.platform === 'win32') { this.skip(); }
        const root = path.join(tmpRoot, 'parallel');
        const fakeNpm = path.join(tmpRoot, 'fake-npm.sh');
        await fs.writeFile(fakeNpm, '#!/bin/sh\nsleep 1\necho installed\n', { mode: 0o755 });
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
        assert.ok(parallelMs < 2000, `parallel took ${parallelMs}ms`);
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
        execFileSync('npm', ['install'], { cwd: dir, stdio: 'pipe' });
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

    test('cancel stops installs', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const root = path.join(tmpRoot, 'cancel');
        const fakeNpm = path.join(tmpRoot, 'fake-npm-slow.sh');
        await fs.writeFile(fakeNpm, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
        for (const d of ['a', 'b', 'c']) { await writeJson(path.join(root, d, 'package.json'), pkg(d, {})); }
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 300);
        const t = Date.now();
        const results = await installDirs(root, ['a', 'b', 'c'], { cleanInstall: false, concurrency: 1, npmCommand: fakeNpm, signal: abort.signal });
        assert.ok(Date.now() - t < 2000);
        assert.ok(results.every(r => !r.success && r.error === 'cancelled'));
    });
});
