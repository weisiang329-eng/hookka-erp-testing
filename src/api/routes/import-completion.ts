// ---------------------------------------------------------------------------
// import-completion.ts — one-shot historical job_card completion importer.
//
// Wei Siang is migrating ~3000 historical orders from Google Sheets into the
// ERP. The source data has, per (custPONo, deptCode), a completion date and
// up to two short-name PIC tags. This endpoint marks the matching job_cards
// COMPLETED with the right PIC, completion date, and `actualMinutes`, AND
// fires the same downstream cascades a normal scan-driven completion would:
//
//   1. applyWipInventoryChange  — wip_items rows for upstream consume +
//      this dept's producer-add (UPHOLSTERY also zeros upstream branch
//      terminals; PACKING is skipped from this cascade by design).
//   2. postJobCardLabor         — LABOR_POSTED cost_ledger entry per JC.
//   3. postProductionOrderCompletion — fires once per PO when ALL its JCs
//      reach COMPLETED. Generates fg_units, writes fg_batches, runs the
//      Track F cost cascade (RM FIFO consume → FG cost backfill → WIP
//      marker). All steps inside this helper are idempotent.
//
// Dry-run mode (?dryRun=true on body) returns the same response shape with
// counts only and zero side effects so the caller can validate match rate
// before committing.
//
// Worker name resolution
//   The Google Sheets log uses short names ("AUNG", "PHOO", "MIN") that
//   don't always match workers.name 1:1. WORKER_NAME_MAP below is the
//   canonical short-name → full-name table (keyed by GS short, value =
//   workers.name to look up). Two short names ("AUNG KO", "KYAW") have
//   real ambiguity in the worker roster — we pick the documented first
//   match and surface a picWarnings entry so the caller can spot-check.
//
// Chunking
//   Default: 100 rows per call. Caller passes ?cursor=<n> to resume from
//   the next chunk. When `cursor` is omitted, processing starts at row 0
//   of the rows[] array supplied in the body. Mirrors the cursor pattern
//   from /api/bom/resync-job-card-times — caller loops until
//   `cursor.hasMore === false`.
//
// Permission
//   production-orders:update — same gate as the PATCH handler that the
//   shop-floor app uses to flip JC status. This is intentional: the
//   importer is a privileged backfill tool, not an end-user surface.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import completionCascades from "./import-completion/completion-cascades";
import wipFixes from "./import-completion/wip-fixes";
import dateFixes from "./import-completion/date-fixes";
import sofaPricing from "./import-completion/sofa-pricing";
import priceBackfill from "./import-completion/price-backfill";
import procurementBackfills from "./import-completion/procurement-backfills";
import soCoDoBackfills from "./import-completion/so-co-do-backfills";
import fgFabric from "./import-completion/fg-fabric";
import audits from "./import-completion/audits";

const app = new Hono<Env>();

app.route("/", completionCascades);
app.route("/", wipFixes);
app.route("/", dateFixes);
app.route("/", sofaPricing);
app.route("/", priceBackfill);
app.route("/", procurementBackfills);
app.route("/", soCoDoBackfills);
app.route("/", fgFabric);
app.route("/", audits);

export default app;
