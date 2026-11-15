## 0.2.0 (2026-11-12)
- Truly parallel installation: `npm install` now runs asynchronously (previously `execSync` blocked and ran directories one by one, freezing the extension host).
- Added `npm-installs.concurrency` setting (default: auto = number of CPUs, up to 4).
- Added `npm-installs.cleanInstall` setting (default: true = previous behavior). Set to false to keep `package-lock.json` for faster installs.
- `npm-install-all`: fixed detection of nested package.json (e.g. `a/b/package.json` was treated as `a`), and duplicates are no longer installed twice. Directory search is now parallel.
- Progress notification shows `done/total` and can be cancelled.
- One failing directory no longer hides the results of the others; a summary is shown at the end.
- `npm-install-all`: members of an npm / yarn workspace (monorepo) are no longer installed separately. A directory matched by the `workspaces` globs of a package.json above it (e.g. `packages/*`, `{apps,libs}/*`, `!negation` supported) is skipped and installed by the workspace root's `npm install`; the skip is logged as `skip (managed by workspace root: ...)`. Other projects below the root (e.g. `tools`, or `packages/a/examples/demo` not matched by a pattern) are still installed. `npm-install-multi` / `npm-install-single` install exactly what you specify.
- Cancel now stops the whole process tree (npm and its lifecycle scripts) on Windows, macOS and Linux, and waits until it has exited (processes that ignore SIGTERM are force-killed after 5 seconds on macOS / Linux).
- Directories outside the project (e.g. `"a/../../other"` in `npm-installs_setting.json`) are refused, so nothing outside the project is ever deleted.
- Fixed garbled multi-byte characters in the output log, and `"."`/dot-directories (e.g. `".config"`) in directory settings being misread.
- Removed unused dependencies.

## 0.1.1 (2023-11-15)
- Logs of npm installations are now displayed in the VSCode output channel.

## 0.1.0 (2023-11-15)
- Added a status bar on the VSCode status bar to indicate that processing is in progress.

## 0.0.3 (2023-10-27)
- Parallelized installation process.