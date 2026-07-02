// ============================================================================
// GlobalSearchSheet — "Search All" (CHANGELOG O.1 + spec §Search): one search
// box on the Home header that searches EVERY module at once — customer / PO /
// SO / reference / doc number / product / supplier / rack / employee / case…
//
// Config-driven: instead of hand-listing fields per module (which silently
// drifted — only 7 of 20 modules were covered, the rest returned nothing), it
// reuses the SAME MODULE_CONFIGS the lists are built from. For each module it
//   • warms that module's list endpoint on open (best-effort, cache-backed),
//   • matches the query against that source's declared text columns (the
//     module's real "search matches" from the spec's Filter·Sort·Search table),
//   • renders the match via the source's own toVM (correct code / title / items)
//     and navigates via the module's own detailPath.
// So every module is searchable, with the right fields, and it stays in sync as
// configs change. No new backend — pure client-side over the cache we prime.
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { Sheet } from "./Sheet";
import { StatusPill } from "./StatusPill";
import { M } from "../theme";
import { cachedFetchJson, peekCache } from "@/lib/cached-fetch";
import { MODULE_CONFIGS } from "../config/modules";
import type { DataSource, ModuleConfig, RawRow, RowVM } from "../config/types";

type Hit = {
  key: string;
  moduleTitle: string;
  path: string | null;
  vm: RowVM;
};

type Group = { moduleTitle: string; results: Hit[] };

type Props = { open: boolean; onClose: () => void };

// Max hits shown per module source (keeps the sheet scannable).
const PER_SOURCE = 6;

// Every distinct list endpoint across all module sources — warmed on open so
// even modules the operator hasn't visited yet are searchable.
const ALL_SOURCE_URLS: string[] = Array.from(
  new Set(MODULE_CONFIGS.flatMap((c) => c.sources.map((s) => s.url))),
);

/** Read a warmed endpoint payload out of the cache and pull its rows via the
 * source's own `select` (the exact unwrap the list uses). Never throws. */
function rowsOf(src: DataSource): RawRow[] {
  const cached = peekCache<unknown>(src.url);
  if (cached == null) return [];
  try {
    const rows = src.select(cached);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** The searchable haystack for one row = its declared text columns (the
 * module's real "search matches"). Cheap: just the column getters. */
function matchesQuery(src: DataSource, row: RawRow, ql: string): boolean {
  for (const col of src.columns) {
    if (col.type !== "text") continue;
    try {
      const v = col.value(row);
      if (typeof v === "string" && v.toLowerCase().includes(ql)) return true;
    } catch {
      /* skip a bad column getter */
    }
  }
  return false;
}

/** Fallback haystack when a source declares no text columns — match the VM's
 * own code/title/items so the module is never silently un-searchable. */
function vmMatches(vm: RowVM, ql: string): boolean {
  return (
    vm.code.toLowerCase().includes(ql) ||
    vm.title.toLowerCase().includes(ql) ||
    (vm.items ?? vm.subLine ?? "").toLowerCase().includes(ql)
  );
}

function searchModule(cfg: ModuleConfig, ql: string): Hit[] {
  const out: Hit[] = [];
  const seen = new Set<string>();
  for (const src of cfg.sources) {
    const hasTextCol = src.columns.some((c) => c.type === "text");
    let count = 0;
    for (const row of rowsOf(src)) {
      if (count >= PER_SOURCE) break;
      let vm: RowVM;
      try {
        vm = src.toVM(row);
      } catch {
        continue;
      }
      const hit = hasTextCol
        ? matchesQuery(src, row, ql)
        : vmMatches(vm, ql);
      if (!hit) continue;
      const path = cfg.detailPath?.(vm, row) ?? `/m/${cfg.slug}`;
      const dedupe = `${cfg.slug}:${vm.id}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ key: dedupe, moduleTitle: cfg.title, path, vm });
      count++;
    }
  }
  return out;
}

export function GlobalSearchSheet({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  // Bumped as each cold endpoint warms so freshly-fetched modules appear in the
  // results without the operator re-typing.
  const [warmTick, setWarmTick] = useState(0);

  // Warm every module's list endpoint when the sheet opens. Cache-backed +
  // deduped by cached-fetch, so already-visited modules are instant and cold
  // ones fetch once. Best-effort — a failed warm just leaves that module out.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const url of ALL_SOURCE_URLS) {
      void cachedFetchJson(url)
        .then(() => {
          if (alive) setWarmTick((t) => t + 1);
        })
        .catch(() => {
          /* silent — module just won't have results until next visit */
        });
    }
    return () => {
      alive = false;
    };
  }, [open]);

  const groups: Group[] = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!open || !ql) return [];
    const out: Group[] = [];
    for (const cfg of MODULE_CONFIGS) {
      const results = searchModule(cfg, ql);
      if (results.length > 0) out.push({ moduleTitle: cfg.title, results });
    }
    return out;
    // warmTick is an intentional dep: re-run as cold endpoints finish warming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, warmTick]);

  const totalHits = useMemo(
    () => groups.reduce((n, g) => n + g.results.length, 0),
    [groups],
  );

  // Reset query when the sheet re-opens (render-time, not in an effect — the
  // codebase's no-setState-in-effect rule).
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (!open && q) setQ("");
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <div
        style={{
          padding: "16px 16px 8px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 13px",
            backgroundColor: M.card,
            border: `1px solid ${M.hairline}`,
            borderRadius: 12,
          }}
        >
          <Search size={18} strokeWidth={1.75} color={M.faint} />
          <input
            autoFocus
            value={q}
            placeholder="Search all — customer, SO, PO, product, supplier…"
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: M.raisin,
              fontFamily: "inherit",
            }}
          />
          {q ? (
            <button
              onClick={() => setQ("")}
              aria-label="Clear"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: M.hairline,
                border: "none",
                cursor: "pointer",
                flex: "none",
              }}
            >
              <X size={13} color={M.body} />
            </button>
          ) : null}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            width: 38,
            height: 38,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 600,
            color: M.taupe,
          }}
        >
          Cancel
        </button>
      </div>

      {/* Result-count line — the "Search All" affordance: how many across how
          many modules, so the operator knows the search spans everything. */}
      {q.trim() ? (
        <div
          style={{
            padding: "2px 20px 6px",
            fontSize: 11.5,
            color: M.muted,
            fontWeight: 600,
          }}
        >
          {totalHits === 0
            ? "No matches across all modules"
            : `${totalHits} result${totalHits === 1 ? "" : "s"} in ${groups.length} module${groups.length === 1 ? "" : "s"}`}
        </div>
      ) : null}

      <div
        style={{
          padding: "4px 16px 90px",
          overflowY: "auto",
          maxHeight: "calc(85dvh - 96px)",
        }}
      >
        {q.trim().length === 0 ? (
          <div
            style={{
              color: M.muted,
              fontSize: 13,
              padding: "24px 8px",
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            Search every module at once — customer name, SO / PO / DO / invoice
            number, product, supplier, rack, service case, or any reference.
          </div>
        ) : groups.length === 0 ? (
          <div
            style={{
              color: M.muted,
              fontSize: 13,
              padding: "24px 8px",
              textAlign: "center",
            }}
          >
            No matches. Try a document number, customer, or reference.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.moduleTitle} style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: M.muted,
                  padding: "6px 4px",
                }}
              >
                {g.moduleTitle} · {g.results.length}
              </div>
              {g.results.map((h) => (
                <button
                  key={h.key}
                  onClick={() => {
                    onClose();
                    if (h.path) navigate(h.path);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "11px 12px",
                    background: M.card,
                    border: `1px solid ${M.hairline}`,
                    borderRadius: 12,
                    marginBottom: 7,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: M.taupe,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {h.vm.code || "—"}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: M.raisin,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h.vm.title}
                    </div>
                    {h.vm.items || h.vm.subLine ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: M.muted,
                          marginTop: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h.vm.items || h.vm.subLine}
                      </div>
                    ) : null}
                  </div>
                  {h.vm.status ? (
                    <StatusPill
                      style={h.vm.status.style}
                      label={h.vm.status.label}
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </Sheet>
  );
}
