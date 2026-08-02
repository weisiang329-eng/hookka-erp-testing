// ---------------------------------------------------------------------------
// rack-qr-per-piece.test.mjs — structural pins for the PER-PIECE fix on the /r/
// "scan items into rack" stock-in flow (routes/public-rack-qr.ts).
//
// Owner bug: a DIVAN with 2 pieces had 2 stickers but ONE warehouse identity, so
// scanning the 2nd piece into a rack said "already in this rack" and it could not
// sit on its own rack. The fix threads the scanned piece's pieceNo (+ totalPieces)
// through pieceNotes / currentRackOfPiece / the stock-in identity so each physical
// piece is a DISTINCT rack_items row. These assertions lock that wiring so it can
// not silently regress; loosening any trips CI. Same source-text style as
// sticker-rack-public.test.mjs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), "utf8");

const rackQr = read("src/api/routes/public-rack-qr.ts");
const rackScan = read("src/pages/rack-scan.tsx");
const writeHelper = read("src/api/lib/packing-rack-write.ts");

// ---------------------------------------------------------------------------
// (a) The identity is computed via the SHARED packingPieceIdentity helper, NOT a
//     re-inlined "SO <no>" formula — so the per-piece suffix can never drift.
// ---------------------------------------------------------------------------

test("pieceNotes delegates to packingPieceIdentity with pieceNo + totalPieces", () => {
  assert.match(
    rackQr,
    /function pieceNotes\(\s*soNo: string \| null,\s*pieceNo\?: number \| null,\s*totalPieces\?: number \| null,?\s*\)/,
    "pieceNotes must accept the per-piece markers",
  );
  assert.match(
    rackQr,
    /packingPieceIdentity\(\{\s*salesOrderNo: soNo,\s*pieceNo,\s*totalPieces\s*\}\)\.notes/,
    "pieceNotes must thread the markers into the shared identity helper",
  );
});

test("buildRackStockInStatements builds notes via packingPieceIdentity (per-piece)", () => {
  assert.match(
    rackQr,
    /packingPieceIdentity\(\{\s*salesOrderNo: soNo,\s*pieceNo: item\.pieceNo \?\? null,\s*totalPieces: item\.totalPieces \?\? null,\s*\}\)\.notes/,
    "the stock-in write must derive notes (incl. the pc suffix) from the shared helper",
  );
});

// ---------------------------------------------------------------------------
// (b) currentRackOfPiece (the move / "already here" check) keys on the per-piece
//     notes so the 2nd DIVAN piece is found independently of the 1st.
// ---------------------------------------------------------------------------

test("currentRackOfPiece accepts + uses pieceNo/totalPieces in its match key", () => {
  assert.match(
    rackQr,
    /async function currentRackOfPiece\([\s\S]*?pieceNo\?: number \| null,\s*totalPieces\?: number \| null,?\s*\): Promise<CurrentRack>/,
    "currentRackOfPiece must take the per-piece markers",
  );
  assert.match(
    rackQr,
    /\.bind\(name, pieceNotes\(soNo, pieceNo, totalPieces\)\)/,
    "the lookup must bind the piece-distinct notes",
  );
});

// ---------------------------------------------------------------------------
// (c) Both /item resolve paths derive the markers + thread them through.
// ---------------------------------------------------------------------------

test("/p/<token> path reads ?p= and derives totalPieces from the piece_pics count", () => {
  assert.match(
    rackQr,
    /const scanPieceNo = parsePieceNoFromUrl\(code\);/,
    "the /p/ path must parse the ?p= piece number off the scanned URL",
  );
  assert.match(
    rackQr,
    /scanPieceNo != null \? await pieceCountOf\(c\.var\.DB, card\.id\) : null/,
    "totalPieces must come from the card's piece_pics count (mirror applyPackingRack)",
  );
});

test("FG-PACKING sticker path uses parseStickerData's pieceNo + the piece_pics count", () => {
  assert.match(
    rackQr,
    /const scanPieceNo = sticker\?\.pieceNo \?\? null;/,
    "the FG sticker path must read the parsed piece number",
  );
  assert.match(
    rackQr,
    /pieceCountOf\(c\.var\.DB, po\.jobCardId\)/,
    "totalPieces must prefer the resolved card's piece_pics count",
  );
});

test("both /item paths return pieceNo + totalPieces to the client", () => {
  const count = (rackQr.match(/totalPieces: totalPieces && totalPieces > 1 \? totalPieces : null,/g) || []).length;
  assert.ok(count >= 2, "both resolve branches must echo the per-piece markers back");
});

// ---------------------------------------------------------------------------
// (d) The stock-in POST accepts + sanitises the markers and threads them into the
//     move-detect signature AND the write.
// ---------------------------------------------------------------------------

test("stock-in POST sanitises pieceNo/totalPieces and diverges only when total>1", () => {
  assert.match(
    rackQr,
    /it\.totalPieces > 1\s*\?\s*Math\.floor\(it\.totalPieces\)\s*:\s*null/,
    "totalPieces must only be honoured when genuinely multi-piece (>1)",
  );
  assert.match(
    rackQr,
    /const notes = pieceNotes\(\s*it\.salesOrderNo \?\? null,\s*it\.pieceNo \?\? null,\s*it\.totalPieces \?\? null,?\s*\);/,
    "the move-detect signature must use the per-piece notes",
  );
});

// ---------------------------------------------------------------------------
// (e) A multi-piece scan stamps the PER-PIECE rack column, NOT the card-level
//     job_cards.rackingNumber (which one column can't hold two racks).
// ---------------------------------------------------------------------------

test("multi-piece stock-in writes piece_pics.racking_number, not card-level", () => {
  assert.match(
    rackQr,
    /UPDATE piece_pics SET racking_number = \?\s*\n?\s*WHERE jobCardId = \? AND pieceNo = \?/,
    "a per-piece stock-in must stamp the piece row",
  );
  assert.match(
    rackQr,
    /ensurePiecePicsRackingColumn/,
    "the route must self-apply the per-piece rack column (mig 0192)",
  );
});

test("the per-piece rack column DDL is the ONE shared (exported) helper — no drift", () => {
  assert.match(
    writeHelper,
    /export (?:async )?function ensurePiecePicsRackingColumn\(/,
    "packing-rack-write.ts must export the memoised DDL so /r/ reuses it",
  );
  assert.match(
    rackQr,
    /import \{ ensurePiecePicsRackingColumn \} from "\.\.\/lib\/packing-rack-write"/,
    "public-rack-qr.ts must import the shared DDL, not re-declare it",
  );
});

// ---------------------------------------------------------------------------
// (f) The frontend carries the markers from /item through to the stock-in POST.
// ---------------------------------------------------------------------------

test("rack-scan page carries pieceNo/totalPieces on the line and posts them", () => {
  assert.match(rackScan, /pieceNo: number \| null;/, "Line must carry pieceNo");
  assert.match(rackScan, /totalPieces: number \| null;/, "Line must carry totalPieces");
  assert.match(
    rackScan,
    /pieceNo: j\.pieceNo \?\? null,/,
    "the scanned line must capture the resolved pieceNo",
  );
  assert.match(
    rackScan,
    /pieceNo: x\.pieceNo,\s*\n\s*totalPieces: x\.totalPieces,/,
    "the stock-in POST body must include the per-piece markers",
  );
});
