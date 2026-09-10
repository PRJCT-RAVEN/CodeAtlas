import { defineConfig, type Plugin, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, readFile, stat, truncate } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

// GET /open?file=<path>&line=<n>[&root=<abs dir>][&dry] → open the loc in an editor.
//
// Editor: $CODEATLAS_EDITOR is a command template with `{file}` and `{line}`
// placeholders (e.g. `code -g {file}:{line}`, `subl {file}:{line}`,
// `emacsclient -n +{line} {file}`). Without it, the platform default:
// macOS `xed -l` (Xcode) → `open`; Linux `code -g` → `xdg-open`; Windows `code -g`
// → `start`. The primary command falling over (missing or non-zero exit) triggers
// the platform's plain opener.
//
// Resolution:
// - allowed roots = this repo + each dir in $CODEATLAS_ROOTS (path-list delimiter: `:`, `;` on Windows)
//   + `root=` (the root node's attrs.absRoot, sent by the client) IF it is an
//   existing directory under $HOME;
// - a relative `file` resolves against each allowed root in that order; an
//   absolute one is taken as-is;
// - the candidate is realpath-resolved and must be a REGULAR FILE under an
//   allowed root; set CODEATLAS_OPEN_HOME=1 to widen the fence to all of $HOME
//   (cross-repo views without `attrs.absRoot`). System files never open.
// - `dry` validates/resolves without spawning an editor (tests/agents).
//
// Request gate: the endpoint shells out, so (a) Host must be a loopback name
// (a DNS-rebinding page has a foreign Host), (b) Sec-Fetch-Site — stamped by
// every supported browser — must be same-origin or none (address bar, curl),
// (c) the TCP peer must be loopback (headers are just strings: a forwarded or
// exposed port must not turn /open into remote code execution), (d) GET only.
// The generic opener (`open` / `xdg-open` / `start`) is only ever handed files it
// cannot EXECUTE — see `safeForGenericOpen` — and on macOS is forced to `open -t`.
//
// GET /live/<name>.json: when $CODEATLAS_LIVE_DIR is set (the plugin launcher,
// bin/codeatlas-viewer, points it at ~/.codeatlas/live) graphs are served from
// that directory instead of public/live/, so a plugin update never deletes a
// user's views. Missing file → 404 (the poller falls through to the sample).
const viewerDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOTS = [
  resolve(viewerDir, ".."),
  ...(process.env.CODEATLAS_ROOTS ?? "").split(delimiter).filter(Boolean).map((p) => resolve(p)),
];
const HOME = homedir();

function insideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Directories "Open in editor" will never touch, whatever a graph asks for.
 *
 * The fence used to be an allow-list — a graph's `attrs.absRoot` was honoured only
 * under $HOME — which kept /etc out but also broke every legitimate project on
 * another drive or outside the home directory (D:\dev\app, /opt/src, /Volumes/Work).
 * A deny-list is the better trade: the thing that actually bounds the request is
 * "the file must live inside the root the graph names", and this list keeps that
 * root from being somewhere it has no business being.
 *
 * Threat model: to reach here an attacker needs a hostile graph in the live dir AND
 * a click on a crafted node. Anyone who can write to the live dir already has code
 * execution as this user; the realistic case is a SHARED diagram. The damage is
 * bounded anyway — the file opens in a text editor, and `safeForGenericOpen` already
 * refuses runnable types.
 */
export function systemPrefixes(os: string = platform(), home = HOME): string[] {
  if (os === "win32") {
    const sysDrive = process.env.SystemDrive ?? "C:";
    return [
      `${sysDrive}\\Windows`,
      `${sysDrive}\\Program Files`,
      `${sysDrive}\\Program Files (x86)`,
      `${sysDrive}\\ProgramData`,
      join(home, "AppData"),
    ];
  }
  // OS binaries, config and device trees. Deliberately NOT /var: the sensitive parts
  // of it are unreadable to a normal user anyway, and on macOS $TMPDIR lives under
  // /private/var, so denying it would refuse ordinary scratch directories.
  const unix = ["/etc", "/usr", "/bin", "/sbin", "/dev", "/proc", "/sys", "/private/etc"];
  // macOS: the system volume and the machine-wide app-support tree, plus the user's
  // own ~/Library (keychains, app data, browser profiles — not source code)
  return os === "darwin" ? [...unix, "/System", "/Library", join(home, "Library")] : unix;
}

/** True when `abs` is a system location no diagram has any business opening. */
export function isSystemPath(abs: string, os: string = platform(), home = HOME): boolean {
  return systemPrefixes(os, home).some((p) => abs === p || insideRoot(p, abs));
}

/**
 * Roots a loc may resolve against / must lie under.
 *
 * A client-supplied `root=` (the graph's `attrs.absRoot`) is accepted anywhere it
 * names a real directory that is not itself a system location — so a project on any
 * drive works with no configuration. `$CODEATLAS_ROOTS` still adds roots explicitly.
 */
export function allowedRoots(
  root: string | null,
  roots: readonly string[] = DEFAULT_ROOTS,
  home = HOME,
  os: string = platform()
): string[] {
  const out = roots.map(real).filter((r): r is string => !!r);
  if (root && isAbsolute(root)) {
    const r = real(resolve(root));
    if (r && isDir(r) && !isSystemPath(r, os, home)) out.unshift(r);
  }
  return out;
}

export const OPEN_HOME = process.env.CODEATLAS_OPEN_HOME === "1";

/** Resolve a loc file to an existing, allowed, regular file — or null. */
export function resolveLocFile(
  file: string,
  root: string | null,
  roots: readonly string[] = DEFAULT_ROOTS,
  home = HOME,
  openHome: boolean = OPEN_HOME,
  os: string = platform()
): string | null {
  if (!file || file.includes("\0")) return null;
  const allowed = allowedRoots(root, roots, home, os);
  const fences = [...allowed, ...(openHome ? [real(home)] : [])].filter((r): r is string => !!r);
  const candidates = isAbsolute(file) ? [file] : allowed.map((r) => resolve(r, file));
  for (const c of candidates) {
    const abs = real(c);
    if (!abs || !isFile(abs)) continue;
    // realpath first, THEN the deny-list: a symlink inside an allowed root that
    // points at /etc/passwd must not get through on the strength of its own path
    if (isSystemPath(abs, os, home)) continue;
    if (fences.some((f) => insideRoot(f, abs))) return abs;
  }
  return null;
}

export function hostAllowed(host: string | undefined): boolean {
  return typeof host === "string" && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

export function sameOrigin(headers: IncomingMessage["headers"]): boolean {
  if (!hostAllowed(headers.host)) return false;
  const site = headers["sec-fetch-site"];
  return site === "same-origin" || site === "none";
}

/**
 * A request this dev server may act on.
 *
 * Two independent checks, because they stop different attacks:
 *  - `loopbackPeer` — the connection really came from this machine (blocks anything
 *    routed in from the network);
 *  - `hostAllowed` — the client asked for a loopback name. A DNS-rebinding page
 *    resolves its own domain to 127.0.0.1, so it PASSES the peer check; the Host
 *    header is what still says `evil.example`.
 * Every route that reads local files or shells out needs both.
 */
export function localRequest(req: IncomingMessage): boolean {
  return loopbackPeer(req.socket.remoteAddress) && hostAllowed(req.headers.host);
}

export type EditorCommand = { cmd: string; args: string[] };

/** Extensions LaunchServices / xdg-open / Explorer may RUN rather than display. */
export const RUNNABLE_EXTENSIONS = new Set([
  "command", "tool", "workflow", "action", "app", "scpt", "applescript", "jar",
  "pkg", "mpkg", "dmg", "terminal", "desktop", "exe", "bat", "cmd", "ps1", "msi",
  "vbs", "vbe", "jse", "wsf", "wsh", "hta", "lnk", "url", "scr", "pif", "reg", "msc", "cpl",
]);

/**
 * Linux has no "open in a text editor, never run" opener: xdg-open follows the
 * MIME association, so it is only used for files `file(1)` calls text-like.
 * No `file` → no generic fallback (an editor template still works).
 */
export function linuxTextLike(abs: string): boolean {
  const r = spawnSync("file", ["--mime-type", "-b", abs], { encoding: "utf8" });
  if (r.status !== 0) return false;
  return /^text\/|json|xml|javascript|x-empty/.test(r.stdout.trim());
}

/** Not executable and not a double-click-to-run type → safe for the generic opener. */
export function safeForGenericOpen(abs: string, mode?: number): boolean {
  const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
  if (abs.includes(".") && RUNNABLE_EXTENSIONS.has(ext)) return false;
  let m = mode;
  if (m === undefined) {
    try {
      m = statSync(abs).mode;
    } catch {
      return false;
    }
  }
  return (m & 0o111) === 0;
}

/** Both placeholders in one pass, so a `{line}` inside the path is never re-substituted. */
export function substituteToken(token: string, abs: string, line: string): string {
  return token.replace(/\{file\}|\{line\}/g, (m) => (m === "{file}" ? abs : line));
}

export function loopbackPeer(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Editor command chain for a loc: [primary, fallback?]. `template` is
 * $CODEATLAS_EDITOR — whitespace-separated tokens; every token has `{file}` and
 * `{line}` substituted AFTER splitting, so a path with spaces stays one argument.
 * The generic-opener fallback is omitted for files it could execute; `safe`
 * defaults to a stat of `abs` (tests pass it explicitly).
 */
export function editorCommands(
  abs: string,
  line: string,
  template: string | undefined = process.env.CODEATLAS_EDITOR,
  os: string = platform(),
  safe: boolean = safeForGenericOpen(abs)
): EditorCommand[] {
  // every fallback is a text editor, never a "start"/association launch: `open -t`
  // (macOS), Notepad (Windows — `start` would run .js/.vbs/.hta through WSH),
  // xdg-open only for MIME-text files (Linux, see linuxTextLike)
  const opener: EditorCommand =
    os === "darwin" ? { cmd: "open", args: ["-t", abs] }
    : os === "win32" ? { cmd: "notepad.exe", args: [abs] }
    : { cmd: "xdg-open", args: [abs] };
  const fallback = safe ? [opener] : [];
  const tokens = (template ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    const [cmd, ...rest] = tokens.map((t) => substituteToken(t, abs, line));
    return [{ cmd, args: rest }, ...fallback];
  }
  const primary: EditorCommand =
    os === "darwin" ? { cmd: "xed", args: ["-l", line, abs] } : { cmd: "code", args: ["-g", `${abs}:${line}`] };
  return [primary, ...fallback];
}

// --- editor spawning -----------------------------------------------------------
// Windows: `code` on PATH is code.cmd. Node refuses to start a batch file without a shell
// (CVE-2024-27980) and CreateProcess does not find one by bare name, so the default
// `code -g` chain fell through to Notepad on every Windows box with VS Code installed
// (found 2026-09-07). Batch files go through `cmd.exe /d /s /c` with cross-spawn's quoting;
// everything else spawns directly.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One cmd.exe argument: quoted, meta chars caret-escaped — twice when the target is a .cmd/.bat (it re-parses %*). */
export function cmdEscapeArg(arg: string, doubleEscape = false): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = ('"' + a + '"').replace(CMD_META, "^$1");
  return doubleEscape ? a.replace(CMD_META, "^$1") : a;
}

/** The command token for cmd.exe: meta chars (spaces included) caret-escaped, never quoted. */
export function cmdEscapeCommand(cmd: string): string {
  return cmd.replace(CMD_META, "^$1");
}

/** PATH (+ PATHEXT on Windows) lookup: the file `cmd` names, or null. A cmd containing a separator is checked as given. */
export function resolveOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = (env.PATHEXT ?? (platform() === "win32" ? ".COM;.EXE;.BAT;.CMD" : "")).split(";").filter(Boolean);
  // With PATHEXT in play only those extensions are runnable: VS Code ships an extensionless
  // `code` shell script next to code.cmd, and CreateProcess would never run that one.
  const hasExt = exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()));
  const dirs = /[\\/]/.test(cmd) ? [""] : (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const base = d ? join(d, cmd) : cmd;
    const candidates = exts.length === 0 || hasExt ? [base] : exts.map((e) => base + e);
    for (const c of candidates) if (isFile(c)) return c;
  }
  return null;
}

/** Detached, output-less spawn that also runs Windows batch shims (code.cmd, subl.cmd, …). */
export function spawnDetached(cmd: string, args: string[]): ChildProcess {
  if (platform() === "win32") {
    const file = resolveOnPath(cmd);
    if (file && /\.(cmd|bat)$/i.test(file)) {
      const line = [cmdEscapeCommand(cmd), ...args.map((a) => cmdEscapeArg(a, true))].join(" ");
      return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", '"' + line + '"'], {
        stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: true,
      });
    }
  }
  return spawn(cmd, args, { stdio: "ignore", detached: true });
}

function runChain(chain: EditorCommand[]): void {
  const [first, ...rest] = chain;
  if (!first) return;
  const fallback = () => runChain(rest);
  let child;
  try {
    child = spawnDetached(first.cmd, first.args);
  } catch {
    // spawn() THROWS for some failures (a bad argv, an unresolvable batch file)
    // rather than emitting 'error'; without this the throw escaped the handler
    // instead of falling through to the next editor in the chain.
    fallback();
    return;
  }
  child.on("error", fallback); // command not installed
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) fallback(); // present but refused the file
  });
  child.unref();
}

const openInEditor = (): Plugin => ({
  name: "codeatlas-open-in-editor",
  configureServer(server) {
    const handler: Connect.NextHandleFunction = (req, res: ServerResponse) => {
      res.setHeader("content-type", "text/plain");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end("/open is GET only");
        return;
      }
      if (!loopbackPeer(req.socket.remoteAddress) || !sameOrigin(req.headers)) {
        res.statusCode = 403;
        res.end("cross-origin or non-loopback /open refused");
        return;
      }
      const url = new URL(req.url ?? "", "http://localhost");
      const file = url.searchParams.get("file") ?? "";
      const root = url.searchParams.get("root");
      const lineRaw = url.searchParams.get("line") ?? "1";
      if (!/^\d{1,8}$/.test(lineRaw) || Number(lineRaw) < 1) {
        res.statusCode = 400;
        res.end(`line must be a positive integer (≤ 10000000), got: ${lineRaw}`);
        return;
      }
      const line = String(Number(lineRaw));
      const dry = url.searchParams.has("dry");
      const abs = resolveLocFile(file, root);
      if (!abs) {
        // Name the roots that were tried and the way out. A client-supplied
        // `root=` is only honoured under $HOME (a graph could otherwise point it
        // at "/" and open anything), so a project on another drive or outside the
        // home directory needs CODEATLAS_ROOTS — which nobody could guess from
        // "cannot resolve".
        res.statusCode = 404;
        res.end(
          `cannot resolve to an existing file: ${file}\n` +
            `tried: ${allowedRoots(root).join(", ") || "(no roots)"}\n` +
            `a graph's root (attrs.absRoot) is honoured on any drive, so this is usually a` +
            ` missing file or a path outside it; CODEATLAS_ROOTS=<dir>${delimiter}<dir> adds roots explicitly`
        );
        return;
      }
      if (dry) {
        res.statusCode = 200;
        res.end(`resolvable ${abs}:${line}`);
        return;
      }
      const safe = safeForGenericOpen(abs) && (platform() !== "linux" || linuxTextLike(abs));
      const chain = editorCommands(abs, line, undefined, platform(), safe);
      runChain(chain);
      res.statusCode = 200;
      res.end(`opened ${abs}:${line}${chain.length === 1 ? " (runnable file: editor only, no generic opener)" : ""}`);
    };
    server.middlewares.use("/open", handler);
  },
});

/** `/live/<name>.json` file name → path under liveDir, or null if not a plain graph name. */
export function liveFilePath(urlPath: string, liveDir: string): string | null {
  const m = /^\/?([A-Za-z0-9_-]+\.json)$/.exec(urlPath.split("?")[0] ?? "");
  return m ? resolve(liveDir, m[1]) : null;
}

/** Largest graph file served. Polling is conditional (ETag → 304), so a big file is only transferred when it changes. */
export const MAX_LIVE_BYTES = 256 * 1024 * 1024;

/** Weak validator from size + mtime — what sirv does for public/, so both modes behave alike. */
export function liveEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

/** True when the client's If-None-Match names this etag (any of a comma list, or `*`). */
export function notModified(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  return raw.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || v === etag.replace(/^W\//, "") || `W/${v}` === etag;
  });
}

const liveDirServer = (liveDir: string): Plugin => ({
  name: "codeatlas-live-dir",
  configureServer(server) {
    const handler: Connect.NextHandleFunction = (req, res: ServerResponse, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      // Both checks: a rebinding page passes the peer check but not the Host one.
      // These graphs carry absolute paths and the structure of private projects.
      if (!localRequest(req)) {
        res.statusCode = 403;
        res.setHeader("content-type", "text/plain");
        res.end("cross-origin /live refused");
        return;
      }
      const path = liveFilePath(req.url ?? "", liveDir);
      if (!path) return next();
      stat(path)
        .then((st) => {
          if (!st.isFile()) throw new Error("not a file");
          if (st.size > MAX_LIVE_BYTES) {
            res.statusCode = 413;
            res.setHeader("content-type", "text/plain");
            res.end(`graph is ${st.size} bytes; the viewer serves at most ${MAX_LIVE_BYTES}`);
            return null;
          }
          const etag = liveEtag(st.size, st.mtimeMs);
          res.setHeader("etag", etag);
          res.setHeader("cache-control", "no-store");
          if (notModified(req.headers["if-none-match"], etag)) {
            res.statusCode = 304;
            res.end();
            return null;
          }
          return readFile(path);
        })
        .then((buf) => {
          if (buf === null) return;
          res.setHeader("content-type", "application/json");
          res.statusCode = 200;
          res.end(req.method === "HEAD" ? undefined : buf);
        })
        .catch(() => {
          res.statusCode = 404;
          res.setHeader("content-type", "text/plain");
          res.end(`no such graph in ${liveDir}`);
        });
    };
    server.middlewares.use("/live", handler);
  },
});

/**
 * The launcher redirects vite's stdout/stderr into $CODEATLAS_LOG with O_APPEND.
 * A long healthy run never restarts, so rotate from inside: copy-then-truncate
 * (appenders keep writing at the new end) once the file passes MAX_LOG_BYTES.
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
const logRotator = (log: string): Plugin => ({
  name: "codeatlas-log-rotate",
  configureServer(server) {
    const check = async () => {
      try {
        const st = await stat(log);
        if (st.size > MAX_LOG_BYTES) {
          await copyFile(log, `${log}.1`);
          await truncate(log, 0);
        }
      } catch {
        /* log missing or unreadable — nothing to rotate */
      }
    };
    const timer = setInterval(check, 60_000);
    timer.unref();
    server.httpServer?.once("close", () => clearInterval(timer));
  },
});

/** `/theme.css` → the user's override file (CODEATLAS_THEME_CSS, ~/.codeatlas/theme.css) or 404. */
const userTheme = (file: string | null): Plugin => ({
  name: "codeatlas-user-theme",
  configureServer(server) {
    const handler: Connect.NextHandleFunction = (req, res: ServerResponse, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if ((req.url ?? "").split("?")[0] !== "/") return next();
      if (!localRequest(req)) {
        res.statusCode = 403;
        res.setHeader("content-type", "text/plain");
        res.end("cross-origin /theme.css refused");
        return;
      }
      res.setHeader("cache-control", "no-store");
      (file ? readFile(file) : Promise.reject(new Error("no theme file"))).then(
        (buf) => {
          res.setHeader("content-type", "text/css");
          res.statusCode = 200;
          res.end(req.method === "HEAD" ? undefined : buf);
        },
        () => {
          res.setHeader("content-type", "text/plain");
          res.statusCode = 404;
          res.end("no user theme (create ~/.codeatlas/theme.css — see docs/theme.example.css)");
        }
      );
    };
    server.middlewares.use("/theme.css", handler);
  },
});

/**
 * Vite ships its own `/__open-in-editor` (the error overlay's click-to-source).
 * It takes any path, has no fence, and — unlike our `/open` — no origin check, so
 * an `<img src="http://localhost:5173/__open-in-editor?file=...">` on ANY page the
 * user visits makes their editor open that file. CORS does not help: the damage is
 * the side effect, not the response.
 *
 * A `configureServer` hook runs before vite installs its own middlewares, so this
 * shadows it. We gate rather than remove: same-origin requests (the overlay itself)
 * still work, cross-origin ones get 403.
 */
const guardViteOpenInEditor = (): Plugin => ({
  name: "codeatlas-guard-vite-open-in-editor",
  configureServer(server) {
    server.middlewares.use("/__open-in-editor", (req, res: ServerResponse, next) => {
      if (localRequest(req) && sameOrigin(req.headers)) return next();
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain");
      res.end("cross-origin /__open-in-editor refused");
    });
  },
});

/**
 * Exit when the plugin that started us is uninstalled.
 *
 * The viewer is spawned detached, so `/plugin uninstall` removed the plugin — and
 * with it the only tool that could stop the daemon — while vite kept serving :5173
 * forever. Nothing on the machine knew what that process was any more.
 *
 * Watch for the plugin manifest and exit once it has been gone for a while. The
 * grace period matters: a plugin UPDATE can briefly replace the directory, and
 * killing the viewer mid-update would be its own bug.
 */
const UNINSTALL_CHECK_MS = Number(process.env.CODEATLAS_UNINSTALL_CHECK_MS) || 20_000; // overridable so the test does not take a minute
const UNINSTALL_STRIKES = 3; // ~60 s gone before we believe it
const uninstallWatchdog = (marker: string): Plugin => ({
  name: "codeatlas-uninstall-watchdog",
  configureServer(server) {
    let missing = 0;
    const timer = setInterval(() => {
      if (existsSync(marker)) {
        missing = 0;
        return;
      }
      if (++missing < UNINSTALL_STRIKES) return;
      clearInterval(timer);
      server.config.logger.warn(
        `[codeatlas] the plugin at ${dirname(dirname(marker))} is gone (checked ${UNINSTALL_STRIKES} times over ` +
          `${Math.round((UNINSTALL_CHECK_MS * UNINSTALL_STRIKES) / 1000)}s) — shutting the viewer down so it does not outlive its uninstall`
      );
      // `server.close()` waits for open connections, and an orphaned viewer almost
      // always HAS one — a forgotten browser tab holding the HMR socket is exactly
      // why it is still running. Give the graceful close a moment, then go anyway.
      const bye = () => process.exit(0);
      setTimeout(bye, 3000);
      server.close().then(bye, bye);
    }, UNINSTALL_CHECK_MS);
    // deliberately NOT unref'd: this timer is the only thing that stops an orphaned
    // daemon, and it must run for as long as the server does — but no longer. A closed
    // server that keeps an un-unref'd interval alive holds the whole process open, which
    // is a hang for anything that boots this config in-process and closes it again.
    server.httpServer?.once("close", () => clearInterval(timer));
  },
});

/**
 * Loopback: answer on BOTH families, and never off this machine.
 *
 * A listening socket has ONE address, and vite's default host (`localhost`) resolves to
 * one too — on macOS `::1` — so `http://127.0.0.1:5173` was refused while
 * `http://localhost:5173` worked. Browsers and curl retry the other family, but a
 * hardcoded IPv4 URL in a script, a probe or a proxy has nothing to retry.
 *
 * So bind IPv4 (`server.host` below — the address the launcher's port probe and the Swift
 * `codeatlas serve` both use, so `--strictPort` now sees a real conflict) and let this
 * plugin add a second listener on `::1` sharing the same middleware stack.
 *
 * Best effort by design: no IPv6 on the machine, or something else already on
 * `[::1]:<port>`, is a warning, not a failed start. Only the two loopback literals are
 * ever bound — `/open` shells out, so the dev server must stay unreachable from the
 * network however this is configured.
 */
export const HOST = "127.0.0.1";
export const HOST6 = "::1";

const loopbackTwin = (): Plugin => ({
  name: "codeatlas-loopback-twin",
  configureServer(server) {
    const primary = server.httpServer;
    if (!primary) return; // middleware mode: whoever embeds us owns the socket
    // configureServer runs before listen(), so this is registered ahead of vite's own
    // 'listening' callback
    primary.once("listening", () => {
      const addr = primary.address();
      // mirror our own bind only: a `--host` on the command line means the user asked
      // for something else, and mirroring an exposed bind would widen it
      if (!addr || typeof addr === "string" || addr.address !== HOST) return;
      const twin = createHttpServer(server.middlewares);
      // HMR is hooked to the PRIMARY's 'upgrade' event; hand the raw socket over as-is
      twin.on("upgrade", (req, socket, head) => primary.emit("upgrade", req, socket, head));
      const onBindError = (err: NodeJS.ErrnoException) => {
        // EADDRINUSE is NOT a missing-IPv6 box: something else holds [::1]:<port>, and on
        // a dual-stack machine `localhost` usually resolves to ::1 first — so the user's
        // browser would reach THAT server at the address we just printed. --strictPort
        // exists to make exactly this impossible, and it only guards the 127.0.0.1 bind.
        // Refuse the same way vite refuses a taken port, rather than warn and serve a name
        // that points somewhere else.
        if (err.code === "EADDRINUSE") {
          server.config.logger.error(
            `[codeatlas] [${HOST6}]:${addr.port} is already in use by another process — ` +
              `http://localhost:${addr.port}/ would reach it, not this viewer. Refusing to start; ` +
              `stop that process or pick another port.`
          );
          void server.close().finally(() => process.exit(1));
          return;
        }
        // no IPv6 at all (EAFNOSUPPORT / EADDRNOTAVAIL), or the OS declined it: the
        // 127.0.0.1 front door is unaffected, and `localhost` falls back to it
        server.config.logger.warn(
          `[codeatlas] no IPv6 loopback listener on [${HOST6}]:${addr.port} (${err.message}) — http://${HOST}:${addr.port}/ is unaffected`
        );
      };
      twin.once("error", onBindError);
      twin.listen(addr.port, HOST6, () => {
        // Past the bind, a stray error is not a bind failure: keeping onBindError attached
        // made every later socket error claim the ::1 listener never came up.
        twin.removeListener("error", onBindError);
        twin.on("error", (err: Error) => server.config.logger.warn(`[codeatlas] [${HOST6}]:${addr.port}: ${err.message}`));
      });
      twin.unref(); // the primary decides how long the process lives
      primary.once("close", () => twin.close());
    });
  },
});

const liveDir = process.env.CODEATLAS_LIVE_DIR ? resolve(process.env.CODEATLAS_LIVE_DIR) : null;
const themeCss = process.env.CODEATLAS_THEME_CSS ? resolve(process.env.CODEATLAS_THEME_CSS) : null;
const logFile = process.env.CODEATLAS_LOG ? resolve(process.env.CODEATLAS_LOG) : null;

export default defineConfig({
  server: { host: HOST },
  plugins: [
    react(),
    loopbackTwin(),
    guardViteOpenInEditor(),
    openInEditor(),
    userTheme(themeCss),
    ...(liveDir ? [liveDirServer(liveDir)] : []),
    // only for a launcher-started daemon: a hand-run `npm run dev` is the developer's
    // to manage, and they can see it in their own terminal
    ...(liveDir ? [uninstallWatchdog(resolve(viewerDir, "..", ".claude-plugin", "plugin.json"))] : []),
    ...(logFile ? [logRotator(logFile)] : []),
  ],
});
