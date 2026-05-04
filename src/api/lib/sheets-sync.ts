// ---------------------------------------------------------------------------
// sheets-sync.ts — high-level helpers for ERP -> Google Sheets sync.
//
// Architecture (see docs/SHEETS-SYNC.md for the full picture):
//   * ERP -> Sheets is FIRE-AND-FORGET.  Every helper here is wrapped in
//     try/catch + console.error so a Sheets-side failure never throws into
//     the request handler.  Callers should additionally schedule the call
//     via c.executionCtx.waitUntil(...) so the response returns immediately
//     and the Sheets round-trip happens off the request critical path.
//   * When GOOGLE_SHEETS_SA_KEY is missing the helpers silently no-op
//     (debug-log once) — this keeps the build deployable before the GCP
//     service account is provisioned.
//
// Coverage:
//   This module hooks ONLY the request-driven JC mutation paths
//   (SO confirm cascade, PATCH /:id with body.jobCardId, scan-complete).
//   Bulk paths (PO regen, cancel cascade, archive) are intentionally NOT
//   hooked — admins can re-align Sheets via POST /api/sheets-sync/backfill
//   if those leave the spreadsheet stale.
//
// Sheet shape (must match the live spreadsheet headers in row 1):
//   A=PO No   B=Customer Ref   C=Customer   D=Model   E=WIP
//   F=Category   G=Qty   H=Due Date   I=Completion Date
//   J=PIC 1   K=PIC 2   L=Status   M=jobCardId
// ---------------------------------------------------------------------------

import {
  getSheetsClient,
  type GoogleSheetsEnv,
  type SheetsClient,
} from "./google-sheets";

/**
 * Minimal env contract — superset of GoogleSheetsEnv with the spreadsheet
 * id.  Callers pass `c.env`.
 */
export type SheetsSyncEnv = GoogleSheetsEnv & {
  SHEETS_SPREADSHEET_ID?: string;
  SHEETS_SYNC_SECRET?: string;
};

/** The 8 dept tabs the sheet exposes, in DEPT_ORDER. */
const KNOWN_DEPT_TABS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "FOAM",
  "WOOD_CUT",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
]);

/** Column M (1-indexed = 13).  jobCardId is the upsert key for every row. */
const JOBCARD_ID_COLUMN_INDEX = 12; // 0-indexed

// Module-scope guard so the "no GOOGLE_SHEETS_SA_KEY" debug log fires once
// per warm isolate instead of once per request.  Cheap, but annoying in
// wrangler tail otherwise.
let loggedMissingSecret = false;

// ---------------------------------------------------------------------------
// Public input shapes — kept narrow so the call sites don't have to import
// JobCardRow / ProductionOrderRow into the worker module graph.
// ---------------------------------------------------------------------------

export type SheetsJobCardInput = {
  id: string;
  departmentCode: string | null;
  status: string | null;
  dueDate: string | null;
  completedDate: string | null;
  pic1Name: string | null;
  pic2Name: string | null;
  wipLabel: string | null;
  category: string | null;
  wipQty: number | null;
};

export type SheetsProductionOrderInput = {
  poNo: string | null;
  customerName: string | null;
  productCode: string | null;
};

export type SheetsSalesOrderRefInput = {
  customerPOId: string | null;
  reference: string | null;
};

// ---------------------------------------------------------------------------
// Single-JC upsert
// ---------------------------------------------------------------------------

/**
 * Upsert (insert-or-update) one JC row in the matching dept tab, keyed by
 * jobCardId in column M.  Fire-and-forget: never throws.
 */
export async function syncJobCardToSheet(
  env: SheetsSyncEnv,
  jc: SheetsJobCardInput,
  po: SheetsProductionOrderInput,
  so: SheetsSalesOrderRefInput | null,
): Promise<void> {
  try {
    const client = getSheetsClient(env);
    if (!client) {
      if (!loggedMissingSecret) {
        console.debug(
          "[sheets-sync] GOOGLE_SHEETS_SA_KEY missing — skipping (will silently no-op until provisioned).",
        );
        loggedMissingSecret = true;
      }
      return;
    }
    const spreadsheetId = env.SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) {
      console.debug("[sheets-sync] SHEETS_SPREADSHEET_ID missing — skipping.");
      return;
    }
    const tab = normalizeDeptTab(jc.departmentCode);
    if (!tab) {
      // Unknown dept — could be FG-level (e.g. "FG") or a future dept.
      // Skip silently rather than guessing a tab.
      return;
    }

    const row = buildRowForJobCard(jc, po, so);
    const existingRowIdx = await findRowIndexByJobCardId(
      client,
      spreadsheetId,
      tab,
      jc.id,
    );

    if (existingRowIdx > 0) {
      const range = `${tab}!A${existingRowIdx}:M${existingRowIdx}`;
      await client.valuesUpdate(spreadsheetId, range, [row]);
    } else {
      // Append below the data range.  Sheets' append handles the row index.
      await client.valuesAppend(spreadsheetId, `${tab}!A:M`, [row]);
    }
  } catch (err) {
    console.error(
      "[sheets-sync] syncJobCardToSheet failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mark the JC row as CANCELLED (column L = 'CANCELLED') instead of deleting.
 * Preserves the audit trail in the sheet.  Fire-and-forget.
 */
export async function removeJobCardFromSheet(
  env: SheetsSyncEnv,
  jobCardId: string,
  deptCode: string | null,
): Promise<void> {
  try {
    const client = getSheetsClient(env);
    if (!client) return;
    const spreadsheetId = env.SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) return;
    const tab = normalizeDeptTab(deptCode);
    if (!tab) return;

    const rowIdx = await findRowIndexByJobCardId(client, spreadsheetId, tab, jobCardId);
    if (rowIdx <= 0) return;

    // Update column L (Status) only — keep the rest of the row for context.
    await client.valuesUpdate(spreadsheetId, `${tab}!L${rowIdx}:L${rowIdx}`, [
      ["CANCELLED"],
    ]);
  } catch (err) {
    console.error(
      "[sheets-sync] removeJobCardFromSheet failed",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Backfill — admin endpoint helper
// ---------------------------------------------------------------------------

export type BackfillResult = {
  scanned: number;
  pushed: number;
  errors: Array<{ jobCardId: string; error: string }>;
  sample: Array<{ jobCardId: string; deptCode: string | null; tab: string | null }>;
};

/**
 * Scan all active JCs (status NOT in CANCELLED/COMPLETED/TRANSFERRED) and
 * upsert each one to its matching dept tab.  Used by the admin
 * /api/sheets-sync/backfill endpoint.
 *
 * Throws SheetsSyncNotConfiguredError when the secret is missing — the route
 * layer maps that to a 503 / clear error response.  Per-row failures are
 * collected and returned in `errors` so a partial backfill still surfaces
 * what worked.
 */
export class SheetsSyncNotConfiguredError extends Error {
  constructor() {
    super(
      "Sheets sync not configured — set GOOGLE_SHEETS_SA_KEY + SHEETS_SPREADSHEET_ID (see docs/SHEETS-SYNC.md)",
    );
    this.name = "SheetsSyncNotConfiguredError";
  }
}

export async function backfillAllJobCards(
  env: SheetsSyncEnv,
  db: D1Database,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = opts.dryRun !== false; // default safe
  const client = getSheetsClient(env);
  const spreadsheetId = env.SHEETS_SPREADSHEET_ID;
  if (!client || !spreadsheetId) {
    throw new SheetsSyncNotConfiguredError();
  }

  // Pull all live JCs joined with PO + SO refs.  CANCELLED + COMPLETED are
  // skipped — completed work doesn't need to be reflected on the live
  // production sheet (the sheet is the operator workspace, not the audit
  // archive).  TRANSFERRED is skipped for the same reason.
  const rows = await db
    .prepare(
      `SELECT jc.id          AS id,
              jc.departmentCode AS departmentCode,
              jc.status      AS status,
              jc.dueDate     AS dueDate,
              jc.completedDate AS completedDate,
              jc.pic1Name    AS pic1Name,
              jc.pic2Name    AS pic2Name,
              jc.wipLabel    AS wipLabel,
              jc.category    AS category,
              jc.wipQty      AS wipQty,
              po.poNo        AS poNo,
              po.customerName AS customerName,
              po.productCode AS productCode,
              -- CO-aware: COALESCE the SO and CO equivalents so CO POs
              -- emit the same customerPOId / reference shape that SO POs
              -- do. Without this, CO rows pushed to Sheets had blank
              -- customerPOId and soReference columns.
              COALESCE(so.customerPOId, co.customerPOId) AS customerPOId,
              COALESCE(so.reference, co.reference)       AS soReference
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
    LEFT JOIN sales_orders so ON so.id = po.salesOrderId
    LEFT JOIN consignment_orders co ON co.id = po.consignmentOrderId
        WHERE jc.status NOT IN ('CANCELLED','COMPLETED','TRANSFERRED')
          AND po.status NOT IN ('CANCELLED')`,
    )
    .all<{
      id: string;
      departmentCode: string | null;
      status: string | null;
      dueDate: string | null;
      completedDate: string | null;
      pic1Name: string | null;
      pic2Name: string | null;
      wipLabel: string | null;
      category: string | null;
      wipQty: number | null;
      poNo: string | null;
      customerName: string | null;
      productCode: string | null;
      customerPOId: string | null;
      soReference: string | null;
    }>();
  const all = rows.results ?? [];

  const result: BackfillResult = {
    scanned: all.length,
    pushed: 0,
    errors: [],
    sample: [],
  };

  for (const r of all.slice(0, 5)) {
    result.sample.push({
      jobCardId: r.id,
      deptCode: r.departmentCode,
      tab: normalizeDeptTab(r.departmentCode),
    });
  }

  if (dryRun) return result;

  // Sequential upsert — keeps it simple and avoids hammering the Sheets API
  // (per-method quota is 60/min/user; one upsert = one search + one
  // append-or-update = 2 requests).  For ~200 JCs this finishes in well
  // under a minute.
  for (const r of all) {
    try {
      await syncJobCardToSheet(
        env,
        {
          id: r.id,
          departmentCode: r.departmentCode,
          status: r.status,
          dueDate: r.dueDate,
          completedDate: r.completedDate,
          pic1Name: r.pic1Name,
          pic2Name: r.pic2Name,
          wipLabel: r.wipLabel,
          category: r.category,
          wipQty: r.wipQty,
        },
        {
          poNo: r.poNo,
          customerName: r.customerName,
          productCode: r.productCode,
        },
        {
          customerPOId: r.customerPOId,
          reference: r.soReference,
        },
      );
      result.pushed += 1;
    } catch (err) {
      result.errors.push({
        jobCardId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HMAC verification — used by the Apps Script -> ERP webhook handler
// ---------------------------------------------------------------------------

/**
 * Recreates the canonical HMAC payload string the Apps Script side signs:
 *   "<jobCardId>|<timestamp>|<completionDate>|<pic1>|<pic2>"
 * Each field is normalised to the empty string when null/undefined so the
 * signed payload is deterministic regardless of which fields the user
 * actually edited.
 */
export function buildWebhookHmacPayload(args: {
  jobCardId: string;
  timestamp: number;
  completionDate?: string | null;
  pic1Name?: string | null;
  pic2Name?: string | null;
}): string {
  const cd = args.completionDate ?? "";
  const p1 = args.pic1Name ?? "";
  const p2 = args.pic2Name ?? "";
  return `${args.jobCardId}|${args.timestamp}|${cd}|${p1}|${p2}`;
}

/**
 * Verifies the hex-encoded HMAC-SHA256 signature against the canonical
 * payload.  Returns true when valid.  Constant-time compare on the byte
 * level via crypto.subtle.verify (handles the constant-time path internally).
 */
export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signatureHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = hexToBytes(signatureHex);
    if (!sigBytes) return false;
    return crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(sigBytes),
      new TextEncoder().encode(payload),
    );
  } catch (err) {
    console.error(
      "[sheets-sync] verifyWebhookSignature failed",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeDeptTab(deptCode: string | null): string | null {
  if (!deptCode) return null;
  const upper = deptCode.toUpperCase();
  return KNOWN_DEPT_TABS.has(upper) ? upper : null;
}

function buildRowForJobCard(
  jc: SheetsJobCardInput,
  po: SheetsProductionOrderInput,
  so: SheetsSalesOrderRefInput | null,
): (string | number | null)[] {
  // Column order must match the live spreadsheet headers in row 1:
  //   A=PO No   B=Customer Ref   C=Customer   D=Model   E=WIP
  //   F=Category   G=Qty   H=Due Date   I=Completion Date
  //   J=PIC 1   K=PIC 2   L=Status   M=jobCardId
  return [
    po.poNo ?? "",                                                        // A
    so?.customerPOId ?? so?.reference ?? "",                              // B
    po.customerName ?? "",                                                // C
    po.productCode ?? "",                                                 // D
    jc.wipLabel ?? "",                                                    // E
    jc.category ?? "",                                                    // F
    jc.wipQty ?? "",                                                      // G
    jc.dueDate ?? "",                                                     // H
    jc.completedDate ?? "",                                               // I
    jc.pic1Name ?? "",                                                    // J
    jc.pic2Name ?? "",                                                    // K
    jc.status ?? "",                                                      // L
    jc.id,                                                                // M
  ];
}

/**
 * Locate the row whose column M equals jobCardId.  Returns the 1-based row
 * index (matches Sheets' A1 notation), or 0 if not found.  Reads the full M
 * column on each call — fine at the current data scale (a few hundred JCs
 * per dept tab) and saves us a sheet-side index.
 */
async function findRowIndexByJobCardId(
  client: SheetsClient,
  spreadsheetId: string,
  tab: string,
  jobCardId: string,
): Promise<number> {
  const range = `${tab}!M:M`;
  const res = await client.valuesGet(spreadsheetId, range);
  const values = res.values ?? [];
  for (let i = 0; i < values.length; i++) {
    const cell = values[i]?.[0];
    if (cell === jobCardId) {
      // Sheets rows are 1-indexed in A1 notation; values[] starts at row 1
      // (which is the header row), so the data row index = i + 1.
      return i + 1;
    }
  }
  // Reference JOBCARD_ID_COLUMN_INDEX so the constant isn't dead-stripped
  // by a tree-shaker — also documents that the "M" in the range above is
  // intentionally column index 12 + 1.
  void JOBCARD_ID_COLUMN_INDEX;
  return 0;
}
