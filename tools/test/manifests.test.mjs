// The two plugin manifests both carry the version, and nothing in the code keeps them
// equal: marketplace.json duplicates what plugin.json says, and `claude plugin validate`
// only checks the marketplace SHAPE. A skew ships silently and every bug report then names
// the wrong build. CI gates this too, but a gate that only exists in the workflow is one a
// local `npm test` cannot catch before the push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => JSON.parse(readFileSync(join(REPO, ...p), "utf8"));

test("plugin.json and marketplace.json agree on the version", () => {
  const plugin = read(".claude-plugin", "plugin.json");
  const market = read(".claude-plugin", "marketplace.json");
  const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json lists no plugin named ${plugin.name}`);
  assert.equal(entry.version, plugin.version, "the two manifests must carry the same version");
});

test("the plugin version is semver, anchored at both ends", () => {
  const { version } = read(".claude-plugin", "plugin.json");
  // anchored: the unanchored form CI used to apply accepted "0.3.0.1" and "0.3.0-oops-typo"
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/, `not a semver version: ${version}`);
});

test("every component the manifest names is actually in the checkout", () => {
  const plugin = read(".claude-plugin", "plugin.json");
  // whatever shape the manifest uses, any string that looks like a repo path must resolve
  const paths = JSON.stringify(plugin).match(/"\.\/[^"]+"/g) ?? [];
  for (const raw of paths) {
    const rel = JSON.parse(raw);
    if (rel === "./") continue;
    assert.ok(existsSync(join(REPO, rel)), `plugin.json points at a missing path: ${rel}`);
  }
});
