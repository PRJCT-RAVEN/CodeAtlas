// /open endpoint resolution + request gate (viewer/vite.config.ts).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { resolveLocFile, allowedRoots, isSystemPath, systemPrefixes, sameOrigin, hostAllowed, localRequest, editorCommands, liveFilePath, safeForGenericOpen, substituteToken, loopbackPeer, liveEtag, notModified, cmdEscapeArg, cmdEscapeCommand, resolveOnPath, spawnDetached } from "../vite.config";

// a fake $HOME with a repo inside it and a file outside it
const home = realpathSync(mkdtempSync(join(tmpdir(), "codeatlas-home-")));
const repo = join(home, "repo");
mkdirSync(join(repo, "Sources"), { recursive: true });
writeFileSync(join(repo, "Sources", "A.swift"), "struct A {}\n");
const other = join(home, "other");
mkdirSync(other, { recursive: true });
writeFileSync(join(other, "note.md"), "# hi\n");
const outside = realpathSync(mkdtempSync(join(tmpdir(), "codeatlas-outside-")));
writeFileSync(join(outside, "secret.txt"), "x\n");
// Windows needs Developer Mode or elevation to create symlinks: only the symlink case is skipped there.
let canSymlink = true;
try {
  symlinkSync(join(outside, "secret.txt"), join(repo, "Sources", "link.txt"));
symlinkSync("/etc/hosts", join(repo, "Sources", "etc-link.txt")); // must not inherit the repo's blessing
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
  canSymlink = false;
}

describe("resolveLocFile", () => {
  it("resolves a repo-relative loc against the default root", () => {
    expect(resolveLocFile("Sources/A.swift", null, [repo], home)).toBe(join(repo, "Sources", "A.swift"));
  });
  it("resolves against root= when it lives under $HOME", () => {
    expect(resolveLocFile("note.md", other, [repo], home)).toBe(join(other, "note.md"));
  });
  it("honours a root= on any drive, not just under $HOME", () => {
    // the old rule dropped a root outside $HOME, which killed "Open in editor" for
    // every project on another drive or in /opt
    expect(allowedRoots(outside, [repo], home)).toEqual([outside, repo]);
    expect(resolveLocFile("secret.txt", outside, [repo], home)).toBe(join(outside, "secret.txt"));
  });
  it("blocks relative traversal", () => {
    expect(resolveLocFile("../../../../etc/hosts", null, [repo], home)).toBeNull();
    expect(resolveLocFile("../other/note.md", repo, [repo], home, false)).toBeNull(); // outside every root
    expect(resolveLocFile("../other/note.md", repo, [repo], home, true)).toBe(join(other, "note.md")); // CODEATLAS_OPEN_HOME=1
  });
  it("fences absolute files to the roots unless $HOME is opted in; refuses system files always", () => {
    expect(resolveLocFile(join(repo, "Sources", "A.swift"), null, [repo], home, false)).toBe(join(repo, "Sources", "A.swift"));
    expect(resolveLocFile(join(other, "note.md"), null, [repo], home, false)).toBeNull();
    expect(resolveLocFile(join(other, "note.md"), null, [repo], home, true)).toBe(join(other, "note.md"));
    expect(resolveLocFile("/etc/hosts", null, [repo], home, true)).toBeNull();
  });
  it("refuses directories", () => {
    expect(resolveLocFile("Sources", null, [repo], home)).toBeNull();
    expect(resolveLocFile(repo, null, [repo], home)).toBeNull();
  });
  it.skipIf(!canSymlink)("refuses symlinks that escape the fences", () => {
    expect(resolveLocFile("Sources/link.txt", null, [repo], home)).toBeNull();
  });
  it("returns null for empty / NUL / missing", () => {
    expect(resolveLocFile("", null, [repo], home)).toBeNull();
    expect(resolveLocFile("Sources/A.swift\0", null, [repo], home)).toBeNull();
    expect(resolveLocFile("Sources/B.swift", null, [repo], home)).toBeNull();
  });
});

describe("request gate", () => {
  it("accepts loopback hosts only", () => {
    for (const h of ["localhost", "localhost:5173", "127.0.0.1:5173", "[::1]:5173"]) expect(hostAllowed(h), h).toBe(true);
    for (const h of ["evil.com:5173", "localhost.evil.com", "10.0.0.5:5173", undefined]) expect(hostAllowed(h), String(h)).toBe(false);
  });
  it("requires Sec-Fetch-Site same-origin/none", () => {
    expect(sameOrigin({ host: "localhost:5173", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(sameOrigin({ host: "localhost:5173", "sec-fetch-site": "none" })).toBe(true);
    expect(sameOrigin({ host: "localhost:5173", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(sameOrigin({ host: "localhost:5173", "sec-fetch-site": "same-site" })).toBe(false);
    expect(sameOrigin({ host: "localhost:5173" })).toBe(false); // legacy no-header path is gone
    expect(sameOrigin({ host: "localhost:5173", origin: "http://localhost:5173" })).toBe(false);
  });
  it("rejects DNS-rebinding hosts even with same-origin", () => {
    expect(sameOrigin({ host: "evil.com:5173", "sec-fetch-site": "same-origin" })).toBe(false);
  });
});

describe("editorCommands", () => {
  it("expands a $CODEATLAS_EDITOR template, keeping a path with spaces as one argument", () => {
    const chain = editorCommands("/h/my dir/a.ts", "12", "code -g {file}:{line}", "linux", true);
    expect(chain[0]).toEqual({ cmd: "code", args: ["-g", "/h/my dir/a.ts:12"] });
    expect(chain[1]).toEqual({ cmd: "xdg-open", args: ["/h/my dir/a.ts"] });
    expect(editorCommands("/h/a.ts", "3", "emacsclient -n +{line} {file}", "darwin", true)[0]).toEqual({
      cmd: "emacsclient",
      args: ["-n", "+3", "/h/a.ts"],
    });
  });
  it("falls back to per-platform defaults without a template", () => {
    expect(editorCommands("/h/a.swift", "7", undefined, "darwin", true)).toEqual([
      { cmd: "xed", args: ["-l", "7", "/h/a.swift"] },
      { cmd: "open", args: ["-t", "/h/a.swift"] },
    ]);
    expect(editorCommands("/h/a.ts", "7", "", "linux", true)).toEqual([
      { cmd: "code", args: ["-g", "/h/a.ts:7"] },
      { cmd: "xdg-open", args: ["/h/a.ts"] },
    ]);
    expect(editorCommands("C:\\h\\a.ts", "7", undefined, "win32", true)[1]).toEqual({
      cmd: "notepad.exe",
      args: ["C:\\h\\a.ts"],
    });
    // never `start`: Windows would run .js/.vbs/.hta through the shell association
    for (const os of ["win32", "linux", "darwin"]) expect(editorCommands("/h/x.js", "1", undefined, os, true).every((c) => c.cmd !== "cmd")).toBe(true);
    for (const f of ["/h/x.vbs", "/h/x.hta", "/h/x.lnk", "/h/x.reg"]) expect(safeForGenericOpen(f, 0o644), f).toBe(false);
  });
});

describe("liveFilePath", () => {
  it("maps plain graph names under the live dir and rejects anything else", () => {
    expect(liveFilePath("/graph.json", "/data/live")).toBe(resolve("/data/live", "graph.json")); // resolve, not join: the live dir is made absolute (drive letter on Windows)
    expect(liveFilePath("draft-1.json?x=1", "/data/live")).toBe(resolve("/data/live", "draft-1.json"));
    for (const bad of ["/../secret.json", "/a/b.json", "/graph.txt", "/", "", "/.json", "/%2e%2e/x.json"]) {
      expect(liveFilePath(bad, "/data/live"), bad).toBeNull();
    }
  });
});

describe("review fixes (2026-09-05)", () => {
  it("omits the generic opener for runnable files and forces `open -t` on macOS", () => {
    expect(editorCommands("/h/a.swift", "1", undefined, "darwin", true)).toEqual([
      { cmd: "xed", args: ["-l", "1", "/h/a.swift"] },
      { cmd: "open", args: ["-t", "/h/a.swift"] },
    ]);
    expect(editorCommands("/h/setup.command", "1", undefined, "darwin", false)).toEqual([{ cmd: "xed", args: ["-l", "1", "/h/setup.command"] }]);
    expect(editorCommands("/h/x.sh", "1", "code -g {file}:{line}", "linux", false)).toEqual([{ cmd: "code", args: ["-g", "/h/x.sh:1"] }]);
  });
  it("classifies runnable files by extension and executable bit", () => {
    expect(safeForGenericOpen("/h/a.swift", 0o644)).toBe(true);
    expect(safeForGenericOpen("/h/build.sh", 0o755)).toBe(false);
    for (const f of ["/h/x.command", "/h/X.JAR", "/h/y.app", "/h/z.desktop", "/h/w.exe"]) expect(safeForGenericOpen(f, 0o644), f).toBe(false);
    expect(safeForGenericOpen("/h/noext", 0o644)).toBe(true);
    expect(safeForGenericOpen("/definitely/missing/file.ts")).toBe(false);
  });
  it("substitutes both placeholders in one pass", () => {
    expect(substituteToken("{file}:{line}", "/d/{line}.ts", "7")).toBe("/d/{line}.ts:7");
    expect(substituteToken("+{line}", "/f", "3")).toBe("+3");
  });
  it("accepts only loopback peers", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(loopbackPeer(a)).toBe(true);
    for (const a of ["10.0.0.5", "::ffff:10.0.0.5", "192.168.1.2", undefined]) expect(loopbackPeer(a)).toBe(false);
  });
});

describe("conditional polling helpers", () => {
  it("builds a weak etag from size and mtime and recognises it in If-None-Match", () => {
    const tag = liveEtag(1234, 1725000000123.7);
    expect(tag).toBe('W/"1234-1725000000123"');
    expect(notModified(tag, tag)).toBe(true);
    expect(notModified('"1234-1725000000123"', tag)).toBe(true); // strong form of the same validator
    expect(notModified("*", tag)).toBe(true);
    expect(notModified(`"other", ${tag}`, tag)).toBe(true);
    expect(notModified(undefined, tag)).toBe(false);
    expect(notModified('W/"1-2"', tag)).toBe(false);
  });
});

// --- localRequest: the DNS-rebinding gate on /live, /theme.css and vite's own
// /__open-in-editor. A rebinding page connects from loopback (peer check passes)
// but still asks for its own hostname (Host check catches it).

describe("localRequest", () => {
  const req = (remoteAddress: string | undefined, host: string | undefined) =>
    ({ socket: { remoteAddress }, headers: { host } }) as unknown as Parameters<typeof localRequest>[0];

  it("accepts a loopback peer asking for a loopback host", () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      for (const host of ["localhost:5173", "127.0.0.1:5173", "[::1]:5173"])
        expect(localRequest(req(peer, host)), `${peer} / ${host}`).toBe(true);
  });

  it("refuses a DNS-rebinding request: loopback peer, foreign Host", () => {
    expect(localRequest(req("127.0.0.1", "evil.example:5173"))).toBe(false);
    expect(localRequest(req("127.0.0.1", "localhost.evil.example"))).toBe(false);
    expect(localRequest(req("127.0.0.1", undefined))).toBe(false);
  });

  it("refuses a peer that is not loopback even with a good Host", () => {
    expect(localRequest(req("10.0.0.5", "localhost:5173"))).toBe(false);
    expect(localRequest(req(undefined, "localhost:5173"))).toBe(false);
  });
});

describe("Windows editor spawning (2026-09-07)", () => {
  it("cmd.exe quoting: quotes and caret-escapes an argument, twice for batch targets", () => {
    expect(cmdEscapeArg("-g")).toBe('^"-g^"');
    expect(cmdEscapeArg("C:\\a b\\c.ts:2")).toBe('^"C:\\a^ b\\c.ts:2^"');
    expect(cmdEscapeArg("-g", true)).toBe('^^^"-g^^^"');
    expect(cmdEscapeCommand("C:\\Program Files\\x\\code.cmd")).toBe("C:\\Program^ Files\\x\\code.cmd");
  });
  it("resolveOnPath finds a file through PATH and PATHEXT, and returns null when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeatlas-path-"));
    writeFileSync(join(dir, "mytool.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "mytool"), "#!/bin/sh\n"); // VS Code ships this pair: the extensionless script must never win
    const env = { PATH: dir, PATHEXT: ".com;.exe;.bat;.cmd" }; // lowercase: the exact on-disk name comes back on case-sensitive file systems too
    expect(resolveOnPath("mytool", env)).toBe(join(dir, "mytool.cmd"));
    expect(resolveOnPath("mytool.cmd", env)).toBe(join(dir, "mytool.cmd"));
    expect(resolveOnPath(join(dir, "mytool.cmd"), { PATH: "" })).toBe(join(dir, "mytool.cmd"));
    expect(resolveOnPath("nothing-here", env)).toBeNull();
  });
  it.skipIf(platform() !== "win32")("spawnDetached runs a .cmd shim through cmd.exe with its arguments intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeatlas-shim-"));
    writeFileSync(join(dir, "echoargs.cmd"), '@echo %* > "%~dp0out.txt"\r\n');
    const saved = process.env.PATH;
    process.env.PATH = dir + ";" + saved;
    try {
      const child = spawnDetached("echoargs", ["hello world", "C:\\x\\y.ts:12"]);
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      expect(code).toBe(0);
      expect(readFileSync(join(dir, "out.txt"), "utf8").trim()).toBe('"hello world" "C:\\x\\y.ts:12"');
    } finally {
      process.env.PATH = saved;
    }
  });
});

// --- the deny-list fence (2026-09-10) -------------------------------------------
// `attrs.absRoot` comes from the graph, so the fence must stop a crafted one from
// pointing at the system while still allowing any real project directory.

describe("system-path fence", () => {
  it("names the right prefixes per platform", () => {
    expect(systemPrefixes("darwin", "/Users/x")).toContain("/System");
    expect(systemPrefixes("darwin", "/Users/x")).toContain("/Users/x/Library");
    expect(systemPrefixes("linux", "/home/x")).toContain("/etc");
    expect(systemPrefixes("linux", "/home/x")).not.toContain("/System");
    const win = systemPrefixes("win32", "C:\\Users\\x");
    expect(win.some((p) => /Windows$/.test(p))).toBe(true);
    expect(win.some((p) => /Program Files$/.test(p))).toBe(true);
    expect(win).toContain(join("C:\\Users\\x", "AppData"));
  });

  it("refuses system locations and their contents", () => {
    for (const p of ["/etc", "/etc/passwd", "/usr/bin/env", "/System/Library/x", "/Users/x/Library/Keychains/k"])
      expect(isSystemPath(p, "darwin", "/Users/x"), p).toBe(true);
    for (const p of ["/Users/x/dev/app/src/a.ts", "/opt/src/app.ts", "/Volumes/Work/p/a.ts", "/etcetera/a.ts", "/private/var/folders/xy/T/scratch/a.ts"])
      expect(isSystemPath(p, "darwin", "/Users/x"), p).toBe(false);
  });

  it("refuses a root= that is a system directory, on both flavours", () => {
    expect(allowedRoots("/etc", [repo], home, "darwin")).toEqual([repo]);
    expect(allowedRoots("/System", [repo], home, "darwin")).toEqual([repo]);
  });

  it("refuses a system file even when it sits inside an allowed root", () => {
    // realpath first, then the deny-list: a symlink in the project pointing at
    // /etc/hosts must not inherit the project's blessing
    expect(resolveLocFile("Sources/etc-link.txt", null, [repo], home)).toBeNull();
  });
});
