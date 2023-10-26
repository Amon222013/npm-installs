import * as vscode from 'vscode';
import { execSync } from 'child_process';

type SettingJson = {
    dir: string[]
}

const SETTING_JSON: string = '/npm-installs_setting.json';

/**
 * 
 * @param context 
 */
export function activate(context: vscode.ExtensionContext): void {

    console.log('Congratulations, your extension "npm-installs" is now active!');
    // Projectディレクトリパス取得
    const workspaceInfo = vscode.workspace.workspaceFolders![0];
    const projectPath = `${workspaceInfo.uri.path}`;
    const fullPath = projectPath.replace(':', '');
    const osType = process.platform;
    const formatPath = osType === 'win32' ? projectPath.substring(3, projectPath.length) : fullPath;

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-multi', async () => {
            // setting.json取得用パス
            const readFilePath = formatPath + SETTING_JSON;
            // jsonファイルからディレクトリ名取得し、配列に入れる
            let settingInfo;
            try {
                const blob: Uint8Array =  await vscode.workspace.fs.readFile(vscode.Uri.file(readFilePath));
                settingInfo = JSON.parse(Buffer.from(blob).toString('utf8'));
            } catch(err) {
                vscode.window.showInformationMessage('read fail setting json file', {modal: true});
                return;
            }
    
            if(settingInfo.dir.length === 0){
                // モーダルで完了通知
                vscode.window.showInformationMessage('Configuration not found, please check setting.json.', {modal: true});
                return;
            }
    
            for await (const dir of settingInfo.dir) {
                await execProc(projectPath, fullPath, dir, osType);
            }
            vscode.window.showInformationMessage('npm install multi Done', {modal: true});
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-single', async () => {
            const dir = await vscode.window.showInputBox({
                title: 'npm install folder'
            });

            if (dir !== undefined) {
                await execProc(projectPath, fullPath, dir, osType);
            } else {
                return;
            }

            vscode.window.showInformationMessage('npm install Done', {modal: true});
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('npm-installs.install-all', async () => {
            const filePath = await findFoldersWithFile(formatPath, 'package.json', formatPath);
            if(filePath.length === 0){
                // モーダルで完了通知
                vscode.window.showInformationMessage('not exist package.json file for this directory', {modal: true});
                return;
            }

            for await (const dir of filePath) {
                const dirPath = dir.substring(formatPath.length + 1, dir.length);
                await execProc(projectPath, fullPath, dirPath, osType);
            }
            vscode.window.showInformationMessage('npm install Done', {modal: true});
        })
    )
}

async function execProc(projectPath: string, fullPath: string, dir: string, osType: string){
    
    let execPath: string, rmCommands: string[];
    const tmpPath = `${projectPath}/${dir}`
    if(osType === 'win32'){
        execPath = tmpPath.slice(1).replaceAll('/', '\\');
        console.log('execPath: ', execPath);
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
        await execSyncCommands(['npm install'], execPath);
    } catch(err: any) {
        vscode.window.showInformationMessage('Fail npm install', {modal: true});
        throw new Error(err);
    }
}

async function execSyncCommands(commands: string[], execPath: string){
    try {
        const commandString = commands.join(' && ');
      
        const output = execSync(commandString, { cwd: execPath, encoding: 'utf-8'});
        console.log('Commands executed successfully');
        console.log('Output:', output);
    } catch (error) {
        console.error('Error executing commands:', error);
    }
}

async function findFoldersWithFile(directory: string, targetFileName: string, formatPath: string, results: string[] = []) {
    const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
  
    for (const file of files) {
        const name = file[0];
        const fileType = file[1];
        const filePath = directory + '/' + name;

        const regex = new RegExp(/^\./);
        if(name === 'node_modules' || regex.test(name)) continue;
        // if(name === 'node_modules') continue;
    
        if (fileType === 2) {
          // ディレクトリの場合、再帰的に検索を行う
          await findFoldersWithFile(filePath, targetFileName, formatPath, results);
        } else if (fileType === 1 && name === targetFileName) {
          // ファイルが存在する場合、結果にディレクトリを追加
          const tmpDir = filePath.substring(formatPath.length + 1, filePath.length);
          const dirPath = tmpDir.substring(0, tmpDir.indexOf('/'));
          results.push(dirPath);
        }
    }
    return results;
}

export function deactivate() {}
