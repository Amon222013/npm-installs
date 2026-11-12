/*
 * Integration tests: run inside a real VS Code instance with the extension loaded,
 * execute the commands and check that `npm install` really produced working node_modules.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InstallResult } from '../../installer';

const fixture = process.env.NPM_INSTALLS_FIXTURE!;

function installedVersion(dir: string, dep: string): string {
	return JSON.parse(fs.readFileSync(path.join(fixture, dir, 'node_modules', dep, 'package.json'), 'utf8')).version;
}

function npmLsOk(dir: string): void {
	execFileSync('npm', ['ls', '--all'], { cwd: path.join(fixture, dir), stdio: 'pipe', shell: process.platform === 'win32' });
}

suite('Extension Test Suite', function () {
	this.timeout(300000);

	test('workspace is the fixture', () => {
		assert.ok(fixture);
		assert.strictEqual(vscode.workspace.workspaceFolders?.[0].uri.fsPath, fs.realpathSync(fixture));
	});

	suiteSetup(async () => {
		const ext = vscode.extensions.getExtension('4mon.npm-installs');
		assert.ok(ext, 'extension not found');
		await ext.activate();
	});

	test('commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const c of ['npm-installs.install-all', 'npm-installs.install-multi', 'npm-installs.install-single']) {
			assert.ok(commands.includes(c), `${c} not registered`);
		}
	});

	test('npm-install-multi installs only the dirs in npm-installs_setting.json', async () => {
		const results = await vscode.commands.executeCommand<InstallResult[]>('npm-installs.install-multi');
		assert.deepStrictEqual(results.map(r => r.dir), ['back', 'packages/lib']);
		for (const r of results) { assert.ok(r.success, `${r.dir}: ${r.error}\n${r.output}`); }
		assert.strictEqual(installedVersion('back', 'ms'), '2.1.3');
		assert.strictEqual(installedVersion('packages/lib', 'is-odd'), '3.0.1');
		npmLsOk('back');
		npmLsOk('packages/lib');
		assert.ok(!fs.existsSync(path.join(fixture, 'front', 'node_modules')));
		assert.ok(!fs.existsSync(path.join(fixture, 'node_modules')));
	});

	test('npm-install-all installs every package.json dir (incl. nested) in parallel', async () => {
		const t = Date.now();
		const results = await vscode.commands.executeCommand<InstallResult[]>('npm-installs.install-all');
		console.log(`    install-all: ${Date.now() - t}ms`, results.map(r => `${r.dir || '(root)'}=${r.durationMs}ms`).join(' '));
		assert.deepStrictEqual(results.map(r => r.dir), ['', 'back', 'front', 'packages/lib']);
		for (const r of results) {
			assert.ok(r.success, `${r.dir}: ${r.error}\n${r.output}`);
			assert.ok(fs.existsSync(path.join(r.absPath, 'package-lock.json')));
			npmLsOk(r.dir);
		}
		assert.strictEqual(installedVersion('', 'is-number'), '7.0.0');
		assert.strictEqual(installedVersion('front', 'chalk'), '4.1.2');
		assert.strictEqual(installedVersion('packages/lib', 'is-number'), '6.0.0');
	});

	test('settings are read (cleanInstall=false keeps lock file)', async () => {
		const config = vscode.workspace.getConfiguration('npm-installs');
		assert.strictEqual(config.get('cleanInstall'), true);
		assert.strictEqual(config.get('concurrency'), 0);
		await config.update('cleanInstall', false, vscode.ConfigurationTarget.Workspace);
		try {
			const lockPath = path.join(fixture, 'back', 'package-lock.json');
			fs.writeFileSync(path.join(fixture, 'back', 'node_modules', 'ms', 'KEEP_MARKER'), 'x');
			const results = await vscode.commands.executeCommand<InstallResult[]>('npm-installs.install-multi');
			assert.ok(results.every(r => r.success));
			// without clean install node_modules is not wiped
			assert.ok(fs.existsSync(path.join(fixture, 'back', 'node_modules', 'ms', 'KEEP_MARKER')));
			assert.ok(fs.existsSync(lockPath));
		} finally {
			await config.update('cleanInstall', undefined, vscode.ConfigurationTarget.Workspace);
		}
	});
});
