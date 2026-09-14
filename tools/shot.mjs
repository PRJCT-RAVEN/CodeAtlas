#!/usr/bin/env node
// shot.mjs — headless screenshot of the CodeAtlas viewer (Claude's eyes).
//
// Usage:
//   node tools/shot.mjs <out.png> [url] [--collapsed <node-id> ...]
//     url        default http://localhost:5173/
//     --collapsed  container ids to click (collapse) before shooting; each click
//                  triggers an async ELK re-layout, so we settle after every one.
//
// Waits for `.react-flow__node` (nodes appear only after the live/graph.json poll
// + ELK layout resolve), then ~2.5 s for fitView + edge-label settle. Viewport
// 1600×1000 at 2× device scale, full page. Deps: `cd tools && npm install`
// (Playwright pinned to the Chromium build cached in ~/Library/Caches/ms-playwright).

import { chromium } from "playwright";

const args = process.argv.slice(2);
const positional = [];
const collapsed = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--collapsed") {
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) collapsed.push(args[++i]);
  } else if (a.startsWith("--")) {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  } else {
    positional.push(a);
  }
}
const out = positional[0] ?? "shot.png";
const url = positional[1] ?? "http://localhost:5173/";

/** Wait for "laying out…" to clear — the viewer's own signal that ELK has finished. */
const busy = (page) =>
  page
    .waitForFunction(() => !document.querySelector(".busy"), null, { timeout: 120000 })
    .catch(() => {}); // a hung layout should still produce a screenshot to look at

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  // NOT `networkidle`: the viewer polls live/graph.json once a second forever, so idle is
  // only ever reached in the gap between two polls — it happened to work here and is a
  // timeout waiting to happen on a slow load. The waits below are the real signal.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // The FIRST layout needs a long selector timeout, not a busy-wait: nodes and the
  // cleared "laying out…" land in the same React commit, so by the time this resolves
  // `.busy` is already gone (measured: 2 ms). A 100k-node graph can take a while to get
  // here, which is what the generous timeout is for.
  //
  // …but the long timeout must not be what a TYPO costs. `?graph=<name>` drafts are the
  // review workflow CLAUDE.md prescribes and a mistyped name is the likely failure; the
  // viewer says so in its status bar within a second ("waiting for live/x.json…"), while
  // this selector cannot tell "not laid out yet" from "there is no such file" and spent the
  // full two minutes before dying on a stack trace with no png. Race the two: whichever
  // answers first wins.
  // Wait for the viewer to SETTLE, and then ask what it settled on — rather than matching
  // status-bar phrases, which was the first attempt and got both halves wrong. It missed
  // the cases where no node will ever appear and nothing is wrong (a root-only graph — what
  // `fs2ir` emits for an empty directory — renders zero nodes, because the root IS the
  // canvas) and the case where something is wrong but says so differently (an ELK timeout
  // sets `layoutError`). And it matched HEALTHY views whose draft name happened to contain a
  // keyword: `?graph=missing-deps` put "live/missing-deps.json" in the very first field.
  //
  // `.status.error` is the class the viewer already sets for exactly this question, and a
  // graph is on screen only once the poller names its source. The grace period is for the
  // transient "waiting for …" a healthy load shows first: measured with a cold browser, the
  // largest graph to hand (34 MB, 8,000 tables) had its first node up in 1,368 ms.
  const GRACE_MS = 8000;
  const verdict = await page
    .waitForFunction(
      (grace) => {
        if (document.querySelector(".react-flow__node")) return { kind: "nodes" };
        if (performance.now() < grace) return false; // too early to conclude anything
        if (document.querySelector(".busy")) return false; // ELK is still working
        const status = document.querySelector(".status");
        if (!status) return false;
        const text = (status.textContent ?? "").trim();
        if (status.classList.contains("error")) {
          const warn = [...status.querySelectorAll("span")].map((n) => n.textContent.trim()).filter((t) => t.startsWith("\u26a0"));
          return { kind: "error", text: warn.join(" ") || text };
        }
        if (/^waiting for /.test(text)) return { kind: "absent", text };
        return { kind: "empty" }; // settled, no error, a graph named: it really has no display nodes
      },
      GRACE_MS,
      { timeout: 120000 }
    )
    .then((h) => h.jsonValue());
  if (verdict.kind === "error" || verdict.kind === "absent") {
    console.error(`${url}: ${verdict.text}`);
    await browser.close();
    process.exit(1);
  }
  if (verdict.kind === "empty") console.error(`${url}: no display nodes (the root is the canvas) — shooting the empty view`);
  await page.waitForTimeout(2500); // fitView animation + edge label settle

  for (const id of collapsed) {
    const sel = `.react-flow__node[data-id="${id.replace(/"/g, '\\"')}"]`;
    const node = page.locator(sel).first();
    await node.waitFor({ timeout: 10000 });
    // Click the container's own title CHIP, by element — not a fixed 10 px inset from the
    // node's corner. The inset assumed the chip is always ~10 px in, which is true at
    // zoom 1 and false as soon as the view is zoomed out: at zoom 0.17 (300 containers,
    // a 78x34 px box) the point lands on a child node instead, Playwright waits for it to
    // stop intercepting the pointer, and the whole run dies on a click timeout. The chip
    // scales with the view and floats above the border, so it is hittable at any zoom.
    const chip = page.locator(`${sel} .atlas-node > .chip`).first();
    if ((await chip.count()) === 0) {
      console.error(`--collapsed ${id}: not a container (no title chip) — nothing to collapse`);
      process.exit(2);
    }
    // The click is a TOGGLE, and a collapsed container has a chip too (it renders as one),
    // so on anything already collapsed — by `collapsedByDefault` or by the visibility budget,
    // which is the usual case on a big graph — this used to EXPAND it and still report
    // "(collapsed: …)". `aria-expanded` is the state the viewer already publishes for exactly
    // the nodes that toggle, so ask before clicking.
    if ((await node.getAttribute("aria-expanded")) === "false") {
      console.error(`--collapsed ${id}: already collapsed`);
      continue;
    }
    // `dispatchEvent`, not `click()`: the app's own chrome floats over the canvas — the
    // details panel (which a previous iteration's click OPENED), the Key top-left, the
    // MiniMap bottom-right — and a real click on a chip underneath any of them is refused
    // until it times out, killing the run with no png. Measured under a covering overlay:
    // `click({force: true})` still lands on the overlay and does nothing; `dispatchEvent`
    // reaches the element and React's delegated handler fires.
    await chip.dispatchEvent("click");
    // HERE is where the busy-wait belongs: this re-layout really is asynchronous, and a
    // fixed 1.5 s was a guess that a big collapse outruns.
    await busy(page);
    await page.waitForTimeout(400); // label pass + repaint
    // …and CHECK. A tool that reports "(collapsed: …)" without having collapsed anything is
    // the exact defect this block has now had twice (a toggle that expanded, then a click
    // that never landed), so the state is verified rather than assumed.
    if ((await node.getAttribute("aria-expanded")) !== "false") {
      console.error(`--collapsed ${id}: the click did not collapse it`);
      await browser.close();
      process.exit(1);
    }
    // The click also SELECTED it: close the panel before the next target, or it covers them.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
  }

  await page.screenshot({ path: out, fullPage: true });
  console.log("wrote", out, collapsed.length ? `(collapsed: ${collapsed.join(", ")})` : "");
} finally {
  await browser.close();
}
