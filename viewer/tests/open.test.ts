// /open endpoint resolution + request gate, and the dev server's loopback bind
// (viewer/vite.config.ts).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { platform, tmpdir, networkInterfaces } from "node:os";
import { join, resolve, posix, win32 } from "node:path";
import { realpathSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { resolveLocFile, allowedRoots, tooBroadRoot, foldCase, deniedExceptions, isSystemPath, systemPrefixes, sameOrigin, hostAllowed, localRequest, editorCommands, liveFilePath, safeForGenericOpen, substituteToken, loopbackPeer, liveEtag, notModified, cmdEscapeArg, cmdEscapeCommand, resolveOnPath, spawnDetached } from "../vite.config";

// a fake $HOME with a repo inside it and a file outside it
const home = realpathSync(mkdtempSync(join(tmpdir(), "codeatlas-home-")));
const repo = join(home, "repo");
mkdirSync(join(repo, "Sources"), { recursive: true });
writeFileSync(join(repo, "Sources", "A.swift"), "struct A {}\n");
const other = join(home, "other");
mkdirSync(other, { recursive: true });
writeFileSync(join(other, "note.md"), "# hi\n");
const outside = realpathSync(mkdtempSync(join(tmpdir(), "codeatlas-outside-")));
// a scratch base for the symlinked-$HOME test (its home must NOT be pre-resolved)
const symBase = realpathSync(mkdtempSync(join(tmpdir(), "codeatlas-symhome-")));
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

const FAKE_HOME = "/fake-home/dev-user";      // not a real path: the fence takes `home` as a parameter
const FAKE_WIN_HOME = "D:\\fake-home\\dev-user";

describe("system-path fence", () => {
  it("names the right prefixes per platform", () => {
    expect(systemPrefixes("darwin", FAKE_HOME)).toContain("/System");
    expect(systemPrefixes("darwin", FAKE_HOME)).toContain(`${FAKE_HOME}/Library`);
    expect(systemPrefixes("linux", "/home/x")).toContain("/etc");
    expect(systemPrefixes("linux", "/home/x")).not.toContain("/System");
    const win = systemPrefixes("win32", FAKE_WIN_HOME);
    expect(win.some((p) => /Windows$/.test(p))).toBe(true);
    expect(win.some((p) => /Program Files$/.test(p))).toBe(true);
    // composed with win32 separators whatever the host: the list describes Windows
    expect(win).toContain(win32.join(FAKE_WIN_HOME, "AppData"));
  });

  it("refuses system locations and their contents", () => {
    for (const p of ["/etc", "/etc/passwd", "/usr/bin/env", "/System/Library/x", `${FAKE_HOME}/Library/Keychains/k`])
      expect(isSystemPath(p, "darwin", FAKE_HOME), p).toBe(true);
    for (const p of [`${FAKE_HOME}/dev/app/src/a.ts`, "/opt/src/app.ts", "/Volumes/Work/p/a.ts", "/etcetera/a.ts", "/private/var/folders/xy/T/scratch/a.ts"])
      expect(isSystemPath(p, "darwin", FAKE_HOME), p).toBe(false);
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

  // The deny-list says where a root may not POINT; this says how specific it has to be.
  // Found 2026-09-10: `root=/` passed every check (it is a real directory and matches no
  // system prefix), so a crafted graph could resolve anything outside the deny-list —
  // `/open?file=$HOME/.zshrc&root=/` answered "resolvable". The fence is "inside the root
  // the graph names", and "/" (or $HOME, or any ancestor of it) names everything.
  // macOS and Windows are case-INsensitive and `realpathSync` does not canonicalise case,
  // so every fence here was one keystroke from being bypassed (found 2026-09-10):
  // `root=/users` reached all of $HOME and `/PRIVATE/etc/passwd` walked through the
  // deny-list. These assertions run under the platform's own rules via the `os` argument.
  it("folds case where the filesystem does, so a re-cased path is the same path", () => {
    expect(foldCase("/Users/A", "darwin")).toBe("/users/a");
    expect(foldCase("C:\\Users", "win32")).toBe("c:\\users");
    expect(foldCase("/Users/A", "linux")).toBe("/Users/A"); // case-sensitive: unchanged
    // deny-list
    expect(isSystemPath("/PRIVATE/etc/passwd", "darwin", FAKE_HOME)).toBe(true);
    expect(isSystemPath("/private/ETC/passwd", "darwin", FAKE_HOME)).toBe(true);
    expect(isSystemPath("/ETC", "darwin", FAKE_HOME)).toBe(true);
    expect(isSystemPath(`${FAKE_HOME.toUpperCase()}/Library/Keychains/k`, "darwin", FAKE_HOME)).toBe(true);
    // …but Linux really is case-sensitive: /ETC is a different directory there. The `os`
    // argument only chooses the folding and the prefix list; path arithmetic stays with
    // the host's `node:path`, and win32 `relative()` folds case on its own — so the
    // case-SENSITIVE assertions only mean something off Windows (the mirror image of the
    // win32 guard below; both halves run on CI's ubuntu+windows matrix).
    if (platform() !== "win32") expect(isSystemPath("/ETC/passwd", "linux", "/home/x")).toBe(false);
    // root fence: /fake-home is the ancestor of /fake-home/dev-user, in any casing
    const HOME_UP = FAKE_HOME.toUpperCase(); // "/FAKE-HOME/DEV-USER"
    expect(tooBroadRoot("/FAKE-HOME", FAKE_HOME, "darwin")).toBe(true); // ancestor, re-cased
    expect(tooBroadRoot(HOME_UP, FAKE_HOME, "darwin")).toBe(true); // $HOME itself, re-cased
    expect(tooBroadRoot(`${HOME_UP}/dev/app`, FAKE_HOME, "darwin")).toBe(false); // a real project
    if (platform() !== "win32") expect(tooBroadRoot("/FAKE-HOME", FAKE_HOME, "linux")).toBe(false); // case-sensitive: a different dir
    // Windows needs win32 `path` semantics, which node only gives us when it IS Windows —
    // and there `relative()` already folds case for us. CI runs this suite on
    // windows-latest, which is where the assertion below has meaning.
    if (platform() === "win32") {
      expect(tooBroadRoot("C:\\USERS", "C:\\Users\\u", "win32")).toBe(true);
      expect(isSystemPath("C:\\WINDOWS\\win.ini", "win32", "C:\\Users\\u")).toBe(true);
    }
  });

  it("folds unicode normalisation too, not just case", () => {
    // macOS stores names decomposed (NFD) and accepts the composed spelling (NFC) for the
    // same directory; `realpathSync` normalises neither. So once case was fixed, an
    // `attrs.absRoot` in the other normalisation bypassed BOTH fences again on any machine
    // whose home directory has a non-ASCII name.
    const nfd = "/vol/Jose\u0301/proj"; // e + combining acute — what APFS stores
    const nfc = "/vol/Jos\u00e9/proj"; // é — what a graph is likely to carry
    expect(nfd).not.toBe(nfc); // genuinely different strings…
    expect(foldCase(nfd, "darwin")).toBe(foldCase(nfc, "darwin")); // …one directory
    expect(foldCase(nfd, "linux")).not.toBe(foldCase(nfc, "linux")); // untouched off darwin/win32
    const homeNfd = "/vol/Jose\u0301";
    const homeNfc = "/vol/Jos\u00e9";
    expect(tooBroadRoot(homeNfc, homeNfd, "darwin")).toBe(true); // $HOME under its other spelling
    expect(isSystemPath(`${homeNfc}/.ssh/id_rsa`, "darwin", homeNfd)).toBe(true);
  });

  it("refuses a directory that HOLDS projects rather than being one", () => {
    // "/Volumes" is one level below "/", so "at least one directory down" let it through —
    // and it contains every mounted disk, share and DMG on the machine.
    for (const p of ["/Volumes", "/mnt", "/media", "/private", "/VOLUMES"])
      expect(tooBroadRoot(p, FAKE_HOME, "darwin"), p).toBe(true);
    expect(tooBroadRoot("/Volumes/Work/app", FAKE_HOME, "darwin")).toBe(false); // a project ON one is fine
    expect(tooBroadRoot("/private/tmp/scratch/app", FAKE_HOME, "darwin")).toBe(false);
  });

  it.skipIf(!canSymlink)("builds its $HOME-relative prefixes from the REALPATH of home", () => {
    // Candidates are realpath'd before this list is consulted, so a $HOME that is itself a
    // symlink made every home-relative entry unmatchable — the credential dirs and, on
    // macOS, ~/Library. `tooBroadRoot` realpathed home; `systemPrefixes` did not.
    //
    // This needs a genuinely SYMLINKED home. The first version of it passed `realpathSync(home)`
    // — and the fixture home is already realpath'd, so every assertion held whether or not
    // the code called `real()`: deleting the fix left the whole suite green. A test for a
    // credential fence that cannot fail is worse than no test, because it reads as cover.
    const realHome = join(symBase, "real-home");
    mkdirSync(join(realHome, ".ssh"), { recursive: true });
    writeFileSync(join(realHome, ".ssh", "id_rsa"), "KEY\n");
    const linkHome = join(symBase, "home-link");
    symlinkSync(realHome, linkHome);

    // the prefixes must name the RESOLVED directory, because that is what a candidate
    // realpaths to
    expect(systemPrefixes("darwin", linkHome)).toContain(join(realHome, ".ssh"));
    expect(systemPrefixes("darwin", linkHome)).toContain(join(realHome, "Library"));
    expect(isSystemPath(join(realHome, ".ssh", "id_rsa"), "darwin", linkHome)).toBe(true);
    // …end to end: the key is unreachable through the symlinked spelling too
    expect(resolveLocFile("id_rsa", join(linkHome, ".ssh"), [], linkHome, false, "darwin")).toBeNull();
    expect(resolveLocFile(join(linkHome, ".ssh", "id_rsa"), null, [], linkHome, true, "darwin")).toBeNull();
    // …and the TWIN: `deniedExceptions` got the same `real(home)` fix and no assertion, so
    // mutating it back left the suite green. Its failure is the other direction — the four
    // code subtrees stop being reachable, which silently turns "Open in editor" off for the
    // plugin's own source and the user's skills and agents when $HOME is a symlink.
    mkdirSync(join(realHome, ".claude", "plugins"), { recursive: true });
    expect(deniedExceptions(linkHome)).toContain(join(realHome, ".claude", "plugins"));
    expect(isSystemPath(join(realHome, ".claude", "plugins", "codeatlas", "x.ts"), "darwin", linkHome)).toBe(false);
    expect(isSystemPath(join(realHome, ".claude", "history.jsonl"), "darwin", linkHome)).toBe(true);
  });

  it("folds case at the ALLOW fence too — the one place folding is the PERMISSIVE direction", () => {
    // Every other folding site is a deny-list, where being case-sensitive would be a
    // BYPASS. This one decides "the file is inside a root", where folding is what lets a
    // differently-cased spelling through — and it had no test at all: forcing it to "linux"
    // left the whole suite green. It has to fold, because on macOS and Windows a mis-cased
    // root really is the same directory and `realpathSync` canonicalises neither; the file
    // itself is still realpath'd and still deny-listed first, and the root is supplied by
    // whoever runs the viewer, not by the graph.
    const projRoot = join(outside, "Proj");
    mkdirSync(projRoot, { recursive: true });
    writeFileSync(join(projRoot, "App.tsx"), "x\n");
    const shouted = join(outside, "PROJ"); // the same directory on macOS/Windows, other spelling
    const target = realpathSync(join(projRoot, "App.tsx"));
    expect(resolveLocFile(target, null, [shouted], FAKE_HOME, false, "darwin")).toBe(target);
    expect(resolveLocFile(target, null, [shouted], FAKE_HOME, false, "win32")).toBe(target);
    // …and on a case-SENSITIVE platform the two are genuinely different directories.
    // Host-bound `relative()` folds case on Windows whatever `os` says (see the fold-case
    // test above), so this half only has meaning off Windows.
    if (platform() !== "win32") expect(resolveLocFile(target, null, [shouted], FAKE_HOME, false, "linux")).toBeNull();
    expect(resolveLocFile(target, null, [projRoot], FAKE_HOME, false, "linux")).toBe(target);
  });

  it("keeps credential directories out, whatever root a graph claims", () => {
    // `tooBroadRoot` stops a graph claiming all of $HOME; this stops one claiming ~/.ssh
    // and pointing at id_rsa. Not exhaustive by design — it raises the floor.
    for (const p of [".ssh/id_rsa", ".aws/credentials", ".gnupg/x", ".netrc", ".claude/settings.json"])
      expect(isSystemPath(posix.join(FAKE_HOME, p), "darwin", FAKE_HOME), p).toBe(true);
    expect(isSystemPath(posix.join(FAKE_HOME, "dev/app/.sshconfig"), "darwin", FAKE_HOME)).toBe(false); // not a prefix match
  });

  it("denies ~/.claude as a DIRECTORY, exempting only the code subtrees", () => {
    // The documented install puts this checkout under `~/.claude/plugins/…`, and the
    // launcher starts vite from inside it, so DEFAULT_ROOTS[0] is that directory: denying
    // the whole tree turned "Open in editor" off for the plugin's own source and for the
    // user's skills and agents. Enumerating the SECRETS instead was worse — it left
    // history.jsonl (every prompt typed), settings.local.json and projects/**/*.jsonl
    // reachable, because that list is open-ended. The exemption list is closed.
    for (const p of [
      ".claude/plugins/codeatlas/viewer/src/App.tsx",
      ".claude/skills/mine/SKILL.md",
      ".claude/agents/x.md",
      ".claude/commands/x.md",
    ])
      expect(isSystemPath(posix.join(FAKE_HOME, p), "darwin", FAKE_HOME), p).toBe(false);
    for (const p of [
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/.credentials.json",
      ".claude/history.jsonl",
      ".claude/projects/some-project/abc.jsonl",
      ".claude/todos/x.json",
    ])
      expect(isSystemPath(posix.join(FAKE_HOME, p), "darwin", FAKE_HOME), p).toBe(true);
    // the exemption is a path prefix, not a name match
    expect(isSystemPath(posix.join(FAKE_HOME, ".claude", "plugins-backup", "x"), "darwin", FAKE_HOME)).toBe(true);
    expect(deniedExceptions(FAKE_HOME, "darwin")).toContain(posix.join(FAKE_HOME, ".claude", "plugins"));
  });

  it("refuses a root= too broad to bound anything", () => {
    for (const broad of ["/", home, join(home, ".."), resolve("/")])
      expect(tooBroadRoot(realpathSync(broad), home), broad).toBe(true);
    for (const ok of [repo, other, outside]) expect(tooBroadRoot(ok, home), ok).toBe(false);
    // A bare drive root is the same `abs === dirname(abs)` identity, but only under
    // win32 path semantics — node's `dirname("C:\\")` is "." on POSIX. CI runs this
    // suite on windows-latest, which is where the assertion has meaning.
    if (platform() === "win32") {
      expect(tooBroadRoot("C:\\", "D:\\fake-home\\u")).toBe(true);
      expect(tooBroadRoot("C:\\Users", "C:\\Users\\u")).toBe(true);
      expect(tooBroadRoot("C:\\dev\\app", "C:\\Users\\u")).toBe(false);
    }
  });

  it("drops such a root instead of resolving against it", () => {
    expect(allowedRoots("/", [repo], home)).toEqual([repo]);
    expect(allowedRoots(home, [repo], home)).toEqual([repo]);
    // …and the file it was reaching for stays unreachable
    expect(resolveLocFile(join(other, "note.md"), "/", [repo], home)).toBeNull();
    expect(resolveLocFile(join(other, "note.md"), home, [repo], home)).toBeNull();
    // a real project directory is unaffected — that is the whole point of the deny-list
    expect(resolveLocFile(join(other, "note.md"), other, [repo], home)).toBe(join(other, "note.md"));
  });

  it("still lets an OPERATOR widen the fence — CODEATLAS_ROOTS and CODEATLAS_OPEN_HOME", () => {
    // configured by whoever runs the viewer, not asserted by the graph on screen
    expect(resolveLocFile("note.md", null, [repo, other], home)).toBe(join(other, "note.md"));
    expect(resolveLocFile(join(other, "note.md"), "/", [repo], home, true)).toBe(join(other, "note.md"));
  });
});

/**
 * Both loopback families answer.
 *
 * Vite's default host (`localhost`) resolves to ONE address — `::1` on macOS — so
 * `http://127.0.0.1:5173` was refused while `http://localhost:5173` worked: browsers
 * retry the other family, the launcher's port probe and hand-written curl do not.
 * Boots the real config, so it covers both the `server.host` bind and the twin listener.
 */
describe("dev server binding", () => {
  /** Some CI containers have no IPv6 at all; the twin listener is best-effort there. */
  const canBindIPv6 = () =>
    new Promise<boolean>((done) => {
      const s = createNetServer();
      s.once("error", () => done(false));
      s.listen(0, "::1", () => s.close(() => done(true)));
    });

  /** An OS-chosen free port: vite's default 5173 is very likely to be a live viewer. */
  const freePort = () =>
    new Promise<number>((done) => {
      const s = createNetServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => done(port));
      });
    });

  /** The twin binds a tick after the primary is listening, so give it a few retries. */
  async function status(url: string, tries = 40): Promise<number> {
    for (let i = 0; ; i++) {
      try {
        return (await fetch(url)).status;
      } catch (e) {
        // "fetch failed" alone would not say WHICH family never came up
        if (i >= tries) throw new Error(`nothing listening on ${url}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /** This machine's non-loopback IPv4 addresses — what "wider" would actually mean. */
  const lanAddresses = () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);

  it("serves 127.0.0.1 and [::1], and binds nothing wider", async () => {
    const { createServer } = await import("vite");
    // The daemon-only plugins key off these, and this test boots the REAL config: with a
    // CODEATLAS_LIVE_DIR in the ambient shell (which this project's own developer has),
    // the uninstall watchdog would attach a timer to a server the test then closes.
    const saved = { live: process.env.CODEATLAS_LIVE_DIR, log: process.env.CODEATLAS_LOG };
    delete process.env.CODEATLAS_LIVE_DIR;
    delete process.env.CODEATLAS_LOG;
    const server = await createServer({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      server: { port: await freePort() }, // host comes from the config file — that is what is under test
      optimizeDeps: { noDiscovery: true },
    });
    await server.listen();
    try {
      const { address, port } = server.httpServer!.address() as AddressInfo;
      expect(address).toBe("127.0.0.1"); // never 0.0.0.0 / :: — /open shells out
      expect(await status(`http://127.0.0.1:${port}/`)).toBe(200);
      if (await canBindIPv6()) expect(await status(`http://[::1]:${port}/`)).toBe(200);
      // "binds nothing wider" was in the name but never checked: a 0.0.0.0 bind answers
      // on every interface, and `address` alone would not have caught a second listener.
      for (const lan of lanAddresses()) {
        await expect(fetch(`http://${lan}:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      }
      // `/theme.css` with no theme file installed is the NORMAL case and must be an empty
      // 200 stylesheet, not a 404: index.html links it unconditionally, so a 404 is a red
      // console error on every page load. Nothing pinned that — reverting it left the suite
      // green — and this test already has the real server booted.
      const theme = await fetch(`http://127.0.0.1:${port}/theme.css`);
      expect(theme.status).toBe(200);
      expect(theme.headers.get("content-type")).toMatch(/text\/css/);
      expect(await theme.text()).toMatch(/no user theme installed/);
    } finally {
      await server.close();
      if (saved.live !== undefined) process.env.CODEATLAS_LIVE_DIR = saved.live;
      if (saved.log !== undefined) process.env.CODEATLAS_LOG = saved.log;
    }
  }, 30_000);
});
