// ---------------------------------------------------------------------------
// bom-editor-reorder.test.mjs — reorder + insert-in-the-middle in the BOM editor.
//
// Owner 2026-07-30: "工序要能插在中间" — the BOM editor only ever APPENDS a new
// process / WIP to the bottom of its list, so to place one between (e.g.)
// Framing and Webbing you have to rebuild the BOM. Two primitives fix this:
//   甲 process reorder — move a process up/down within its WIP node.
//   乙 hierarchy reorder — move a WIP among its siblings + wrap one inside a
//      new parent ("+ Above") so a stage can be inserted mid-hierarchy.
// Add-then-step-up covers "insert in the middle" for both.
//
// The primary editor is EditBOMDialog (edits an existing per-product BOM). The
// shared recursive renderer SubWIPTree already carried WIP move/wrap (optional
// props); this change adds process move to it and WIRES the full set into
// EditBOMDialog (which previously had none), and adds process move to
// MasterTemplatesDialog (which already had WIP move/wrap).
//
// Source-level structural pins (house style — no DOM render, no worker runtime).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BOM = resolve(process.cwd(), "src/pages/bom.tsx");
const src = readFileSync(BOM, "utf8");
const flat = src.replace(/\s+/g, " ");

// Slice a named component body out of the file so a pin can assert it lands in
// the RIGHT dialog (the file has three: CreateBOMDialog, EditBOMDialog,
// MasterTemplatesDialog). Returns the text from `function <name>(` up to the
// next top-level `\nfunction ` — good enough for these grep-style pins.
function componentBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  const after = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

// ===========================================================================
// SubWIPTree — the shared recursive renderer gains process-move support.
// ===========================================================================

test("SubWIPTree accepts onMoveProcessUp/onMoveProcessDown props", () => {
  const body = componentBody("SubWIPTree");
  assert.match(body, /onMoveProcessUp\?: \(path: number\[\], pi: number\) => void;/);
  assert.match(body, /onMoveProcessDown\?: \(path: number\[\], pi: number\) => void;/);
});

test("SubWIPTree renders ↑/↓ on process rows + passes the props down recursively", () => {
  const body = componentBody("SubWIPTree");
  // Guarded render (only when the callback is supplied) on a process row.
  assert.match(body, /onMoveProcessUp && \([\s\S]*?onMoveProcessUp\(childPath, pi\)/);
  assert.match(body, /onMoveProcessDown\(childPath, pi\)/);
  // Disabled at the list boundary (can't move the first up / last down).
  assert.match(body, /disabled=\{pi === 0\}/);
  assert.match(body, /disabled=\{pi === sub\.processes\.length - 1\}/);
  // Threaded into the recursive child so nested levels get it too.
  assert.match(body, /onMoveProcessUp=\{onMoveProcessUp\}/);
  assert.match(body, /onMoveProcessDown=\{onMoveProcessDown\}/);
});

// ===========================================================================
// EditBOMDialog — the owner's editor. Previously had NO reorder at all.
// ===========================================================================

test("EditBOMDialog defines every reorder handler", () => {
  const body = componentBody("EditBOMDialog");
  for (const fn of [
    "moveProcessAtPath", // nested process (甲)
    "moveSubWIPAtPath",  // nested WIP among siblings (乙)
    "wrapSubWIPAtPath",  // insert a parent level above (乙)
    "moveWIP",           // top-level WIP reorder
    "moveWIPProcess",    // top-level process reorder (甲)
  ]) {
    assert.match(body, new RegExp(`function ${fn}\\b`), `${fn} must exist in EditBOMDialog`);
  }
});

// 2026-08-03: EditBOMDialog's WIP tab became a TWO-PANE editor — the tree is
// flattened on the left and ONE node is edited on the right, so it no longer
// renders SubWIPTree at all. The reorder capability is unchanged; it now
// reaches the detail pane through depth-agnostic adapters that dispatch on
// path length. These pins follow the capability, not the old markup.

test("EditBOMDialog routes every reorder through its depth-agnostic adapters", () => {
  const body = componentBody("EditBOMDialog");
  // Each adapter must serve BOTH families — top-level and nested — or one of
  // the two depths silently loses the affordance.
  assert.match(body, /nMoveProcess[\s\S]*?moveWIPProcess\(wi, pi, dir\)[\s\S]*?moveProcessAtPath\(wi, path, pi, dir\)/);
  assert.match(body, /nMove = \(wi: number, path: number\[\], dir: -1 \| 1\)/);
  assert.match(body, /moveWIP\(wi, dir\)/);
  assert.match(body, /moveSubWIPAtPath\(wi, path\.slice\(0, -1\), path\[path\.length - 1\], dir\)/);
  // "+ Above" (insert a parent level) survived the rework.
  assert.match(body, /wrapSubWIPAtPath\(wi, path\.slice\(0, -1\), path\[path\.length - 1\]\)/);
});

test("the detail pane renders ↑/↓ for both processes and the node itself", () => {
  const body = componentBody("WipNodeDetail");
  assert.match(body, /onMoveProcess\(wi, path, pi, -1\)/);
  assert.match(body, /onMoveProcess\(wi, path, pi, 1\)/);
  assert.match(body, /onMove\(wi, path, -1\)/);
  assert.match(body, /onMove\(wi, path, 1\)/);
  // Boundary-guarded, so the first process can't move up nor the last down.
  assert.match(body, /disabled=\{pi === 0\}/);
  assert.match(body, /disabled=\{pi === node\.processes\.length - 1\}/);
  // "+ Above" only offered where a parent can exist.
  assert.match(body, /onWrap && path\.length > 0/);
});

test("reorder swaps are pure element swaps and boundary-guarded", () => {
  const body = componentBody("EditBOMDialog");
  // The move handlers use the classic destructuring swap and bail at the edge.
  assert.match(body, /\[list\[pi\], list\[j\]\] = \[list\[j\], list\[pi\]\]/);
  assert.match(body, /if \(pi < 0 \|\| pi >= list\.length \|\| j < 0 \|\| j >= list\.length\) return/);
});

// ===========================================================================
// MasterTemplatesDialog — already had WIP move/wrap; gains process move.
// ===========================================================================

test("MasterTemplatesDialog gains process reorder (nested + L1)", () => {
  const body = componentBody("MasterTemplatesDialog");
  assert.match(body, /function moveProcessAtPath\b/);
  assert.match(body, /function moveL1Process\b/);
  assert.match(body, /onMoveProcessUp=\{\(path, pi\) => moveProcessAtPath\(wi, path, pi, -1\)\}/);
  assert.match(body, /moveL1Process\(i, -1\)/);
});
