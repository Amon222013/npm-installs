import * as vscode from 'vscode';
import { execSync } from 'child_process';

type SettingJson = {
    dir: string[]
}

const SETTING_JSON: string = '/npm-installs_setting.json';
const outputChannel = vscode.window.createOutputChannel('npm installs');

/**
 * 
 * @param context 
 */
export function activate(context: vscode.ExtensionContext): void {
    
    console.log('Congratulations, your extension "npm-installs" is now active!');
    const osType = process.platform;
    const projectPath: string[] = [];
    for(const workspaceInfo of vscode.workspace.workspaceFolders!) {
        const tmpPjPath = osType === 'win32' ? workspaceInfo.uri.fsPath : workspaceInfo.uri.path;
        projectPath.push(tmpPjPath);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-multi', async () => {
            vscode.window.withProgress({location: vscode.ProgressLocation.Window, title: 'npm installs processing'}, async progress => {
                const pjPath = await selectProject(projectPath);
    
                const readFilePath = pjPath + SETTING_JSON;
                let settingInfo: SettingJson;
                try {
                    const blob: Uint8Array =  await vscode.workspace.fs.readFile(vscode.Uri.file(readFilePath));
                    settingInfo = JSON.parse(Buffer.from(blob).toString('utf8'));
                } catch(err) {
                    vscode.window.showInformationMessage('read fail setting json file', {modal: true});
                    return;
                }
        
                if(settingInfo.dir.length === 0){
                    vscode.window.showInformationMessage('Configuration not found, please check setting.json.', {modal: true});
                    return;
                }
    
                await Promise.all(settingInfo.dir.map(async dir => {
                    await execProc(pjPath, dir, osType);
                }));
                vscode.window.showInformationMessage('npm install multi Done', {modal: true});
            })
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-single', async () => {
            vscode.window.withProgress({location: vscode.ProgressLocation.Window, title: 'npm installs processing'}, async progress => {
                const pjPath = await selectProject(projectPath);
    
                const dir = await vscode.window.showInputBox({
                    title: 'npm install folder'
                });
    
                if (dir !== undefined) {
                    await execProc(pjPath, dir, osType);
                } else {
                    return;
                }
    
                vscode.window.showInformationMessage('npm install Done', {modal: true});
            });
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-all', async () => {
            vscode.window.withProgress({location: vscode.ProgressLocation.Window, title: 'npm installs processing'}, async progress => {
                const pjPath = await selectProject(projectPath);
                
                progress.report({ message: 'search package.json file'});
                const filePath = await findFoldersWithFile(pjPath, 'package.json', pjPath);
                if(filePath.length === 0){
                    vscode.window.showInformationMessage('not exist package.json file for this directory', {modal: true});
                    return;
                }
    
                progress.report({ message: 'installing'});
                await Promise.all(filePath.map(async dir => {
                    await execProc(pjPath, dir, osType);
                }));
                    
                vscode.window.showInformationMessage('npm install Done', {modal: true});
            })
        })
    )
}

async function selectProject(projectPath: string[]): Promise<string> {
    let pjPath;
    if(projectPath.length > 1) {
        const options: vscode.QuickPickOptions = {placeHolder: "In what directory do you run npm install?"};
        pjPath = await vscode.window
            .showQuickPick(projectPath, options)
            .then(select => {return select;});
        
        if(pjPath === undefined) {
            throw new Error('Please select a project.');
        }
    } else {
        pjPath = projectPath[0];
    }
    return pjPath;
}

async function execProc(projectPath: string, dir: string, osType: string){
    
    let execPath: string, rmCommands: string[];
    const tmpPath = `${projectPath}/${dir}`
    if(osType === 'win32'){
        execPath = tmpPath;
        console.log('execPath: ', tmpPath);
        rmCommands = [
            'if exist node_modules rmdir /s /q node_modules',
            'if exist package-lock.json del package-lock.json'
        ];
    }else{
        execPath = tmpPath;
        console.log('execPath: ', execPath);
        rmCommands = [
            'rm -rf node_modules',
            'rm -f package-lock.json'
        ];
    }

    try {
        await execSyncCommands(rmCommands, execPath);
        await execSyncCommands(['npm install'], execPath)
            .then(output => {
                outputChannel.append(`===================================================\nexecute path: ${execPath}\n${output}\n`);
                outputChannel.show();
            });
    } catch(err: any) {
        outputChannel.append(`===================================================\nexecute path: ${execPath}\n${err.stack}\n`);
        outputChannel.show();
        vscode.window.showInformationMessage('Fail npm install', {modal: true});
        throw new Error(err);
    }
}

async function execSyncCommands(commands: string[], execPath: string){
    try {
        const commandString = commands.join(' && ');
        return execSync(commandString, { cwd: execPath, encoding: 'utf-8'});
    } catch (err: any) {
        console.error('Error executing commands:', err);
        throw new Error(err);
    }
}

async function findFoldersWithFile(directory: string, targetFileName: string, projectPath: string, results: string[] = []) {
    const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
  
    for (const file of files) {
        const name = file[0];
        const fileType = file[1];
        const filePath = directory + '/' + name;

        const regex = new RegExp(/^\./);
        if(name === 'node_modules' || regex.test(name)) continue;
    
        if (fileType === 2) {
          await findFoldersWithFile(filePath, targetFileName, projectPath, results);
        } else if (fileType === 1 && name === targetFileName) {
          const tmpDir = filePath.substring(projectPath.length + 1, filePath.length);
          const dirPath = tmpDir.substring(0, tmpDir.indexOf('/'));
          results.push(dirPath);
        }
    }
    return results;
}

export function deactivate() {}
