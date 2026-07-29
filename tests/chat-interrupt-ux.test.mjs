// ---------------------------------------------------------------------------
// chat-interrupt-ux.test.mjs — pins the ChatGPT-style composer (owner 2026-07-29
// 「像 ChatGPT」): you can type WHILE the assistant is streaming, and sending
// interrupts the in-flight reply. Structural pins (source assertions, the repo
// idiom); the live UX is verified in the browser.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/components/assistant/AssistantSlideOver.tsx", import.meta.url),
  "utf8",
);

test("the composer textarea is NOT disabled while busy (can type mid-stream)", () => {
  // The textarea block must not carry `disabled={busy}`.
  const ta = src.slice(src.indexOf("<textarea"), src.indexOf("</textarea>") > -1 ? src.indexOf("/>", src.indexOf("<textarea")) + 2 : src.length);
  assert.doesNotMatch(ta, /disabled=\{busy\}/, "textarea must stay editable while the assistant streams");
});

test("send does NOT early-return on busy; it interrupts the in-flight turn", () => {
  assert.doesNotMatch(
    src,
    /if \(\(!trimmed && !hasAttachments\) \|\| busy\) return;/,
    "the busy guard that blocked sending must be gone",
  );
  assert.match(
    src,
    /if \(busy\) abortRef\.current\?\.abort\(\);/,
    "a send while busy must abort the in-flight stream first",
  );
});

test("a superseded turn's finally cannot clobber the newer turn's state", () => {
  assert.match(
    src,
    /if \(abortRef\.current === ctrl\) \{\s*setBusy\(false\);\s*abortRef\.current = null;\s*\}/,
    "finally must only reset busy/abortRef when THIS turn is still the active one",
  );
});

test("Stop shows only when busy AND nothing typed; otherwise Send (interrupt-capable)", () => {
  assert.match(
    src,
    /busy && !draft\.trim\(\) && attachments\.length === 0 \? \(/,
    "Stop button is shown only while streaming with an empty draft; a typed draft shows Send",
  );
});
