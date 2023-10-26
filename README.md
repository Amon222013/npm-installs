# Usage
"npm installs" has three functions.
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

# 使い方
"npm installs"には3つの機能があります。
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