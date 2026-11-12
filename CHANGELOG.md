## 0.2.0 (2026-11-12)
- Truly parallel installation: `npm install` now runs asynchronously (previously `execSync` blocked and ran directories one by one, freezing the extension host).
- Added `npm-installs.concurrency` setting (default: auto = number of CPUs, up to 4).
- Added `npm-installs.cleanInstall` setting (default: true = previous behavior). Set to false to keep `package-lock.json` for faster installs.
- `npm-install-all`: fixed detection of nested package.json (e.g. `a/b/package.json` was treated as `a`), and duplicates are no longer installed twice. Directory search is now parallel.
- Progress notification shows `done/total` and can be cancelled.
- One failing directory no longer hides the results of the others; a summary is shown at the end.
- Removed unused dependencies.

## 0.1.1 (2023-11-15)
- Logs of npm installations are now displayed in the VSCode output channel.

## 0.1.0 (2023-11-15)
- Added a status bar on the VSCode status bar to indicate that processing is in progress.

## 0.0.3 (2023-10-27)
- Parallelized installation process.