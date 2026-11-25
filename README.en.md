# @future/dsh-browser-tool

Browser-operation plugin for [DeepSeek Harness](https://github.com/deepseek-ai): a long-lived, silent-by-default real Edge / Chromium browser plus a tool surface for *observe → locate → act → verify → extract → archive*.

![status](https://img.shields.io/badge/status-0.9.1%20ready-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![runtime](https://img.shields.io/badge/runtime-Node.js%2020%2B%20%7C%2022-339933)

> **0.9.1 (stateless acquisition ladder + status retries)**: `browser_fetch.ladder` tries official API → RSS/Atom → static HTML → rendered DOM in one call and reports the winning tier with per-tier evidence; requests now retry 408/429/5xx honoring `Retry-After` with exponential backoff, and return per-run `stats`. No site memory, no per-site code.
>
> **0.9.0 (anti-blocking channel, published)**: `browser_fetch` gains a curl engine (browser TLS/UA, proxy bypass, cookie jar) and mentis-family form-hash signing (sha256 → `encparam` + `hashval`), plus unified `blocked` detection for 403/429/security pages. Still 18 tools.
>
> **0.8.0 (speed release)**: 18 tools instead of 23; tool schema per request 27.8KB → 21.0KB (≈8.7k → 6.6k tokens, −24%); content cache (0–2 ms hits) and compact replies.
>
> **Breaking changes**: `browser_observe` / `browser_inspect` / `browser_extract` / `browser_screenshot` → **`browser_read`**; `browser_batch` → **`browser_act.steps`**; `browser_forum` → **`browser_site`**. See the migration table below. Changelog: [`CHANGELOG.md`](CHANGELOG.md).

## What it is

This is not a black-box LLM browser agent. The model drives every step through explicit tool calls:

1. Read actual state: `browser_snapshot` (actionable structure) or `browser_read` (layers / deep inspection / extraction);
2. Locate by container, text, `@eN` ref or CSS selector;
3. Act (`browser_act`, single step or multi-step `steps`);
4. Verify by reading back `value`, `checked`, URL and element existence;
5. Persist evidence (screenshots, full text, JSON, HAR);
6. **Leave final submission to the human** — the plugin never auto-submits and never bypasses CAPTCHAs.

The flow generalises the ideas of [`chrome-quiz-copilot`](https://github.com/Ruoyu-Tianyi/chrome-quiz-copilot) into a general research and segmented-collaboration workflow — see [`skills/browser-field-ops/SKILL.md`](skills/browser-field-ops/SKILL.md).

## Quick start

```js
// 1) Navigate only (skip the first-screen snapshot)
browser_open { url: "https://example.com/list", snapshot: false }

// 2) Locate: scoped snapshot, then act on @eN
browser_snapshot { selector: "#list", maxElements: 80 }
browser_act { action: "click", ref: "@e3", label: "next page" }

// 3) Read: extract with compact reply (records capped at 20 by default)
browser_read { source: "extract", mode: "records", selector: "#list", itemSelector: "li", fields: { title: "h3" } }

// 4) Many steps in one call: goto → click → extract
browser_act { steps: [
  { action: "goto", url: "https://example.com/list" },
  { action: "click", selector: "a.next" },
  { action: "extract", mode: "records", itemSelector: "li", fields: { title: "h3" } }
] }

// 5) Repeated reads: fetch uses the content cache by default; refresh:true forces a reload
browser_fetch { url: "https://api.example.com/quote" }
```

## Migration (0.7 → 0.8)

| 0.7 | 0.8 |
|---|---|
| `browser_observe { layers }` | `browser_read { source: "observe", layers }` |
| `browser_inspect { mode }` | `browser_read { source: "inspect", mode }` |
| `browser_extract { mode }` | `browser_read { source: "extract", mode }` |
| `browser_screenshot { path }` | `browser_read { source: "screenshot", path }` |
| `browser_batch { steps }` | `browser_act { steps }` |
| `browser_forum { guild }` | `browser_site { action: "run", siteId: "qq-forum", tool: "collect", args: { guild } }` |
| action extras (button/drag/files…) | `browser_act { action, options: { … } }` |

## Highlights

- **Silent by default**: `visibility=headless`; never calls `page.bringToFront()` unless explicitly requested. Switch to `window` only for human login or CAPTCHA.
  CAPTCHAs are classified by `lib/human-check.js` and reported as `humanCheck` (with the exact next step); after a
  human solves it, call `browser_act({action:"waitForHuman"})` to wait for it to disappear — the tool waits, never answers.
- **Long-running**: `idleCloseMs=0`, 30 s watchdog, auto-relaunch after disconnect, bounded launch budget (30 s per attempt / 55 s total), persistent login profile.
- **Multi-subagent workspaces**: `browser_workspace` with `reader` / `writer` roles, per-tab read/write locks, leases, handoff notes, stable tab IDs.
- **Unified read**: `browser_read` covers layers, deep inspection, extraction and screenshots; scoped by `selector` / `ref`, `detail=compact` keeps replies small and spills full content to `savedPath`.
- **Anti-blocking channel**: `browser_fetch` can switch to a system curl engine (browser TLS/UA, `--noproxy`, cookie jar) and sign mentis-family forms (`sign: { kind: "form-hash" }`); blocked responses return a reason and next steps. Authorized targets only; no CAPTCHA bypass.
- **Content cache**: `browser_fetch` caches GET 2xx text/JSON (skips Authorization and `no-store`), returns `cached:true` + `ageMs`; `browser_read` caching is opt-in (`cache:true`); `refresh:true` bypasses. TTL 1 h, 512 MB cap with mtime eviction.
- **One call does more**: `browser_act.steps` (≤50 steps: act actions + `extract` + `goto`), `browser_paginate` (auto next-page, N pages), `browser_site` (site-tool registry, built-in `qq-forum` plus declarative manifests).
- **Visible mode HUD**: in `window` / `offscreen`, `label` renders as a Shadow-DOM badge and is excluded from snapshots.
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

## Performance (0.8.0)

`npm run test:perf` on a local fixture page (headless, HUD off):

| Metric | Before | After |
|---|---|---|
| Tool schema per request | 27,794 B | **20,993 B (≈6,560 tokens, −24%)** |
| `browser_act` scroll / click | 443 / 422 ms | **~220 / ~240 ms** |
| `browser_snapshot` scoped (no interactive nodes) | 330 ms | **15 ms** |
| `browser_paginate` 3 pages | 577 ms | **~490 ms (~160 ms/page)** |
| `browser_act.steps` (goto + extract) | — | **~60 ms** |
| `browser_read` screenshot (viewport / full page) | 150 / 540 ms | 113 / 485 ms |
| `browser_fetch` cache hit | — | **0–2 ms** (first call 26 ms–5 s) |

The only unavoidable fixed cost is Edge cold start (3–5 s, once per session while the browser stays resident). Full notes: [`docs/performance.md`](docs/performance.md).

## Configuration defaults

The plugin exports no `Config` / `ConfigSchema`; the Loader passes raw config to `apply(ctx, rawConfig)` and `lib/config.js` resolves defaults. Key defaults: `visibility=headless`, `idleCloseMs=0`, `watchdogIntervalMs=30000`, `autoRelaunch=true`, `maxTabs=24`, `maxIdleTabs=8`, `idleTabMs=600000`, `actionHud=true`, `cacheEnabled=true`, `cacheTtlMs=3600000`, `cacheMaxBytes=536870912`, `allowEval=false`, `allowAbsoluteArtifacts=false`, `collectConcurrency=4`, `networkMaxEntries=80`. Directories default under `~/.dsh/browser-tool/` (or `$DSH_HOME`) — no hard-coded Desktop paths. Full table in the [Chinese README](README.md#配置).

## Tools (18)

`browser_open`, `browser_snapshot`, `browser_read`, `browser_act`, `browser_paginate`, `browser_site`, `browser_fetch`, `browser_collect`, `browser_network`, `browser_tabs`, `browser_workspace`, `browser_show`, `browser_capture`, `browser_devtools`, `browser_scratch`, `browser_download`, `browser_status`, `browser_close`.

18 tools are implemented in code. Full parameter tables and return shapes: [`docs/tools.md`](docs/tools.md).

## Safety

- Only `http(s)` URLs are accepted; page content is treated as untrusted data, never as instructions.
- No stealth, no CAPTCHA solving/bypass, no automatic form submission.
- Login state lives in a dedicated `userDataDir`; connecting to a daily-driver browser requires explicit CDP mode.
- Cache stores only GET 2xx text/JSON; requests with Authorization or responses with `no-store` are not cached.
- See [`SECURITY.md`](SECURITY.md).

## Documentation

[`docs/architecture.md`](docs/architecture.md) · [`docs/tools.md`](docs/tools.md) · [`docs/subagents.md`](docs/subagents.md) · [`docs/installation.md`](docs/installation.md) · [`docs/troubleshooting.md`](docs/troubleshooting.md) · [`docs/upstream-proposal.md`](docs/upstream-proposal.md)

## Verification

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --check .\index.js
& $node .\test\unit.mjs
& $node .\test\docs.mjs
& $node .\test\perf.mjs

# Real Edge E2E (not run in CI)
$env:DSH_BROWSER_E2E = '1'; & $node .\test\e2e.mjs
```

CI runs syntax checks, browser-free unit tests and doc consistency (`.github/workflows/ci.yml`). Real-browser acceptance commands and the historical result table live in [`docs/install-verification.md`](docs/install-verification.md).

## License

[MIT](LICENSE) © 2026 DSH Browser Tool contributors
