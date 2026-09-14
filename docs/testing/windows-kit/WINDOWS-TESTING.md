# CodeAtlas — Windows test kit

The plan for testing CodeAtlas on a real Windows box, plus the fixtures it needs. Everything
below is the surface that CI does not cover on Windows; the Swift analyzer is macOS-only, so
skip `analyzer/` entirely.

This kit used to be handed over as a loose folder outside git, which let its copy of
`order-pipeline.json` drift behind `docs/examples/` (see
`docs/audit/2026-09-07-windows-handoff.md`). It now lives in the repo so that cannot happen
again: the order-pipeline graph is referenced from `docs/examples/`, never duplicated here.

Prereqs: Node ≥ 20 on PATH (`node --version`) and a clone of the repo.

```powershell
$env:REPO = "C:\path\to\CodeAtlas"
$env:KIT  = "$env:REPO\docs\testing\windows-kit"
```

PowerShell commands below; cmd.exe equivalents are the same minus `$env:` syntax.

## 0. Test suites (fastest signal first)

```powershell
cd $env:REPO\viewer ; npm install ; npm test      # 298 tests: 296 passed, 2 skipped (2026-09-12)
cd $env:REPO\schema ; npm install ; npm test      # 42 tests: 41 pass, 1 skipped
cd $env:REPO\tools  ; npm install ; npm test      # 62 tests: 52 pass, 10 skipped
```

Every skip must name its reason, and without Developer Mode or elevation the expected set is:
`viewer` skips its two symlink cases (the `.cmd` round-trip RUNS on Windows); `schema` skips
the symlinked-CLI case; `tools` skips FIFO, unrepresentable file names, two symlink cases, the
five POSIX-shell/launchd cases and the sqlite3-stub case. **If a suite reports 0 tests with
exit 0, that is a finding** — it is how the single-quoted-glob bug hid on Windows. Note WHICH
tests skip; a *failure* is always a finding. Watch especially for path-separator assumptions
(backslash in ids/locs), `Buffer.compare` sort order — ids must use forward slashes even on
Windows — and any dynamic `import()` of a repo file by absolute path: on Windows the ESM loader
rejects `C:\…` ("Received protocol 'c:'"), so it must be a `file://` URL (2026-09-12 finding in
`schema2ir`'s self-check).

Run the suites in the order above. The `tools` suite reaches outside `tools/` — fs2ir and
schema2ir shell out to `schema/validate.mjs`, and the launcher test starts the real viewer — so
it needs `viewer/` and `schema/` dependencies installed first. If they are missing, the launcher
test skips and names what to install; it no longer installs them for you mid-run.

## 1. Launcher (the main target)

```powershell
cd $env:REPO
.\bin\codeatlas-viewer.cmd paths      # prints PLUGIN_ROOT / LIVE_DIR / URL / LOG
.\bin\codeatlas-viewer.cmd status     # expect "down", exit code 1
.\bin\codeatlas-viewer.cmd start      # first run installs viewer+schema deps, then vite detached on :5173
.\bin\codeatlas-viewer.cmd status     # expect running + pid, exit 0
.\bin\codeatlas-viewer.cmd open       # browser opens http://localhost:5173/
.\bin\codeatlas-viewer.cmd stop       # must kill the vite TREE (taskkill /T) — verify no orphan node.exe
.\bin\codeatlas-viewer.cmd status     # exit 1 again
```

`paths` should report `LIVE_DIR=%USERPROFILE%\.codeatlas\live`.

Checks: `stop` must refuse to kill a pid that is no longer vite (start, kill vite by hand, then
re-run `stop` twice; the second run must not kill anything). Log lands under
`%USERPROFILE%\.codeatlas\`. Set `$env:CODEATLAS_PORT=5273`, then `start`/`status`/`stop` again to
prove the port override. On Node 24 and later the launcher's `npm ci` must not print DEP0190.

## 2. The live loop

With the launcher running:

```powershell
copy $env:KIT\live-graphs\graph.json $env:USERPROFILE\.codeatlas\live\graph.json
```

The browser at :5173 should render the order-pipeline showcase graph within about a second, with no reload.

Then publish the order-pipeline example. Note that it comes from `docs/examples/`, and that the
destination filename is what `?graph=` looks up:

```powershell
copy $env:REPO\docs\examples\order-pipeline.graph.json $env:USERPROFILE\.codeatlas\live\order-pipeline.json
```

Open `http://localhost:5173/?graph=order-pipeline` — the draft page must show the order pipeline
and never fall back to the sample graph, and the status bar must name the file it is waiting on.
Corrupt the live file by truncating it: the canvas must keep the last good graph and the status
bar must name the problem. Restore it, and it recovers without a reload.

**Feedback edge check:** both edges carrying `"feedback": true` must run UPWARD — "payment failed"
back to pricing, and the mailer back to the customer. If either runs downward you have a stale
copy of the graph rather than a layout bug; diff it against `docs/examples/`.

## 3. fs2ir + validator + irdiff on Windows paths

```powershell
cd $env:REPO
node tools\fs2ir.mjs .\viewer --depth 4 --max-children 20 --sizes -o $env:TEMP\fs.json
node schema\validate.mjs $env:TEMP\fs.json
node tools\fs2ir.mjs C:\nonexistent 2>&1 ; echo $LASTEXITCODE
node tools\fs2ir.mjs .\viewer --depth abc 2>&1 ; echo $LASTEXITCODE
node tools\irdiff.mjs $env:TEMP\fs.json $env:TEMP\fs.json
```

Expected in order: VALID; an error message and exit 1 for the missing root; a usage message and
exit 2 for the bad flag value; an empty diff. Exit codes are 0 ok, 1 root missing or not a
directory, 2 usage. Both error cases are worth running, since they take different paths through
the argument parser.

Inspect `fs.json`: loc `file` values and node ids must use FORWARD slashes, and the root node's
`attrs.absRoot` should be the real Windows path. Try a directory with spaces and a unicode name.

An unreadable directory is easy to hit for real on Windows — `node tools\fs2ir.mjs
C:\Windows\System32 --depth 2` reports several directories under `skipped.unreadable` from ACL
denials. That is correct behaviour, not a failure.

## 4. schema2ir (sample DB in `sample-db\`)

Needs the `sqlite3` CLI on PATH. `winget install SQLite.SQLite` puts it in the user PATH as the
package folder with no `Links` alias, so **open a new shell afterwards** or it will not be found.
If you skip this section, say so in the report; the tools suite skips its sqlite3 tests the same
way rather than failing.

```powershell
cd $env:REPO
node tools\schema2ir.mjs --sqlite $env:KIT\sample-db\shop.sqlite -o $env:TEMP\shop.json
node schema\validate.mjs $env:TEMP\shop.json
node tools\irdiff.mjs $env:KIT\sample-db\shop.expected.json $env:TEMP\shop.json
```

Expected: VALID, with 42 nodes, 48 edges and root `db:shop`; the irdiff should be EMPTY. The
expected file was generated from this exact DB on macOS, so any diff is a portability finding.
Publish the result with `copy $env:TEMP\shop.json $env:USERPROFILE\.codeatlas\live\graph.json` and
check that FK edges render between tables.

## 5. /open + CODEATLAS_ROOTS (Windows delimiter is `;`)

With the viewer up, from PowerShell. Dry mode spawns no editor:

```powershell
curl.exe -s -H "Sec-Fetch-Site: same-origin" "http://localhost:5173/open?file=README.md&line=1&dry"
curl.exe -s -o NUL -w "%{http_code}" "http://localhost:5173/open?file=README.md&line=1&dry"
curl.exe -s -H "Sec-Fetch-Site: same-origin" "http://localhost:5173/open?file=C:\Windows\win.ini&line=1&dry"
```

Expected in order: a resolvable `<abs>:1`; `403`, because the second call sends no
`Sec-Fetch-Site`; and a refusal, because `win.ini` is under neither HOME nor a configured root.

Then set `$env:CODEATLAS_ROOTS="C:\some\other\repo;C:\third"` before `start` and confirm that a
relative loc under one of those resolves. The delimiter is `;` on Windows, not `:`.

Real open, without `&dry`, from the details panel's "Open in editor": the default is
`code -g file:line` when VS Code is on PATH, otherwise the fallback chain of `open -t`, MIME-gated
`xdg-open`, then Notepad — never `start`. `$env:CODEATLAS_EDITOR='notepad {file}'` must override.
VS Code installs `code.cmd`, so this exercises the batch-shim path: confirm the file actually
lands in VS Code and does not silently fall through to Notepad.

## 6. Plugin flow (Claude Code on the Windows box)

Requires `claude` on PATH and a logged-in CLI. The desktop app's bundled CLI reports
`Not logged in` and cannot run this section.

```
claude --plugin-dir <repo>    # from some OTHER project directory
```

Ask it to use the `/codeatlas:viewer` skill with argument `status`, then ask a real diagram
question such as "map this codebase". Checks: skills invoke without a permission wall on the Skill
call itself; the codeatlas skill stages to `%USERPROFILE%\.codeatlas\live\<name>.json` and
publishes with `codeatlas-viewer publish <name>` (validate + rename in one step) — the
transcript must show that command, never an `mv`/`Move-Item` or a direct write of
`graph.json`; `${CLAUDE_PLUGIN_ROOT}` paths resolve (on Windows it expands with FORWARD
slashes: `C:/Users/…/CodeAtlas`).

Why the subcommand exists (2026-09-12): the skill used to end with `mv`, which Claude Code's
own directory fence refuses outright when the live dir is outside the project ("may only
move files to/from the allowed working directories"), and a headless run then improvised by
writing `graph.json` with the Write tool. `publish` sits behind the launcher's Bash
permission, so it needs no `--add-dir`. Exercise it by hand too:

```powershell
copy $env:REPO\docs\examples\order-pipeline.graph.json $env:USERPROFILE\.codeatlas\live\draft.json
.\bin\codeatlas-viewer.cmd publish draft                 # → graph.json, exit 0, prints the URL
.\bin\codeatlas-viewer.cmd publish "C:\some dir\d.json" --to preview   # → live\preview.json, ?graph=preview
.\bin\codeatlas-viewer.cmd publish nothing ; echo $LASTEXITCODE          # 1, names the path it looked for
```

An invalid draft must exit 1 with the validator's errors, stay where it was, and leave the
live file untouched; a `--to` with anything but letters, digits, `_` and `-` exits 2.

Headless smoke test — the pattern must match the skill's QUOTED command, so quote it too
(the bare `Bash(<repo>/bin/codeatlas-viewer *)` never matches and every call is denied):

```powershell
claude --plugin-dir <repo> --allowedTools 'Bash("<repo>/bin/codeatlas-viewer" *)' -p "Use the /codeatlas:viewer skill with argument 'status'"
```

Write `<repo>` with forward slashes, exactly as `${CLAUDE_PLUGIN_ROOT}` expands.

## 7. Big-graph sanity (optional)

```powershell
node tools\fs2ir.mjs C:\Windows\System32 --depth 2 --max-children 5000 --max-nodes 3000 -o $env:USERPROFILE\.codeatlas\live\graph.json
```

(`--max-children 5000`: without it the per-directory cap stops the walk at ~250 nodes, which
tests nothing.) The budget should auto-collapse (status bar: "N auto-collapsed · showing X/Y";
2026-09-12: `78 auto-collapsed · showing 563/3001`, screenshot settled in 4 s) and panning
should stay responsive.

## Reporting

For each section: PASS, or the exact command plus observed versus expected output, with the
Windows and Node versions. File the report next to the previous one in `docs/audit/`.

Known-suspect areas: backslashes leaking into ids or locs, `taskkill` tree kill, the `.cmd` shim
quoting args with spaces, batch shims needing `cmd.exe` to spawn at all, `;` versus `:` in
CODEATLAS_ROOTS, and CRLF checkouts breaking byte-order id sorting in the validator — clone with
`git config core.autocrlf false` and retest if you see sort errors.
