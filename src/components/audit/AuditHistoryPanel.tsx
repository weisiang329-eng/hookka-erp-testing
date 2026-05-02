// ---------------------------------------------------------------------------
// AuditHistoryPanel — drop-in panel for any detail page.
//
// Fetches /api/audit-events?resource=X&resourceId=Y and renders the
// time-ordered "who changed what and when" list with field-level diffs.
// Modeled on the Inistate-style trail the operator referenced — each row
// shows the actor, the action chip, the timestamp, and an expandable
// list of "updated <field> from <old> to <new>" lines computed by
// diffing before vs after.
//
// Usage:
//   <AuditHistoryPanel resource="sales-orders" resourceId={so.id} />
//
// Empty / loading / error states render inline so the panel is safe to
// drop on a detail page that only has a few audit events (or none yet).
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Clock, User as UserIcon } from "lucide-react";

type AuditEvent = {
  id: string;
  actorUserId: string | null;
  actorUserName: string | null;
  actorRole: string | null;
  resource: string;
  resourceId: string;
  action: string;
  before: unknown;
  after: unknown;
  source: string;
  ipAddress: string | null;
  userAgent: string | null;
  ts: string;
};

type Props = {
  resource: string;
  resourceId: string;
  /**
   * Field keys to hide from the diff view — typically meta fields the
   * operator doesn't care about (updatedAt, syncedAt, internalRevisionNo,
   * etc.). Defaults to a sensible set; extend per-page if your model
   * carries extra noise.
   */
  ignoredFields?: string[];
  /**
   * Map of camelCase keys → human labels. e.g. { totalSen: "Total" }.
   * Falls back to title-cased key if missing.
   */
  fieldLabels?: Record<string, string>;
  /**
   * Custom formatter for known fields — useful when a key holds sen
   * (multiply by 100 for RM display) or an ISO date (format as YYYY-MM-DD).
   * Returns null to fall back to the default formatter.
   */
  formatValue?: (key: string, value: unknown) => string | null;
  /** Compact rendering — single-line per event, no expand-by-default. */
  compact?: boolean;
};

const DEFAULT_IGNORED = new Set([
  "updatedAt",
  "createdAt",
  "syncedAt",
  "lastSyncedAt",
  "lastModifiedAt",
  "version",
  "revision",
  // Tracking metadata that flips on every mutation but adds zero forensic value.
  "etag",
]);

// Convert "totalBudgetSen" → "Total Budget Sen" — caller can override
// via fieldLabels for prettier names like "Total Budget" or "Total (RM)".
function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatDefault(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 100 ? value.slice(0, 100) + "…" : value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return "{…}";
  return String(value);
}

// Walk before / after side-by-side; collect keys with shape changes.
// Deep-equal via JSON.stringify is "good enough" for the audit shapes
// (small POJOs serialised by emitAudit) — full deep-equal is overkill.
function computeDiff(
  before: unknown,
  after: unknown,
  ignored: Set<string>,
): { key: string; before: unknown; after: unknown }[] {
  const isObj = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  if (!isObj(before) && !isObj(after)) return [];
  const aKeys = isObj(before) ? Object.keys(before) : [];
  const bKeys = isObj(after) ? Object.keys(after) : [];
  const allKeys = Array.from(new Set([...aKeys, ...bKeys])).sort();
  const out: { key: string; before: unknown; after: unknown }[] = [];
  for (const k of allKeys) {
    if (ignored.has(k)) continue;
    const av = isObj(before) ? before[k] : undefined;
    const bv = isObj(after) ? after[k] : undefined;
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ key: k, before: av, after: bv });
    }
  }
  return out;
}

// Tone-coded chip for the action verb. Same vocabulary the audit
// emitter uses — matches the user's mental model (CREATE = green,
// DELETE = red, UPDATE = neutral).
function actionChip(action: string): { label: string; cls: string } {
  const lower = action.toLowerCase();
  if (lower === "create") return { label: "Created", cls: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" };
  if (lower === "delete" || lower === "void" || lower === "cancel")
    return { label: action.charAt(0).toUpperCase() + action.slice(1) + "d", cls: "bg-[#FAE5E0] text-[#9A3A2D] border-[#E8B5AB]" };
  if (lower === "update") return { label: "Updated", cls: "bg-[#F0ECE9] text-[#1F1D1B] border-[#E2DDD8]" };
  if (lower === "confirm" || lower === "approve" || lower === "post" || lower === "submit")
    return { label: action.charAt(0).toUpperCase() + action.slice(1) + "ed", cls: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]" };
  if (lower === "reject")
    return { label: "Rejected", cls: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]" };
  // Catch-all for module-specific actions (login / scan / role-change…).
  return { label: action, cls: "bg-[#F0ECE9] text-[#1F1D1B] border-[#E2DDD8]" };
}

// Tolerant date format. Audit ts comes back ISO; render as YYYY-MM-DD HH:MM
// in local time. If the parse fails (corrupt row) we render the raw string.
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function AuditHistoryPanel({
  resource,
  resourceId,
  ignoredFields,
  fieldLabels,
  formatValue,
  compact,
}: Props) {
  const url =
    resource && resourceId
      ? `/api/audit-events?resource=${encodeURIComponent(resource)}&resourceId=${encodeURIComponent(resourceId)}`
      : null;
  const { data: resp, loading } = useCachedJson<{ success?: boolean; data?: AuditEvent[] }>(url);

  const ignored = useMemo(
    () => new Set([...DEFAULT_IGNORED, ...(ignoredFields ?? [])]),
    [ignoredFields],
  );

  const events = resp?.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-400" />
          History
          {!loading && events.length > 0 && (
            <span className="text-xs font-normal text-gray-400">
              ({events.length} {events.length === 1 ? "event" : "events"})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && events.length === 0 ? (
          <div className="py-6 text-center text-xs text-gray-300">Loading history…</div>
        ) : events.length === 0 ? (
          <div className="py-6 text-center text-xs text-gray-300">
            No audit events recorded for this record yet.
          </div>
        ) : (
          <div className="divide-y divide-[#E2DDD8]">
            {events.map((e) => (
              <AuditRow
                key={e.id}
                event={e}
                ignored={ignored}
                fieldLabels={fieldLabels}
                formatValue={formatValue}
                compact={!!compact}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditRow({
  event,
  ignored,
  fieldLabels,
  formatValue,
  compact,
}: {
  event: AuditEvent;
  ignored: Set<string>;
  fieldLabels?: Record<string, string>;
  formatValue?: (key: string, value: unknown) => string | null;
  compact: boolean;
}) {
  const diffs = useMemo(
    () => computeDiff(event.before, event.after, ignored),
    [event.before, event.after, ignored],
  );
  const [expanded, setExpanded] = useState<boolean>(!compact && diffs.length > 0);
  const chip = actionChip(event.action);
  const fmt = (key: string, value: unknown): string => {
    if (formatValue) {
      const custom = formatValue(key, value);
      if (custom !== null) return custom;
    }
    return formatDefault(value);
  };
  const label = (key: string): string => fieldLabels?.[key] ?? humanizeKey(key);

  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        {/* Toggle / expand chevron — only renders when there are diffs to show */}
        {diffs.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-[#F0ECE9] hover:text-[#1F1D1B] flex-shrink-0"
            aria-label={expanded ? "Collapse changes" : "Expand changes"}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <div className="w-5 flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 text-[#1F1D1B] font-medium">
              <UserIcon className="h-3 w-3 text-gray-400" />
              {event.actorUserName || event.actorUserId || (event.source === "cron" || event.source === "system" ? "System" : "Unknown")}
            </span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${chip.cls}`}>
              {chip.label}
            </span>
            {event.actorRole && (
              <span className="text-[10px] text-gray-400 uppercase tracking-wide">
                {event.actorRole}
              </span>
            )}
            <span className="text-gray-400 ml-auto tabular-nums">
              {formatTs(event.ts)}
            </span>
          </div>

          {expanded && diffs.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {diffs.map((d) => (
                <li key={d.key} className="text-gray-600">
                  <span className="text-gray-500">updated </span>
                  <span className="font-semibold text-[#1F1D1B]">{label(d.key)}</span>
                  {event.before == null ? (
                    <>
                      <span className="text-gray-500"> to </span>
                      <span className="font-semibold text-[#4F7C3A]">{fmt(d.key, d.after)}</span>
                    </>
                  ) : event.after == null ? (
                    <>
                      <span className="text-gray-500"> (was </span>
                      <span className="font-semibold text-[#9A3A2D]">{fmt(d.key, d.before)}</span>
                      <span className="text-gray-500">)</span>
                    </>
                  ) : (
                    <>
                      <span className="text-gray-500"> from </span>
                      <span className="font-semibold text-[#9A3A2D]">{fmt(d.key, d.before)}</span>
                      <span className="text-gray-500"> to </span>
                      <span className="font-semibold text-[#4F7C3A]">{fmt(d.key, d.after)}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {expanded && diffs.length === 0 && event.action !== "create" && event.action !== "delete" && (
            <p className="text-[10px] text-gray-400 italic">No tracked field changes — likely a
              status flip or other meta-only action.</p>
          )}
        </div>
      </div>
    </div>
  );
}
