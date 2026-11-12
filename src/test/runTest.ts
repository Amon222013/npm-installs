import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Create a throw-away project with several package.json files to open in the test VS Code. */
function createFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-installs-e2e-'));
	const pkg = (name: string, dependencies: Record<string, string>) => ({ name, version: '1.0.0', private: true, dependencies });
	writeJson(path.join(root, 'package.json'), pkg('root', { 'is-number': '7.0.0' }));
	writeJson(path.join(root, 'front', 'package.json'), pkg('front', { 'chalk': '4.1.2' }));
	writeJson(path.join(root, 'back', 'package.json'), pkg('back', { 'ms': '2.1.3' }));
	writeJson(path.join(root, 'packages', 'lib', 'package.json'), pkg('lib', { 'is-odd': '3.0.1' }));
	writeJson(path.join(root, 'npm-installs_setting.json'), { dir: ['back', 'packages/lib'] });
	return root;
}

async function main() {
	const fixture = createFixture();
	try {
		// The folder containing the Extension Manifest package.json
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');
		// The path to test runner
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [fixture, '--disable-extensions'],
			extensionTestsEnv: { NPM_INSTALLS_FIXTURE: fixture },
		});
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exitCode = 1;
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
}

main();
