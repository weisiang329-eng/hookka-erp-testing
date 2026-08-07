// ============================================================
// /worker/qc — Quality Check on the phone (IPQC / WIP).
//
// Until 2026-08-07 the shop floor could not reach QC at all: QC lived only in
// the desktop ERP sidebar, which a machinist never opens. 3,009 inspections
// sat PENDING for three months and not one was ever completed.
//
// This screen is deliberately the smallest thing that closes a slot:
//   • only the logged-in worker's OWN current department,
//   • only today's slots,
//   • PASS / FAIL / N/A per item, and a FAIL must carry one line of text.
//
// Everything else (RM/IQC, FG/OQC, Skip, history, templates) stays on the
// desktop page. The backend re-checks the department, the stage and the job
// card — see the QC block in src/api/routes/worker.ts.
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch } from "@/layouts/WorkerLayout";

type QcItem = {
  id: string;
  sequence: number;
  itemName: string;
  criteria: string;
  severity: string;
  isMandatory: boolean;
};
type QcInspection = {
  id: string;
  inspectionNo: string;
  stage: string;
  deptCode: string;
  status: string;
  scheduledSlotAt: string;
  items: QcItem[];
};
type QcSubject = { id: string; label: string; poNo: string; status: string };
type QcToday = {
  deptCode: string;
  date: string;
  subjects: QcSubject[];
  inspections: QcInspection[];
};

type Result = "PASS" | "FAIL" | "NA";
type Answer = { result: Result | null; notes: string };

const SEVERITY_TONE: Record<string, string> = {
  MINOR: "bg-[#FDF6E3] text-[#8A6D1F]",
  MAJOR: "bg-[#FBEEE6] text-[#9A5B2D]",
  CRITICAL: "bg-[#FBE9E7] text-[#9A3A2D]",
};

export default function WorkerQcPage() {
  const t = useT();
  const [data, setData] = useState<QcToday | null>(null);
  const [loading, setLoading] = useState(true);
  // A load failure must say ERROR. The desktop page spent three months
  // rendering a failed fetch as "no production today" — the phone does not
  // repeat that.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await workerFetch("/api/worker/qc-today");
      const json = (await res.json()) as { success?: boolean; error?: string; data?: QcToday };
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json.data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount data load; `load` is a stable useCallback (same pattern as worker/index.tsx)
    void load();
  }, [load]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/worker" className="text-[#6B5C32]" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-bold text-[#1F1D1B] flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[#6B5C32]" />
          {t("qc.title")}
        </h1>
      </div>

      {loading && <p className="text-sm text-[#8A8680]">…</p>}

      {loadError && (
        <p className="rounded-lg bg-[#FBE9E7] px-3 py-2 text-sm font-medium text-[#9A3A2D]">
          {loadError}
        </p>
      )}

      {!loading && !loadError && data && (
        <>
          <p className="text-xs text-[#8A8680]">
            {t("qc.todayFor")} <span className="font-semibold text-[#1F1D1B]">{data.deptCode || "—"}</span>
            {" · "}{data.date}
          </p>

          {data.inspections.length === 0 ? (
            <p className="rounded-xl border border-[#D8D2CC] bg-white p-4 text-sm text-[#8A8680]">
              {t("qc.none")}
            </p>
          ) : (
            data.inspections.map((insp) => (
              <InspectionCard
                key={insp.id}
                insp={insp}
                subjects={data.subjects}
                onDone={load}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function InspectionCard({
  insp, subjects, onDone,
}: { insp: QcInspection; subjects: QcSubject[]; onDone: () => void }) {
  const t = useT();
  const [subjectId, setSubjectId] = useState(subjects.length === 1 ? subjects[0].id : "");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const setResult = (itemId: string, result: Result) =>
    setAnswers((prev) => ({
      ...prev,
      [itemId]: { result, notes: prev[itemId]?.notes ?? "" },
    }));
  const setNotes = (itemId: string, notes: string) =>
    setAnswers((prev) => ({
      ...prev,
      [itemId]: { result: prev[itemId]?.result ?? null, notes },
    }));

  const answered = insp.items.filter((i) => answers[i.id]?.result);
  const allMandatoryAnswered = insp.items.every(
    (i) => !i.isMandatory || answers[i.id]?.result,
  );
  // A FAIL with no words is not a finding. Enforced here for a fast, local
  // message; the server enforces it again so no client can skip it.
  const failMissingReason = insp.items.some(
    (i) => answers[i.id]?.result === "FAIL" && !answers[i.id]?.notes.trim(),
  );

  async function submit() {
    setError(null);
    if (!subjectId) { setError(t("qc.subject")); return; }
    if (!allMandatoryAnswered) { setError(t("qc.answerAll")); return; }
    if (failMissingReason) { setError(t("qc.failReasonMissing")); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch(`/api/worker/qc/${insp.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          subjectId,
          items: answered.map((i) => ({
            id: i.id,
            result: answers[i.id].result,
            notes: answers[i.id].notes.trim() || undefined,
          })),
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setSent(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-xl border border-[#CFE0D8] bg-[#F2F8F4] p-4 text-sm font-medium text-[#2F6B4F] flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5" />
        {t("qc.sent")}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#D8D2CC] bg-white p-4 space-y-3">
      <p className="font-mono text-xs text-[#8A8680]">{insp.inspectionNo}</p>

      <label className="block">
        <span className="text-xs font-medium text-[#8A8680]">{t("qc.subject")}</span>
        {subjects.length === 0 ? (
          <p className="mt-1 text-sm text-[#8A8680]">{t("qc.subjectNone")}</p>
        ) : (
          <select
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-[#D8D2CC] bg-white p-3 text-base"
          >
            <option value="">—</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        )}
      </label>

      <div className="divide-y divide-[#EDE9E4]">
        {insp.items.map((item) => {
          const a = answers[item.id];
          return (
            <div key={item.id} className="py-3 space-y-2">
              <div className="flex items-start gap-2">
                <span className="flex-1 text-sm font-medium text-[#1F1D1B]">
                  {item.sequence}. {item.itemName}
                </span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_TONE[item.severity] ?? "bg-[#F2F0ED] text-[#8A8680]"}`}>
                  {item.severity}
                </span>
              </div>
              {item.criteria && (
                <p className="text-xs text-[#8A8680]">{item.criteria}</p>
              )}
              {item.isMandatory && (
                <p className="text-[10px] uppercase tracking-wide text-[#9A5B2D]">{t("qc.required")}</p>
              )}
              <div className="grid grid-cols-3 gap-2">
                {(["PASS", "FAIL", "NA"] as Result[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setResult(item.id, r)}
                    className={`h-12 rounded-lg border text-sm font-bold transition-colors ${
                      a?.result === r
                        ? r === "PASS"
                          ? "border-[#2F6B4F] bg-[#2F6B4F] text-white"
                          : r === "FAIL"
                            ? "border-[#9A3A2D] bg-[#9A3A2D] text-white"
                            : "border-[#8A8680] bg-[#8A8680] text-white"
                        : "border-[#D8D2CC] bg-white text-[#1F1D1B]"
                    }`}
                  >
                    {r === "PASS" ? t("qc.pass") : r === "FAIL" ? t("qc.fail") : t("qc.na")}
                  </button>
                ))}
              </div>
              {a?.result === "FAIL" && (
                <input
                  value={a.notes}
                  onChange={(e) => setNotes(item.id, e.target.value)}
                  placeholder={t("qc.failReason")}
                  className="block w-full rounded-lg border border-[#9A3A2D] bg-white p-3 text-base"
                />
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="rounded-lg bg-[#FBE9E7] px-3 py-2 text-sm font-medium text-[#9A3A2D]">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting || subjects.length === 0}
        className="h-14 w-full rounded-xl bg-[#6B5C32] text-lg font-bold text-white disabled:opacity-40"
      >
        {t("qc.submit")}
      </button>
    </div>
  );
}
