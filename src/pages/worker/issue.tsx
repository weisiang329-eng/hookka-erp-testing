// ============================================================
// /worker/issue — Report a shop-floor problem
//
// Five canned categories + free-text description + optional photo.
// Photo is captured via the phone's native `capture="environment"`
// attribute, which pops the camera on mobile Chrome / Safari.
//
// Submissions POST to /api/worker/issues which tags them with the
// current worker ID so whoever monitors approvals can contact them.
// ============================================================
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Camera, CheckCircle2 } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import { workerFetch } from "@/layouts/WorkerLayout";
import { WorkerActionResultSchema } from "@/lib/schemas/worker-job";

const CATEGORIES: Array<{ key: string; id: string }> = [
  { key: "issue.cat.material", id: "MATERIAL" },
  { key: "issue.cat.machine", id: "MACHINE" },
  { key: "issue.cat.quality", id: "QUALITY" },
  { key: "issue.cat.injury", id: "INJURY" },
  { key: "issue.cat.other", id: "OTHER" },
];

export default function WorkerIssuePage() {
  const t = useT();
  const [category, setCategory] = useState<string>("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Downscale to data URL: keeps payload tiny and avoids uploading
    // multi-MB phone-camera JPEGs through our mock API.
    const reader = new FileReader();
    reader.onload = () => {
      setPhoto(typeof reader.result === "string" ? reader.result : null);
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!category || !description.trim()) {
      setError(t("common.error"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await workerFetch("/api/worker/issues", {
        method: "POST",
        body: JSON.stringify({
          category,
          description: description.trim(),
          photoDataUrl: photo,
        }),
      });
      const raw = await res.json();
      const data = WorkerActionResultSchema.parse(raw);
      if (!data.success) {
        setError(data.error || t("common.error"));
        return;
      }
      setSent(true);
      setCategory("");
      setDescription("");
      setPhoto(null);
    } catch {
      setError(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="pt-10">
        <div className="bg-[#3E6570] text-white rounded-xl p-6 text-center">
          <CheckCircle2 className="h-12 w-12 mx-auto mb-3" />
          <p className="text-xl font-bold">{t("issue.sent")}</p>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setSent(false)}
            className="flex-1 h-12 rounded bg-white border border-[#D8D2CC] font-semibold text-sm"
          >
            {t("issue.title")}
          </button>
          <Link
            to="/worker"
            className="flex-1 h-12 rounded bg-[#6B5C32] text-white font-semibold text-sm flex items-center justify-center"
          >
            {t("nav.home")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center gap-2">
        <Link
          to="/worker"
          className="h-9 w-9 rounded hover:bg-white/60 flex items-center justify-center"
          aria-label={t("common.back")}
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-xl font-bold">{t("issue.title")}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Category chips */}
        <fieldset>
          <legend className="text-sm font-medium text-[#5A5550] mb-2">
            {t("issue.category")}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={`h-12 rounded-lg border text-sm font-semibold transition-colors ${
                  category === c.id
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "bg-white text-[#1F1D1B] border-[#D8D2CC] hover:bg-[#F0ECE9]"
                }`}
              >
                {t(c.key)}
              </button>
            ))}
          </div>
        </fieldset>

        {/* Description */}
        <label className="block">
          <span className="text-sm font-medium text-[#5A5550]">
            {t("issue.description")}
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="mt-1.5 w-full px-3 py-2 rounded border border-[#D8D2CC] bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#6B5C32] focus:border-[#6B5C32]"
            placeholder=""
          />
        </label>

        {/* Photo */}
        <label className="block">
          <span className="text-sm font-medium text-[#5A5550] mb-1.5 inline-block">
            Photo
          </span>
          {photo ? (
            <div className="relative">
              <img
                src={photo}
                alt="issue"
                className="w-full max-h-48 object-cover rounded-lg border border-[#D8D2CC]"
              />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                className="absolute top-2 right-2 h-8 px-3 rounded bg-white/90 text-xs font-semibold shadow"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <div className="w-full h-28 rounded-lg border-2 border-dashed border-[#D8D2CC] bg-white flex items-center justify-center text-[#8A8680] text-sm gap-2">
              <Camera className="h-5 w-5" />
              <span>Tap to capture</span>
            </div>
          )}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhotoChange}
            className="hidden"
            id="worker-issue-photo"
          />
          {!photo && (
            <label
              htmlFor="worker-issue-photo"
              className="block mt-2 h-11 rounded bg-white border border-[#D8D2CC] text-center leading-[44px] text-sm font-semibold text-[#1F1D1B] cursor-pointer"
            >
              <Camera className="inline h-4 w-4 mr-1.5 -mt-0.5" />
              Take photo
            </label>
          )}
        </label>

        {error && <p className="text-sm text-[#9A3A2D]">{error}</p>}

        <button
          type="submit"
          disabled={submitting || !category || !description.trim()}
          className="w-full h-14 rounded-lg bg-[#9A3A2D] hover:bg-[#832F24] disabled:opacity-60 text-white font-bold text-base transition-colors"
        >
          {submitting ? t("common.loading") : t("issue.submit")}
        </button>
      </form>
    </div>
  );
}
