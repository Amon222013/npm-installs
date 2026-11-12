# Usage
"npm installs" has three functions.  
  
Note：  
  If you are using a workspace, a list of projects will be displayed.
  Select the project you wish to npm install from the displayed projects.  
  In addition, if you are using Function 3, please create "npm-installs_setting.json" directly under each project.

1. "npm install" in all directories where package.json currently exists in the project.
   - Open the command palette and select "npm-install-all".
2. npm install" in all directories where package.json exists directly under the project in all directories where package.json exists.
   1. Open the command palette and select "npm-install-single".
   2. Enter the directory where you want to "npm install" in the input box that appears.
3. npm install in all specified directories.
   1. Create a file "npm-installs_setting.json" directly under the project folder.
   2. Describe the directory to "npm install" in the json file created in step 1.
      ```
      ex)
      {
       "dir": [
           "",
           "dir1",
           "dir2"
        ]
      }
      Note: Under the project, use "".
      ```
    3. Open the command palette and select "npm-install-multi".


# Settings
| Setting | Default | Description |
|---|---|---|
| `npm-installs.concurrency` | `0` | Max number of `npm install` run in parallel. `0` = auto (CPU count, up to 4). |
| `npm-installs.cleanInstall` | `true` | Delete `node_modules` and `package-lock.json` before installing. Set to `false` to keep the lock file (faster). |

# 使い方
"npm installs"には3つの機能があります。  
※ワークスペースを利用している場合、プロジェクト一覧が表示されますので、npm installをするプロジェクトを選択してください。  
　また、機能3を利用する場合、各プロジェクト直下に"npm-installs_setting.json"ファイルを作成してください。

1. package.jsonが存在する全ディレクトリでnpm installする  
   - コマンドパレットから"npm-install-all"を選択する

2. 指定したディレクトリのみでnpm installする  
   1. コマンドパレットから"npm-install-single"を選択する
   2. "npm install"するディレクトリを入力する
3. 指定した全ディレクトリでnpm installする
   1. プロジェクト直下に"npm-installs_setting.json"ファイルを作成する
   2. 手順1で作成したjsonファイルに"npm install"するディレクトリを記述する
      ```
      例)
      {
       "dir": [
           "",
           "ディレクトリ1",
           "ディレクトリ2"
        ]
      }
      ※プロジェクト直下は""を記述する
      ```
    3. コマンドパレットから"npm-install-multi"を選択する

# 設定
| 設定 | 既定値 | 説明 |
|---|---|---|
| `npm-installs.concurrency` | `0` | 同時に実行する `npm install` の最大数。`0` は自動（CPU数、最大4）。 |
| `npm-installs.cleanInstall` | `true` | インストール前に `node_modules` と `package-lock.json` を削除する。`false` にすると lock ファイルを残し、高速になります。 |
