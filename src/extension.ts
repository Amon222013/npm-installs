import * as vscode from 'vscode';
import { findDirsWithFile, installDirs, InstallOptions, InstallResult } from './installer';

type SettingJson = {
    dir: string[]
};

const SETTING_JSON = 'npm-installs_setting.json';
const SEPARATOR = '===================================================';
const outputChannel = vscode.window.createOutputChannel('npm installs');

/**
 * Commands return the install results so they can be awaited (e.g. from tests).
 * Returns undefined when the command was cancelled before installing.
 */
export function activate(context: vscode.ExtensionContext): void {

    context.subscriptions.push(outputChannel);

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-multi', async () => {
            const pjPath = await selectProject();
            if (pjPath === undefined) {
                return;
            }

            let settingInfo: SettingJson;
            try {
                const blob = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.file(pjPath), SETTING_JSON));
                settingInfo = JSON.parse(Buffer.from(blob).toString('utf8'));
            } catch (err) {
                vscode.window.showErrorMessage(`read fail setting json file (${SETTING_JSON})`, { modal: true });
                return;
            }

            if (!Array.isArray(settingInfo?.dir) || settingInfo.dir.length === 0) {
                vscode.window.showInformationMessage('Configuration not found, please check setting.json.', { modal: true });
                return;
            }

            return runInstalls(pjPath, settingInfo.dir, 'npm install multi');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-single', async () => {
            const pjPath = await selectProject();
            if (pjPath === undefined) {
                return;
            }

            const dir = await vscode.window.showInputBox({
                title: 'npm install folder',
                placeHolder: 'relative path from the project root (empty = project root)'
            });
            if (dir === undefined) {
                return;
            }

            return runInstalls(pjPath, [dir], 'npm install');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-all', async () => {
            const pjPath = await selectProject();
            if (pjPath === undefined) {
                return;
            }

            const dirs = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'npm installs: searching package.json' },
                () => findDirsWithFile(pjPath, 'package.json')
            );
            if (dirs.length === 0) {
                vscode.window.showInformationMessage('not exist package.json file for this directory', { modal: true });
                return;
            }

            return runInstalls(pjPath, dirs, 'npm install');
        })
    );
}

/** Let the user pick a workspace folder when there are several. */
async function selectProject(): Promise<string | undefined> {
    const projectPath = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    if (projectPath.length === 0) {
        vscode.window.showErrorMessage('Please open a folder or workspace first.');
        return undefined;
    }
    if (projectPath.length === 1) {
        return projectPath[0];
    }
    return vscode.window.showQuickPick(projectPath, { placeHolder: 'In what directory do you run npm install?' });
}

function getOptions(): Pick<InstallOptions, 'cleanInstall' | 'concurrency'> {
    const config = vscode.workspace.getConfiguration('npm-installs');
    return {
        cleanInstall: config.get<boolean>('cleanInstall', true),
        concurrency: config.get<number>('concurrency', 0),
    };
}

/** Run installs in parallel with progress + per-directory logs. */
async function runInstalls(projectPath: string, dirs: string[], label: string): Promise<InstallResult[]> {
    const options = getOptions();
    outputChannel.show(true);
    outputChannel.appendLine(`${SEPARATOR}\n${label} start: ${projectPath} (${new Date().toLocaleString()})`);

    const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${label}`, cancellable: true },
        async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            const total = new Set(dirs).size;
            progress.report({ message: `0/${total}` });

            return installDirs(projectPath, dirs, {
                ...options,
                signal: abort.signal,
                onStart: dir => outputChannel.appendLine(`▶ start  : ${displayDir(dir)}`),
                onFinish: (res, finished, all) => {
                    const mark = res.success ? '✔ done   ' : '✖ failed ';
                    outputChannel.appendLine(`${mark}: ${displayDir(res.dir)} (${(res.durationMs / 1000).toFixed(1)}s)`);
                    outputChannel.appendLine(`${SEPARATOR}\nexecute path: ${res.absPath}\n${res.output}${res.error ? `\nERROR: ${res.error}` : ''}\n`);
                    progress.report({ message: `${finished}/${all}`, increment: 100 / all });
                },
            });
        }
    );

    const failed = results.filter(r => !r.success);
    outputChannel.appendLine(`${label} finished: ${results.length - failed.length} succeeded, ${failed.length} failed`);
    if (failed.length === 0) {
        vscode.window.showInformationMessage(`${label} Done (${results.length})`, { modal: true });
    } else {
        vscode.window.showErrorMessage(
            `Fail npm install: ${failed.map(r => displayDir(r.dir)).join(', ')}`,
            { modal: true, detail: 'See the "npm installs" output channel for details.' }
        );
    }
    return results;
}

function displayDir(dir: string): string {
    return dir === '' ? '(project root)' : dir;
}

export function deactivate() {}
