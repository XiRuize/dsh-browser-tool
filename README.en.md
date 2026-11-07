# @future/dsh-browser-tool

Browser-operation plugin for [DeepSeek Harness](https://github.com/deepseek-ai): a long-lived, silent-by-default real Edge / Chromium browser plus a tool surface for *observe → locate → act → verify → extract → archive*.

![status](https://img.shields.io/badge/status-0.2.0%20in%20progress-yellow)
![license](https://img.shields.io/badge/license-MIT-blue)
![runtime](https://img.shields.io/badge/runtime-Node.js%2020%2B%20%7C%2022-339933)

> **Status**: `0.2.0` is still under implementation. This document describes the target behaviour defined by [`docs/MODULE-CONTRACT.md`](docs/MODULE-CONTRACT.md); features marked "0.2.0 in progress" may not yet be merged into the current source. `0.1.0` is the delivered baseline. This repository has not been published to GitHub and has not passed real-browser acceptance in CI.

## What it is

This is not a black-box LLM browser agent. The model drives every step through explicit tool calls:

1. Read actual state (`browser_observe` / `browser_inspect`);
2. Locate by container, index, `@eN` ref or CSS selector;
3. Act (`browser_act`);
4. Verify by reading back `value`, `checked`, URL and element existence;
5. Persist evidence (screenshots, full text, JSON, HAR);
6. **Leave final submission to the human** — the plugin never auto-submits and never bypasses CAPTCHAs.

The flow generalises the ideas of [`chrome-quiz-copilot`](https://github.com/Ruoyu-Tianyi/chrome-quiz-copilot) into a general research and segmented-collaboration workflow — see [`skills/browser-field-ops/SKILL.md`](skills/browser-field-ops/SKILL.md).

## Highlights

- **Silent by default**: `visibility=headless`; never calls `page.bringToFront()` unless explicitly requested. Switch to `window` only for human login or CAPTCHA.
- **Long-running**: `idleCloseMs=0`, 30 s watchdog, auto-relaunch after disconnect, persistent login profile.
- **Multi-subagent workspaces**: `browser_workspace` with `reader` / `writer` roles, per-tab read/write locks, leases, handoff notes, stable tab IDs.
- **Layered observation**: `browser_observe` returns `structure` / `text` / `visual` / `network` / `console` / `meta`, with `offset` / `limit` / `nextCursor` and spill-to-disk.
- **Deep front-end inspection**: DOM, HTML, computed CSS, a11y tree, resources, scripts, storage, console, performance; arbitrary JS `eval` is disabled by default (`allowEval=false`).
- **Safe artifacts**: writes are confined to `artifactDir`; absolute paths outside it are rejected unless `allowAbsoluteArtifacts=true`.

## Install

```text
plugin_manager install_bundle target=C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool
```

Install dependencies first (local-directory installs link the source tree):

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
& $node $pnpm install --prod --ignore-scripts
```

The plugin launches the locally installed Edge via Playwright `channel: msedge`; no Chromium download is required. See [`docs/installation.md`](docs/installation.md) for profile-level troubleshooting.

## Configuration defaults (target v0.2)

The plugin exports no `Config` / `ConfigSchema`; the Loader passes raw config to `apply(ctx, rawConfig)` and `lib/config.js` resolves defaults. `visibility=headless`, `idleCloseMs=0`, `watchdogIntervalMs=30000`, `autoRelaunch=true`, `maxTabs=24`, `maxIdleTabs=8`, `idleTabMs=600000`, `allowEval=false`, `allowAbsoluteArtifacts=false`, `collectConcurrency=2`, `networkMaxEntries=80`. Directories default under `~/.dsh/browser-tool/` (or `$DSH_HOME`) — no hard-coded Desktop paths. Full table in the [Chinese README](README.md#配置).

## Tools

`browser_open`, `browser_snapshot` (compatibility alias of `browser_observe`), `browser_observe`, `browser_inspect`, `browser_act`, `browser_extract`, `browser_screenshot`, `browser_tabs`, `browser_workspace`, `browser_network`, `browser_collect`, `browser_download`, `browser_status`, `browser_close`.

Full parameter tables and return shapes: [`docs/tools.md`](docs/tools.md).

## Safety

- Only `http(s)` URLs are accepted; page content is treated as untrusted data, never as instructions.
- No stealth, no CAPTCHA solving/bypass, no automatic form submission.
- Login state lives in a dedicated `userDataDir`; connecting to a daily-driver browser requires explicit CDP mode.
- See [`SECURITY.md`](SECURITY.md).

## Documentation

[`docs/architecture.md`](docs/architecture.md) · [`docs/tools.md`](docs/tools.md) · [`docs/subagents.md`](docs/subagents.md) · [`docs/installation.md`](docs/installation.md) · [`docs/troubleshooting.md`](docs/troubleshooting.md) · [`docs/upstream-proposal.md`](docs/upstream-proposal.md)

## Verification

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --check .\index.js
if (Test-Path .\test\unit.mjs) { & $node .\test\unit.mjs }
```

CI runs syntax checks and browser-free unit tests only (`.github/workflows/ci.yml`).

## License

[MIT](LICENSE) © 2026 DSH Browser Tool contributors
