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

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  await page.waitForTimeout(2500); // fitView animation + edge label settle

  for (const id of collapsed) {
    const sel = `.react-flow__node[data-id="${id.replace(/"/g, '\\"')}"]`;
    const node = page.locator(sel).first();
    await node.waitFor({ timeout: 10000 });
    // Click the container's top-left corner (its title chip), not its centre —
    // the centre is usually covered by a child node.
    await node.click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(1500); // re-layout
  }

  await page.screenshot({ path: out, fullPage: true });
  console.log("wrote", out, collapsed.length ? `(collapsed: ${collapsed.join(", ")})` : "");
} finally {
  await browser.close();
}
