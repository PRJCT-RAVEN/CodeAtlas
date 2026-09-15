# Windows test runbook — for a Claude agent

You are a Claude Code session (Fable 5.1 or later) on a Windows 11 box, asked to test a
CodeAtlas change. This page is the short form: what to set up, which checks to run for which
kind of change, what to fix yourself, and what to report. The full pass is
[WINDOWS-TESTING.md](WINDOWS-TESTING.md), sections 0–7; this page tells you which of those to run.

Read `CLAUDE.md` at the repo root first. Its "Platforms" bullet lists every Windows-specific rule
the code already follows; a change that breaks one of them is a bug, not a platform quirk.

## 0. Ground rules

- **Get the tree with git, never by copying.** `git clone https://github.com/PRJCT-RAVEN/CodeAtlas.git`
  then `git checkout <branch-or-tag under test>`. A tree copied from a Mac brings AppleDouble
  `._*` files, `.DS_Store`s and a `node_modules` built for the wrong platform; the first CI run on
  this project failed for exactly that reason on the Mac side.
- **Clone to a normal long path**, for example `%USERPROFILE%\code\CodeAtlas`. Not under `%TEMP%`
  and not under any 8.3 short-name path: vite refuses to serve any path containing `~` on
  Windows, so a tree under a short-name profile path (one with a `~1` component) serves nothing
  and every probe fails with
  "outside of Vite serving allow list".
- **Install dependencies fresh, per tree:** `npm ci` in `viewer/`, `schema/` and `tools/`.
- **Never write a machine-identifying path into anything you commit.** The CI `package` job
  refuses `C:\Users\<user>` in tracked files, placeholders `u`, `First Last` and `<user>`
  excepted. Use `%USERPROFILE%` in prose and reports.
- **Do not push to `main`.** Fixes go on a branch; open a PR, or hand the diff back if you have
  no push credentials. `gh` is usually not installed on the box; PRs can be opened from the web UI.
- **Screenshots stay on the box.** Reports describe them; they are not committed.

## 1. Environment to record

`node --version`, `npm --version`, `git --version` and `git config core.autocrlf`, whether
Developer Mode is on (`reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense`),
whether the shell is elevated, `sqlite3 --version` if present, whether `code` is on PATH,
`claude --version` and whether it is logged in. Put these in the report header. They decide
which tests skip: file symlinks need Developer Mode or elevation, `schema2ir` needs `sqlite3`,
section 6 needs a logged-in CLI.

## 2. What to run for which change

| Change touches | Run |
| --- | --- |
| Anything at all | Section A (suites). Every skip must print a reason; a suite that reports zero tests is a failure, not a pass. |
| `scripts/codeatlas-viewer*`, `viewer/vite.config.ts`, `.gitattributes` | A + B (launcher through the `.cmd` shim) + D (`/open` gate) |
| `viewer/src/**`, `viewer/tests/**` | A + C (live loop, last-good graph, feedback edges) + a screenshot of the kit graph |
| `tools/schema2ir.mjs`, `tools/fs2ir.mjs`, `tools/irdiff.mjs`, `schema/**` | A + kit section 3 and 4 (must end `validated)` with no "could not self-check" line) |
| `skills/**`, `agents/**`, `.claude-plugin/**` | A + E (plugin flow, headless) |
| `.github/**` only | A, then confirm the `windows-latest` jobs went green on the PR |

### A. Suites

```powershell
cd viewer;  npx vitest run;  npm run build;  cd ..
cd schema;  npm test;                        cd ..
cd tools;   npm test;                        cd ..
```

Expected on the 0.3.x line: viewer 297 pass / 1 skip, schema 42 pass, tools 65 with ~11 skips on
a box without Developer Mode (each skip names why). The counts move with the tree; what must not
move is "0 fail".

### B. Launcher through the shim

```powershell
$env:CODEATLAS_PORT = "5273"     # keep clear of a viewer the user may have on :5173
.\scripts\codeatlas-viewer.cmd paths
.\scripts\codeatlas-viewer.cmd status      # "down", exit 1
.\scripts\codeatlas-viewer.cmd start       # first run installs viewer + schema deps with --omit=dev
.\scripts\codeatlas-viewer.cmd status      # "up (pid N)", exit 0
.\scripts\codeatlas-viewer.cmd restart
.\scripts\codeatlas-viewer.cmd stop        # must kill the tree (taskkill /T): no orphan node.exe or esbuild.exe
```

Then kit section 1's first-run check: copy the plugin WITHOUT `node_modules` to a fresh long
path, `start` on another port, confirm it installs and serves `src/main.tsx` with HTTP 200.
Also `publish`: stage a graph in `LIVE_DIR`, `publish <name>` must validate and rename it; an
invalid draft must exit 1 and leave the live file untouched.

### C. Live loop

Kit section 2: copy `live-graphs/graph.json` into `LIVE_DIR`, expect a new ETag within a second
and `18 nodes · 34 edges`; truncate the file, expect the previous graph to stay on screen and the
status bar to name the parse error; the two feedback edges must be drawn upward. Take one
screenshot with `node tools\shot.mjs out.png http://localhost:5273/` (after
`npx playwright install chromium` once). Never report a visual result without a shot.

### D. `/open` gate, dry

Kit section 5 with `curl.exe -s -H "Sec-Fetch-Site: same-origin" "http://localhost:5273/open?file=README.md&line=1&dry"`.
Relative and absolute locs inside the project resolve; `C:\Windows\win.ini`, `..\..\Windows\win.ini`,
`root=C:\`, `root=C:\Users`, `root=%USERPROFILE%` and anything under `AppData` are refused with
a 404 that names the roots tried; a missing `Sec-Fetch-Site` header is a 403.

### E. Plugin flow, headless

From a directory that is NOT the repo, with `$R` the repo path in FORWARD slashes (how
`${CLAUDE_PLUGIN_ROOT}` expands on Windows too):

```powershell
$R = (Resolve-Path .\CodeAtlas).Path -replace '\\','/'
cd $env:TEMP; mkdir smoke; cd smoke
claude --plugin-dir $R --allowedTools "Bash(`"$R/scripts/codeatlas-viewer`" *)" -p "Use the /codeatlas:viewer skill with argument 'status'"
```

The quotes inside the pattern are load-bearing: the skill quotes the path, so an unquoted
pattern matches nothing and every call is denied. If the session reaches for the PowerShell tool
or an unquoted `node .../codeatlas-viewer.mjs`, note it — the skill should lead with the shim.
For a skill change, follow with a real "map this codebase" on a six-file scratch project and
confirm the graph was staged, validated and published with `codeatlas-viewer publish`, never
with `mv`, `Move-Item` or a direct write of `graph.json`.

## 3. When something fails

Decide which of three things it is, and say which in the report:

1. **A product bug on Windows** (the tool misbehaves for a user). Fix it if the fix is local and
   obvious, with a regression test that runs on Windows; otherwise report with the exact command
   and output.
2. **A test that assumes another platform** (case-insensitive filesystem, POSIX `join`, real
   symlinks, a `/tmp` that is not an 8.3 path). Fix the TEST: describe the host platform instead
   of hard-coding `darwin`, compose expectations with the described platform's `join`, use
   `symlinkSync(..., "junction")` for directories and skip file symlinks without Developer Mode
   with a printed reason, expand fixture roots with `realpathSync.native`, guard case-sensitive
   assertions off Windows the way win32-only ones are guarded off POSIX.
3. **Environment** (no `sqlite3`, no Developer Mode, port in use, stale `viewer.pid`). Record it
   and move on; do not "fix" the tree for it.

Rules the fix must keep: forward slashes in ids and `loc.file`; a dynamic `import()` of a repo
file is a `file://` URL built with `new URL(..., import.meta.url)`, never a bare `C:\` path; a
command that resolves to a batch file is spawned through `cmd.exe`; npm test globs are
double-quoted. Before proposing the branch, run the suites again and the personal-path gate: the
step named `No personal paths in shipped files` in `.github/workflows/ci.yml`, copied into a
`.sh` and run under Git Bash from the repo root. It must print nothing.

## 4. Report

One Markdown file, sent to the maintainer, not committed. Header: the environment from section 1
plus the branch or tag and commit tested. Then one table row per check run: section, PASS or
the exact command with observed versus expected output, and a short evidence column. Then the
findings, each tagged bug / test / environment, with the fix or the branch name. Suite counts go
in verbatim. No machine paths, no usernames, no screenshot paths; say what a screenshot showed.
Finish with "not run" for anything the environment skipped and why.
