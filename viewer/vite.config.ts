import { defineConfig, type Plugin, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, readFile, stat, truncate } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Roots a loc may resolve against / must lie under. */
export function allowedRoots(root: string | null, roots: readonly string[] = DEFAULT_ROOTS, home = HOME): string[] {
  const out = roots.map(real).filter((r): r is string => !!r);
  if (root && isAbsolute(root)) {
    const r = real(resolve(root));
    const h = real(home);
    if (r && h && isDir(r) && (r === h || insideRoot(h, r))) out.unshift(r);
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
  openHome: boolean = OPEN_HOME
): string | null {
  if (!file || file.includes("\0")) return null;
  const allowed = allowedRoots(root, roots, home);
  const fences = [...allowed, ...(openHome ? [real(home)] : [])].filter((r): r is string => !!r);
  const candidates = isAbsolute(file) ? [file] : allowed.map((r) => resolve(r, file));
  for (const c of candidates) {
    const abs = real(c);
    if (!abs || !isFile(abs)) continue;
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
            `if the project lives elsewhere, start the viewer with CODEATLAS_ROOTS=<dir>` +
            `${delimiter}<dir> (or CODEATLAS_OPEN_HOME=1 to allow anything under your home directory)`
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

const liveDir = process.env.CODEATLAS_LIVE_DIR ? resolve(process.env.CODEATLAS_LIVE_DIR) : null;
const themeCss = process.env.CODEATLAS_THEME_CSS ? resolve(process.env.CODEATLAS_THEME_CSS) : null;
const logFile = process.env.CODEATLAS_LOG ? resolve(process.env.CODEATLAS_LOG) : null;

export default defineConfig({
  plugins: [
    react(),
    guardViteOpenInEditor(),
    openInEditor(),
    userTheme(themeCss),
    ...(liveDir ? [liveDirServer(liveDir)] : []),
    ...(logFile ? [logRotator(logFile)] : []),
  ],
});
