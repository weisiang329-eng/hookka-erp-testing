// ---------------------------------------------------------------------------
// workspace-tabs.test.mjs — pins the in-app browser-style tab strip (owner
// 2026-07-28: "开着 SO 的时候我去别的 module 回来不会跳不见"). Ported from the
// Houzs ERP. Structural pins (source assertions) — the browser-tab semantics
// are the whole point and must not silently regress; the live UX is verified by
// the owner on the preview deploy.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = readFileSync(new URL("../src/lib/workspaceTabs.ts", import.meta.url), "utf8");
const ui = readFileSync(
  new URL("../src/components/layout/workspace-tabs.tsx", import.meta.url),
  "utf8",
);
const topbar = readFileSync(
  new URL("../src/components/layout/topbar.tsx", import.meta.url),
  "utf8",
);
const sidebar = readFileSync(
  new URL("../src/components/layout/sidebar.tsx", import.meta.url),
  "utf8",
);

test("store exports the full tab API", () => {
  for (const fn of [
    "recordWorkspaceVisit",
    "activateWorkspaceTab",
    "closeWorkspaceTab",
    "moveWorkspaceTab",
    "markWorkspaceOpenIntent",
    "subscribeWorkspaceTabs",
    "getWorkspaceTabsSnapshot",
  ]) {
    assert.match(store, new RegExp(`export function ${fn}\\b`), `store must export ${fn}`);
  }
});

test("in-content navigation re-points the ACTIVE tab (browser-tab behavior)", () => {
  // The core promise: without an open-intent, a navigation updates the active
  // tab's href rather than spawning a new tab.
  assert.match(
    store,
    /const active = s\.tabs\.find\(\(t\) => t\.id === s\.activeId\)[\s\S]{0,400}?tabs: s\.tabs\.map\(\(t\) => \(t\.id === active\.id \? \{ \.\.\.t, href \} : t\)\)/,
    "the no-intent branch must re-point the active tab's href",
  );
});

test("sidebar click spawns/activates a tab via open-intent + section dedup", () => {
  assert.match(
    store,
    /const intent = consumeOpenIntent\(\)/,
    "recordWorkspaceVisit must consume the open-intent",
  );
  assert.match(
    store,
    /const existing = s\.tabs\.find\(\(t\) => sectionKeyFor\(t\.href\) === section\)/,
    "open-intent must dedup by section (activate an existing tab, not duplicate)",
  );
});

test("persistence is per-window sessionStorage, dropped on identity change", () => {
  assert.match(store, /sessionStorage\.setItem\(WORKSPACE_TABS_KEY/, "must persist to sessionStorage");
  assert.match(
    store,
    /state\.userKey !== userKey\)[\s\S]{0,160}?tabs: \[\], activeId: null/,
    "a different signed-in user must NOT inherit the previous strip",
  );
});

test("UI records every visit + supports close / drag-reorder", () => {
  assert.match(ui, /recordWorkspaceVisit\(location\.pathname, location\.search\)/, "records visits");
  assert.match(ui, /closeWorkspaceTab/, "closes tabs");
  assert.match(ui, /moveWorkspaceTab\(dragged,/, "drag reorders");
  // Below 2 tabs the strip is just a spacer (breadcrumb already names the page).
  assert.match(ui, /tabs\.length <= 1\) return <div className="flex-1" \/>/, "spacer until 2+ tabs");
});

test("topbar mounts the strip in the breadcrumb area", () => {
  assert.match(topbar, /import \{ WorkspaceTabs \}/, "topbar imports WorkspaceTabs");
  assert.match(topbar, /<WorkspaceTabs \/>/, "topbar renders WorkspaceTabs");
});

test("sidebar marks open-intent on a plain left-click (both item + child links)", () => {
  assert.match(sidebar, /import \{ markWorkspaceOpenIntent \}/, "sidebar imports the marker");
  const marks = sidebar.match(/markWorkspaceOpenIntent\(\)/g) ?? [];
  assert.ok(marks.length >= 2, "both the item link and the child link must mark open-intent");
  // Modified clicks (new browser window) must NOT mark.
  assert.match(
    sidebar,
    /!e\.metaKey && !e\.ctrlKey && !e\.shiftKey && !e\.altKey\)\s*\n?\s*markWorkspaceOpenIntent/,
    "only a plain left-click marks; Ctrl/Cmd/Shift/Alt fall through to a new window",
  );
});
