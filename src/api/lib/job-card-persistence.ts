import fs from "node:fs";
import path from "node:path";
import { productionOrders, workers, salesOrders } from "@/lib/mock-data";
import type { PiecePic } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// jobCard persistence — Option B
//
// Why: dev-server restarts wipe Upholstery completion data (completedDate,
// PIC, actualMinutes) because mock-data.ts re-seeds in-memory arrays. Until
// we move to SQLite/Prisma, we mirror the user-facing mutations into a JSON
// file and overlay them on boot so the data survives HMR and full restarts.
//
// Scope (minimum viable):
//   - per-job-card: status, completedDate, pic1Id, pic2Id, actualMinutes,
//                   dueDate, rackingNumber
//   - per-production-order: rackingNumber, stockedIn
//
// File: .data/job-card-overrides.json at repo root.
// ---------------------------------------------------------------------------

type JobCardOverride = {
  status?: string;
  completedDate?: string | null;
  pic1Id?: string | null;
  pic1Name?: string;
  pic2Id?: string | null;
  pic2Name?: string;
  actualMinutes?: number | null;
  dueDate?: string;
  rackingNumber?: string;
  overdue?: string;
  // B-flow sticker-binding FIFO: per-piece pic tracking. Restored on boot so
  // worker scans survive dev-server restarts. Legacy jc.pic1Id/pic2Id keep
  // working for A-flow; piecePics is the authoritative source for B-flow.
  piecePics?: PiecePic[];
};

type POOverride = {
  rackingNumber?: string;
  stockedIn?: boolean;
  status?: string;
  progress?: number;
  completedDate?: string | null;
  currentDepartment?: string;
};

type OverrideStore = {
  version: 1;
  updatedAt: string;
  jobCards: Record<string, JobCardOverride>; // key = `${poId}::${jcId}`
  pos: Record<string, POOverride>;           // key = poId
};

const DATA_DIR = path.join(process.cwd(), ".data");
const OVERRIDE_FILE = path.join(DATA_DIR, "job-card-overrides.json");

function emptyStore(): OverrideStore {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    jobCards: {},
    pos: {},
  };
}

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn("[job-card-persistence] cannot create .data dir:", e);
  }
}

function readStore(): OverrideStore {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) return emptyStore();
    const raw = fs.readFileSync(OVERRIDE_FILE, "utf-8");
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<OverrideStore>;
    return {
      version: 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      jobCards: parsed.jobCards || {},
      pos: parsed.pos || {},
    };
  } catch (e) {
    console.warn("[job-card-persistence] read failed, starting fresh:", e);
    return emptyStore();
  }
}

function writeStore(store: OverrideStore) {
  try {
    ensureDir();
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.warn("[job-card-persistence] write failed:", e);
  }
}

// Use a global-backed store so HMR reloads of this module keep the same
// object (otherwise PUT handlers between edits would drop in-flight patches).
const __g = globalThis as unknown as {
  __hookka_jobCardOverrideStore__?: OverrideStore;
  __hookka_jobCardOverridesApplied__?: boolean;
};

function getStore(): OverrideStore {
  if (!__g.__hookka_jobCardOverrideStore__) {
    __g.__hookka_jobCardOverrideStore__ = readStore();
  }
  return __g.__hookka_jobCardOverrideStore__!;
}

// ---------------------------------------------------------------------------
// Apply overrides to in-memory mock-data at boot. Idempotent — the global
// flag makes sure we only do it once per process.
// ---------------------------------------------------------------------------
export function applyOverridesOnce() {
  if (__g.__hookka_jobCardOverridesApplied__) return;
  const store = getStore();

  let jcHits = 0;
  let poHits = 0;

  for (const po of productionOrders) {
    const poPatch = store.pos[po.id];
    if (poPatch) {
      if (poPatch.rackingNumber !== undefined) po.rackingNumber = poPatch.rackingNumber;
      if (poPatch.stockedIn !== undefined) po.stockedIn = poPatch.stockedIn;
      poHits++;
    }

    for (const jc of po.jobCards) {
      const key = `${po.id}::${jc.id}`;
      const patch = store.jobCards[key];
      if (!patch) continue;
      if (patch.status !== undefined) jc.status = patch.status as typeof jc.status;
      if (patch.completedDate !== undefined) jc.completedDate = patch.completedDate;
      if (patch.pic1Id !== undefined) {
        jc.pic1Id = patch.pic1Id;
        const w = workers.find((x) => x.id === patch.pic1Id);
        jc.pic1Name = patch.pic1Name || w?.name || "";
      }
      if (patch.pic2Id !== undefined) {
        jc.pic2Id = patch.pic2Id;
        const w = workers.find((x) => x.id === patch.pic2Id);
        jc.pic2Name = patch.pic2Name || w?.name || "";
      }
      if (patch.actualMinutes !== undefined) jc.actualMinutes = patch.actualMinutes;
      if (patch.dueDate !== undefined) jc.dueDate = patch.dueDate;
      if (patch.rackingNumber !== undefined) jc.rackingNumber = patch.rackingNumber;
      if (patch.overdue !== undefined) jc.overdue = patch.overdue as typeof jc.overdue;
      if (patch.piecePics !== undefined && Array.isArray(patch.piecePics)) {
        // Seed data creates JCs WITHOUT piecePics — the scan endpoint
        // lazily initialises it. On boot-time restore we can't rely on
        // piecePics being present, so construct it from the saved payload
        // if missing. This is the root fix for the "scan succeeded but
        // didn't show up" bug: previously, a restart wiped in-memory
        // piecePics, FIFO then treated every saved-as-taken slot as
        // empty, and the next scan ran through them again — marking the
        // wrong PO complete and leaving the scanned one WAITING.
        //
        // The slot count comes from wipQty when we can trust it; otherwise
        // we fall back to the saved array length. The BOM-quantity-change
        // guard remains: only slots whose pieceNo appears in the saved
        // data get restored, dangling slots stay at defaults.
        const wipQty = Math.max(
          1,
          Math.floor(((jc as { wipQty?: number }).wipQty as number) || 0),
        );
        const slotCount = Math.max(wipQty, patch.piecePics.length);
        if (!jc.piecePics || !Array.isArray(jc.piecePics) || jc.piecePics.length === 0) {
          jc.piecePics = Array.from({ length: slotCount }, (_, i) => ({
            pieceNo: i + 1,
            pic1Id: null,
            pic1Name: "",
            pic2Id: null,
            pic2Name: "",
            completedAt: null,
            lastScanAt: null,
            boundStickerKey: null,
          }));
        }
        for (const saved of patch.piecePics) {
          const slot = jc.piecePics.find((s) => s.pieceNo === saved.pieceNo);
          if (!slot) continue;
          slot.pic1Id = saved.pic1Id;
          slot.pic1Name = saved.pic1Name || "";
          slot.pic2Id = saved.pic2Id;
          slot.pic2Name = saved.pic2Name || "";
          slot.completedAt = saved.completedAt;
          slot.lastScanAt = saved.lastScanAt;
          slot.boundStickerKey = saved.boundStickerKey;
        }
      }
      jcHits++;
    }

    // Recalculate PO progress/status from the overlaid jobCards so the
    // production page doesn't flash stale progress after a reboot.
    const done = po.jobCards.filter(
      (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
    ).length;
    po.progress = po.jobCards.length
      ? Math.round((done / po.jobCards.length) * 100)
      : 0;
    if (done === po.jobCards.length && po.jobCards.length > 0) {
      po.status = "COMPLETED";
      if (!po.completedDate) {
        po.completedDate = new Date().toISOString().split("T")[0];
      }
    } else if (done > 0) {
      po.status = "IN_PROGRESS";
    }
    const active = po.jobCards.find(
      (j) => j.status === "IN_PROGRESS" || j.status === "WAITING",
    );
    po.currentDepartment = active?.departmentCode || po.currentDepartment || "PACKING";
  }

  // Cascade to SO status — every upholstery job complete across sibling POs
  // on the same SO flips it to READY_TO_SHIP. Mirrors the runtime logic in
  // the PUT route so rebooting with overrides keeps the Delivery page honest.
  const soIds = new Set(
    productionOrders.map((p) => p.salesOrderId).filter(Boolean) as string[],
  );
  for (const soId of soIds) {
    const so = salesOrders.find((s) => s.id === soId);
    if (!so) continue;
    const siblings = productionOrders.filter((p) => p.salesOrderId === soId);
    if (siblings.length === 0) continue;
    const totalUph = siblings.reduce(
      (n, p) => n + p.jobCards.filter((j) => j.departmentCode === "UPHOLSTERY").length,
      0,
    );
    if (totalUph === 0) continue;
    const everyUphDone = siblings.every((p) => {
      const uph = p.jobCards.filter((j) => j.departmentCode === "UPHOLSTERY");
      if (uph.length === 0) return true;
      return uph.every(
        (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
      );
    });
    if (everyUphDone && so.status !== "READY_TO_SHIP") {
      so.status = "READY_TO_SHIP";
      so.updatedAt = new Date().toISOString();
    }
  }

  __g.__hookka_jobCardOverridesApplied__ = true;
  if (jcHits > 0 || poHits > 0) {
    console.log(
      `[job-card-persistence] applied ${jcHits} jobCard / ${poHits} PO overrides from ${OVERRIDE_FILE}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Mutation API — call these after mutating the in-memory row, they persist
// the delta to disk. We keep the whole store in memory and rewrite on every
// call because the file is tiny and writes are rare (dev-only).
// ---------------------------------------------------------------------------
export function saveJobCardOverride(
  poId: string,
  jcId: string,
  patch: JobCardOverride,
) {
  const store = getStore();
  const key = `${poId}::${jcId}`;
  store.jobCards[key] = { ...(store.jobCards[key] || {}), ...patch };
  writeStore(store);
}

export function savePOOverride(poId: string, patch: POOverride) {
  const store = getStore();
  store.pos[poId] = { ...(store.pos[poId] || {}), ...patch };
  writeStore(store);
}

// Debug helper — exposed so an admin page can nuke the overrides when mock
// data gets rebased. Not wired to any route yet.
export function clearAllOverrides() {
  const store = emptyStore();
  __g.__hookka_jobCardOverrideStore__ = store;
  writeStore(store);
}
