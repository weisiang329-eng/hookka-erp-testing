// ---------------------------------------------------------------------------
// announcement-translate.test.mjs — auto-translation for office → worker
// announcements. Two surfaces under test, no network:
//
//   1. parseTranslationsText() (src/api/lib/translate-announcement.ts) — the
//      pure JSON parse + validation that turns Claude's reply into the stored
//      blob, or null. Fences, prose-wrapped JSON, a missing language, a wrong
//      value type → all must yield null so the row stores null and the worker
//      FE falls back to the original posted text. A Claude outage can NEVER
//      corrupt the row or block posting.
//
//   2. The worker FE language picker (mirror of localizeAnnouncement in
//      src/pages/worker/index.tsx) — must show the worker-language version
//      when present and fall back to the original title/body whenever the
//      translation is missing, null, or blank.
//
// translateAnnouncement() itself (the fetch) is not exercised here — it has no
// pure surface without a network; the parse + the FE picker are where the
// regressions bite (BUG-2026-06-23: announcement auto-translation).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTranslationsText,
  ANNOUNCEMENT_LANGS,
} from "../src/api/lib/translate-announcement.ts";

const GOOD = {
  en: { title: "Holiday Notice", body: "Factory closed Friday." },
  ms: { title: "Notis Cuti", body: "Kilang tutup Jumaat." },
  zh: { title: "假期通知", body: "工厂周五休息。" },
  my: { title: "အားလပ်ရက် အသိပေးချက်", body: "စက်ရုံ သောကြာနေ့ ပိတ်သည်။" },
};

// ---- 1. parseTranslationsText ---------------------------------------------

test("parse: clean JSON yields all four languages", () => {
  const out = parseTranslationsText(JSON.stringify(GOOD));
  assert.ok(out, "should parse");
  for (const lang of ANNOUNCEMENT_LANGS) {
    assert.equal(out[lang].title, GOOD[lang].title);
    assert.equal(out[lang].body, GOOD[lang].body);
  }
});

test("parse: strips ```json fences", () => {
  const fenced = "```json\n" + JSON.stringify(GOOD) + "\n```";
  const out = parseTranslationsText(fenced);
  assert.ok(out);
  assert.equal(out.ms.title, "Notis Cuti");
});

test("parse: tolerates leading/trailing prose around the JSON", () => {
  const noisy =
    "Here is the translation:\n" + JSON.stringify(GOOD) + "\nDone.";
  const out = parseTranslationsText(noisy);
  assert.ok(out);
  assert.equal(out.zh.body, "工厂周五休息。");
});

test("parse: a missing language → null (FE falls back to original)", () => {
  const { my: _drop, ...threeOnly } = GOOD;
  const out = parseTranslationsText(JSON.stringify(threeOnly));
  assert.equal(out, null);
});

test("parse: a non-string title → null", () => {
  const bad = { ...GOOD, en: { title: 123, body: "x" } };
  assert.equal(parseTranslationsText(JSON.stringify(bad)), null);
});

test("parse: a missing body field → null", () => {
  const bad = { ...GOOD, ms: { title: "Notis" } };
  assert.equal(parseTranslationsText(JSON.stringify(bad)), null);
});

test("parse: empty body strings are allowed (body-less notice)", () => {
  const blankBody = {
    en: { title: "Hi", body: "" },
    ms: { title: "Hai", body: "" },
    zh: { title: "你好", body: "" },
    my: { title: "မင်္ဂလာပါ", body: "" },
  };
  const out = parseTranslationsText(JSON.stringify(blankBody));
  assert.ok(out);
  assert.equal(out.en.body, "");
});

test("parse: garbage / empty / non-JSON → null (never throws)", () => {
  assert.equal(parseTranslationsText(""), null);
  assert.equal(parseTranslationsText("   "), null);
  assert.equal(parseTranslationsText("not json at all"), null);
  assert.equal(parseTranslationsText("{ broken"), null);
});

// ---- 2. worker FE language picker (mirror of localizeAnnouncement) --------
// Kept in lock-step with src/pages/worker/index.tsx; if the FE logic changes,
// this copy must change with it.
function localize(a, lang) {
  const t = a.translations?.[lang];
  return {
    title: t?.title?.trim() ? t.title : a.title,
    body: t?.body?.trim() ? t.body : a.body,
  };
}

test("FE picker: shows the worker-language version when present", () => {
  const a = {
    id: "ann-1",
    title: "Holiday Notice",
    body: "Factory closed Friday.",
    createdAt: null,
    translations: GOOD,
  };
  assert.deepEqual(localize(a, "ms"), {
    title: "Notis Cuti",
    body: "Kilang tutup Jumaat.",
  });
  assert.deepEqual(localize(a, "my"), {
    title: GOOD.my.title,
    body: GOOD.my.body,
  });
});

test("FE picker: null translations → original posted text (Claude outage)", () => {
  const a = {
    id: "ann-2",
    title: "Stock Take Today",
    body: "Line A only.",
    createdAt: null,
    translations: null,
  };
  for (const lang of ANNOUNCEMENT_LANGS) {
    assert.deepEqual(localize(a, lang), {
      title: "Stock Take Today",
      body: "Line A only.",
    });
  }
});

test("FE picker: missing translations field → original text (legacy row)", () => {
  const a = {
    id: "ann-3",
    title: "Old Notice",
    body: "Posted before translation shipped.",
    createdAt: null,
  };
  assert.deepEqual(localize(a, "zh"), {
    title: "Old Notice",
    body: "Posted before translation shipped.",
  });
});

test("FE picker: a blank translated field falls back per-field", () => {
  const a = {
    id: "ann-4",
    title: "Mixed",
    body: "Original body.",
    createdAt: null,
    translations: {
      en: { title: "Mixed", body: "Original body." },
      ms: { title: "", body: "Badan terjemahan." }, // blank title only
      zh: { title: "混合", body: "   " }, // whitespace-only body
      my: { title: "ရော", body: "မူရင်း" },
    },
  };
  // ms: blank title → original title, translated body kept
  assert.deepEqual(localize(a, "ms"), {
    title: "Mixed",
    body: "Badan terjemahan.",
  });
  // zh: whitespace body → original body, translated title kept
  assert.deepEqual(localize(a, "zh"), {
    title: "混合",
    body: "Original body.",
  });
});
