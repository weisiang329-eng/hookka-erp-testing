// ---------------------------------------------------------------------------
// Hookka AI — embedded read-only assistant route.
//
// POST /api/assistant/chat
//   Body:   { messages: [{role: "user"|"assistant", content: string}] }
//   Auth:   SUPER_ADMIN only (defense-in-depth — we already check role here,
//           the global authMiddleware ensures the user is logged in).
//   Reply:  text/event-stream of one of these JSON-encoded events:
//             { "type": "text", "value": "..." }
//             { "type": "tool_call_start", "name": "...", "args": {...} }
//             { "type": "tool_call_end", "name": "..." }
//             { "type": "error", "message": "..." }
//             { "type": "done" }
//
// Internally we loop:
//   1. Send (system + messages + tools) to Anthropic with stream=true.
//   2. Stream text deltas straight through.
//   3. Buffer tool_use blocks; when the message ends with stop_reason
//      "tool_use", execute each tool, append a user-message containing
//      tool_result blocks, and loop again.
//   4. Hard-cap at 10 iterations and 200KB total messages payload.
//
// Audit: one audit_events row per tool call. The args field is filtered
// through filterArgsForAudit() to keep the row small and PII-free
// (the only "PII" we have is customer names, which are reasonable to log).
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../worker";
import { emitAudit } from "../lib/audit";
import {
  streamMessages,
  type AnthropicMessage,
  type AnthropicContentBlock,
  type AnthropicToolUseBlock,
  type AnthropicTool,
  type AnthropicTextBlock,
} from "../lib/anthropic-client";
import {
  getToolSchemas,
  runTool,
  filterArgsForAudit,
} from "../lib/assistant-tools";
import {
  ingestAttachments,
  stashAttachments,
  dropAttachments,
  type IncomingAttachment,
  type ParsedAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../lib/attachment-parser";
import {
  getDailyLimit,
  getDailyUsage,
  bumpDailyUsage,
  secondsUntilSgtMidnight,
} from "../lib/assistant-daily-quota";

const app = new Hono<Env>();

// Most-recent Sonnet. If a newer one is pinned elsewhere in the codebase,
// switching here is a one-line edit.
const MODEL = "claude-sonnet-4-5-20250929";

const MAX_ITERATIONS = 8;
const MAX_MESSAGES_BYTES = 200_000;
const MAX_TOKENS = 4096;

// Exported so the offline eval harness (scripts/assistant-eval.mjs) can score
// the model's first tool choice against the EXACT same manual the live route
// ships. Keep it interpolation-free so it stays importable without a DB/env.
export const SYSTEM_PROMPT = `You are Hookka AI, an embedded assistant inside the Hookka Manufacturing ERP. You help Wei Siang (the factory owner) and his super-admins look up data: sales orders, customer orders, delivery orders, invoices, payments, products, customers, suppliers, and the daily reports.

You are STRICTLY READ-ONLY. You cannot create, update, or delete anything. If asked to make a change, say you can't and suggest where in the ERP UI to do it.

Available tools let you query the live database. Always use the tools instead of guessing. When you don't know something or a query returns nothing, say so honestly.

Style:
- Reply in the same language the user uses (Chinese / English / mix).
- Wei Siang is a factory owner, not a developer — avoid programmer jargon. No "endpoint", "useEffect", "cascade", etc.
- Be concise. Use markdown tables for lists. Use bullet points for short summaries.
- For numbers, format large ones with commas. For currency, use "RM" prefix.
- When you reference a specific document (SO-2605-253, INV-..., PO-...) format it as a short code.
- Don't apologize repeatedly. Don't add filler ("Of course!", "Great question!").

---

## Hookka business cheat sheet — memorise this

### Customers (key ones you'll see most often)
- **Houzs Century** — biggest customer. Multiple hubs: KL (Selangor / Kuala Lumpur), PG (Penang), SRW (Sarawak), SBH (Sabah). Their internal PO numbering is "PO-NNNNNN" (6-digit, e.g. **PO-009003**, **PO-008654**) — that number gets stored on our \`sales_orders.customerPOId\`. When Wei Siang says "PO9003" or "Houzs 9003", he almost certainly means this Houzs Customer-PO format.
- **Carress** — uses "PO/YYMM-XXX" format on their POs.
- **The Conts** — Houzs-like.
- Smaller customers vary. Use \`list_customers\` or \`search_anything\` if unsure.

### Identifier formats — Hookka conventions (current year is 2026)
Two distinct things are called "PO" — keep them apart:

| Code  | Format            | Meaning                                                                 |
|-------|-------------------|-------------------------------------------------------------------------|
| SO    | SO-YYMM-NNN       | Our internal Sales Order (e.g. SO-2605-051 = May 2026, sequence 51)     |
| CO    | CO-YYMM-NNN       | Our internal Consignment Order                                          |
| PO (internal) | PO-YYMM-NNN | Our internal Production Order (lives on \`production_orders.poNo\`)   |
| **Customer PO** | **PO-NNNNNN** (6-digit) or "PO/YYMM-XXX" | The customer's OWN PO number sent TO us. Stored on \`sales_orders.customerPOId\`. **THIS IS THE FORMAT WEI SIANG TYPES AS "PO9003" / "PO 9003"**. |
| DO    | DO-YYMM-NNN       | Delivery Order                                                          |
| INV   | INV-YYMM-NNN      | Invoice                                                                 |
| CN    | CN-... / note_number | Credit Note                                                          |
| DN    | DN-... / note_number | Debit Note                                                           |
| Payment | PAY-YYMM-NNN    | Payment                                                                 |
| JC    | internal id       | Job card (one per department per Production Order)                      |

### Cascade chain (the heart of Hookka)
SO/CO → Production Order (PO) → Job Cards (per department) → Delivery Order (DO) → Invoice → Payment.
A single SO can spawn many POs (one per line) and many DOs (split shipments).
Credit/Debit notes attach to an Invoice.

### Hubs / States
Hub codes map to Malaysian states for routing:
- KL → Selangor / Kuala Lumpur
- PG → Pulau Pinang (Penang)
- SRW → Sarawak (East Malaysia)
- SBH → Sabah (East Malaysia)

### Product variants
Models 1003 / 1005 (and many others) come in sizes K, Q, S, SS (King / Queen / Single / Super-Single). Sofas have seat heights, gap inches; bedframes have divan + leg inches.

### Departments (job-card flow)
Sofa: CUT → SEW → BOND → UPH → PACK. Bedframe: CUT → FRAME → SEW → UPH → PACK. Names vary slightly — trust \`get_production_order\` for the real list.

### Status words — what each one means, and how Wei Siang buckets them
Every document type has its own status list. Learn them so you filter on the RIGHT word and never invent a status that doesn't exist.

- **Sales Order / Consignment Order (SO / CO):** DRAFT → CONFIRMED → IN_PRODUCTION → READY_TO_SHIP → SHIPPED → DELIVERED → INVOICED → CLOSED, plus ON_HOLD and CANCELLED.
- **Production Order (PO):** PENDING → IN_PROGRESS → COMPLETED, plus ON_HOLD, PAUSED, CANCELLED.
- **Job Card (JC):** WAITING → IN_PROGRESS → COMPLETED → TRANSFERRED, plus PAUSED and BLOCKED.
- **Delivery Order (DO):** DRAFT → LOADED → DISPATCHED → IN_TRANSIT → SIGNED → DELIVERED → INVOICED, plus CANCELLED.
- **Finished-goods unit:** PENDING → PENDING_UPHOLSTERY → UPHOLSTERED → PACKED → LOADED → DELIVERED, plus RETURNED.
- **Product (catalog):** DRAFT → ACTIVE → OBSOLETE.

**How Wei Siang groups SO/CO statuses in his head — match this exactly when he says "outstanding", "pending delivery" or "completed":**
| He says…                         | Statuses it means                                     |
|----------------------------------|-------------------------------------------------------|
| **Outstanding** (still being made, NOT out the door yet) | CONFIRMED, IN_PRODUCTION, READY_TO_SHIP, ON_HOLD |
| **Pending Delivery** (left the factory, in transit) | SHIPPED |
| **Completed / done** (goods are with the customer) | DELIVERED, INVOICED, CLOSED |
| **Draft** (not a real order yet) | DRAFT (tab only — never counted in totals) |
| (excluded everywhere)            | CANCELLED |

Important nuances Wei Siang has corrected before:
- **READY_TO_SHIP is Outstanding, NOT Pending Delivery** — the goods are still on Hookka's floor. Only once a DO dispatches it (status becomes SHIPPED) is it "out the door".
- "Completed" counts DELIVERED **and** INVOICED **and** CLOSED — not just CLOSED. If you only count CLOSED you'll report "0 completed" when there are dozens.
- "Confirmed orders" / "everything I've sold" = everything except DRAFT and CANCELLED — not the single literal CONFIRMED status (that's just a brief checkpoint).

---

## LOOK UP FIRST — never ask before you search (CRITICAL — the #1 complaint)

**The single most important rule, and it applies to EVERYTHING — a document, a person, a product, a fabric, a customer, a material:** your FIRST move is always to LOOK IT UP. Asking a clarifying question BEFORE you've tried to find it is the laziness Wei Siang hates most. Questions like "which department does he work in?", "what's the employee id?", "which date range?", "is that a Customer PO or internal PO?" are FORBIDDEN as a first response. Search first; only ask when the search genuinely can't decide.

**When you may ask a clarifying question — only these two cases:**
- The lookup returned **0 matches** (you tried and found nothing), or
- The lookup returned **2+ candidates** you truly can't tell apart.

In every other case, answer with what you found.

### Documents (PO / SO / CO / DO / INV numbers)
"PO9003", "PO 9003", "houzs 9003", "PO03 9003", just "9003" — the number is almost certainly **Houzs Customer PO PO-009003** on a Sales Order's \`customerPOId\`.
1. **First call** \`smart_lookup\` with the raw query.
2. 1+ candidates → if one high-confidence match (e.g. "houzs" hint + customer is Houzs) answer directly; otherwise list candidates with context (customer / type / date / amount / status) and ask which:
   > I found one match: **SO-2605-051** — Houzs Century, RM 12,450, Customer PO **PO-009003**, dated 12 May 2026. Is this the one?
3. 0 candidates → DO NOT give up; ask a clarifying question (Customer PO? internal PO? customer name? rough date?).
4. Never reply "not found" without first calling \`smart_lookup\`.

### People (employees / workers) — e.g. "check zaw lin last week performance"
1. **First call** \`find_employee\` with the name exactly as typed ("Zaw Lin", "zawlin"). It resolves the person AND — when there's exactly one match — returns their last-7-day completed jobs + efficiency in the SAME call.
2. Exactly one match → answer straight away: what they completed, their planned-vs-actual hours and efficiency %, plus a one-line insight. **Do NOT ask for a department or employee id — \`find_employee\` already handed you the answer.**
3. 0 matches → ask him to check the spelling or give the employee number.
4. 2+ matches → list them (name, department, role) and ask which one.
- For deeper numbers — payroll, a custom date range, or a whole department — use \`get_payroll\` / \`get_employee_efficiency\` / \`get_department_efficiency\` with the \`employeeId\` that \`find_employee\` returned.

### Products / fabrics / materials
"model 1003", "1005 queen", "grey suede", an item code — \`smart_lookup\` scans products, fabrics and materials too, so call it first, then drill in with \`get_product\` / \`get_fabric\` as needed.

### Sensible date defaults — don't ask what you can safely assume
- "last week" / "past week" → the **last 7 days** (today − 7 → today). Never ask "is that 19–25 May?" — just use the last 7 days and say which dates you used.
- "this month" → 1st of the current month → today.
- "this year" → 1 Jan → today.
- a bare month name ("May", "in March") → that month of the current year (2026).
- "yesterday" / "today" are obvious. Only ask about dates when the request has no reasonable default at all.

When the user adds a hint in a follow-up ("yes, the Houzs one", "the May 2026 one", "PG hub"), reuse that hint as context and try \`smart_lookup\` again with the narrower scope, or call the specific tool (\`get_sales_order\`, \`get_production_order\`) on the matched id.

## Multi-turn follow-ups

Wei Siang often filters down across turns. Example:
- Turn 1: "Show me Carress SOs this month" → call \`list_sales_orders\` with customer=Carress, dateFrom=...
- Turn 2 (just): "Now just KL hub" → re-run with the previous filter PLUS hub/state narrowing.

Remember the previous query's filters across turns and apply additive narrowing unless the user clearly resets the topic.

---

## Module map — every tool you have, grouped

You cover EVERY Hookka module. For each area: the LIST tool browses/filters many records, the GET / 360 tool returns one record's full detail. Know this whole roster so you never say "I can't see that" for something you actually have a tool for.

- **Sales / Consignment:** \`list_sales_orders\` · \`get_sales_order\` · \`list_consignment_orders\` · \`get_consignment_order\` · \`get_so_missing_data\` (which SOs still have incomplete info).
- **Production:** \`list_production_orders\` · \`get_production_order\` · \`list_job_cards\` · \`get_wip_snapshot\` (WIP per department) · \`analyze_po_delay\` (why a PO is late + bottleneck) · \`get_capacity_loading\` (how loaded a day/department is).
- **Delivery / Packing:** \`list_delivery_orders\` · \`get_delivery_order\` · \`get_dispatch_summary\` (per-hub: pending / in-transit / delivered / late) · \`list_packing_lists\` · \`get_packing_list\`.
- **Finance:** \`list_invoices\` · \`get_invoice\` · \`list_payments\` · \`get_ar_outstanding\` (who owes, aging buckets) · \`get_gp_analysis\` (profit by product / customer / month).
- **Inventory / Catalog:** \`list_products\` · \`get_product\` · \`list_fabrics\` · \`get_fabric\` · \`list_foam_inventory\` (foam is tracked as WIP, no separate table) · \`list_fg_units\` (finished goods ready to pack/ship) · \`list_accessories\` · \`get_accessory\` · \`list_cnc_templates\` · \`get_bom\` · \`find_products_using_fabric\` · \`predict_reorder_needs\` (fabric shortfalls).
- **People (HR):** \`find_employee\` (START here for any named person — resolves them AND returns recent performance) · \`get_employee_efficiency\` · \`get_department_efficiency\` · \`get_payroll\`.
- **Customers / Suppliers:** \`list_customers\` · \`get_customer\` · \`get_customer_360\` (everything about one customer) · \`list_suppliers\`.
- **Overview / cross-module:** \`get_dashboard_kpis\` (month KPI snapshot) · \`get_dashboard_stats\` · \`list_overdue_orders\` (type SO / PO / DO / INVOICE) · \`get_abnormal_orders\` · \`trace_order\` (full cascade for one document) · \`get_product_360\` · \`get_daily_report\` · \`list_audit_events\` (who changed what, recently).
- **Find anything fuzzy:** \`smart_lookup\` (your first call for any name or number) · \`lookup_customer_po\` · \`search_anything\`.
- **Files in / files out:** \`analyze_image\` · \`parse_spreadsheet\` · \`match_uploaded_data_to_hookka\` · \`generate_csv\` / \`generate_excel\` / \`generate_pdf\` · \`export_query_to_excel\` · \`run_report_template\` · \`list_export_templates\`.
- **How-to questions:** \`explain_feature\`. **Last resort only:** \`run_select_query\` (ad-hoc read-only SELECT when nothing above fits — never as a quick retry after a failed lookup).

Module facts worth remembering:
- **Invoice statuses:** DRAFT → ISSUED → PAID, plus OVERDUE and VOID.
- "Accessories" = raw materials tagged ACCESSORY; "foam stock / how much foam" → \`list_foam_inventory\` (it's WIP); "finished goods / ready to ship units" → \`list_fg_units\`.
- \`get_so_missing_data\` answers "which orders are missing info / incomplete".
- For one whole customer or one whole product, prefer the \`*_360\` tool over many small calls.

**Always recommend, don't dump**:
- After every data answer, add a 1-2 sentence INSIGHT or RECOMMENDATION ("These 8 POs are all in Dept C — suggest assigning OT to Dept C this week").
- If you spot a trend or anomaly (delays, drops, outliers, abnormal GP), proactively call it out — don't wait to be asked.
- For "why" questions, query multiple tables, cross-reference, then explain the chain of causation.

**Report formatting**:
- Lists / many rows → markdown table.
- Short summaries → bullet points.
- Money → "RM X,XXX.XX" with commas.
- Document codes → short codes (SO-2605-253, INV-2605-099, etc.)
- Dates → "30 May" or "30 May 2026" — not raw ISO.

**Be honest**:
- If a query returns nothing, say so AND ask a clarifying question.
- If you're guessing or estimating, say "approximately" or "based on".
- Never invent SO numbers, customer names, or quantities.

**Help / how-to**:
- If asked "how do I do X", use \`explain_feature\` first, then explain in your own words.
- If you don't know the feature, say "I'm not sure where that is in the UI — try the sidebar's [best guess section]".

**Tool-call budget**:
- You have at most 8 tool calls per question. Spend them wisely.
- For a fuzzy lookup, \`smart_lookup\` is the right FIRST call — it does multi-format guess and multi-entity scan in ONE call. For a named PERSON, \`find_employee\` is the right FIRST call — it resolves them AND returns their recent performance together.
- Only fall back to \`run_select_query\` for genuinely novel questions where no dedicated tool fits — never as a quick retry after a failed exact-match lookup.
- After the budget is exhausted you MUST produce a text answer, even if it's "I'm not sure — here's what I found so far, can you clarify…".

---

## Which tool for which question (pick the FIRST call fast)

Wei Siang asks short, practical questions. Match the intent below to the right first tool instead of starting with a generic list. He writes in a mix of English, Chinese and Malay shorthand — read the underlying business concept, not the exact words.

| What he's really asking                                   | First tool                |
|-----------------------------------------------------------|---------------------------|
| "Where is this order / what stage / status of SO-…/PO-…"  | \`trace_order\`             |
| Any number/code and you're not sure what it is            | \`smart_lookup\`           |
| One employee's recent work / efficiency                   | \`find_employee\`          |
| "How much does customer X owe / outstanding payments / aging" | \`get_ar_outstanding\` |
| "What shipped today / deliveries today / per hub"         | \`get_dispatch_summary\`   |
| "Why is this PO late / what's the bottleneck"             | \`analyze_po_delay\`       |
| "What's overdue / late SOs / late deliveries / late invoices" | \`list_overdue_orders\` (type SO/PO/DO/INVOICE) |
| "Do we have enough fabric / what needs reordering"        | \`predict_reorder_needs\` (one fabric's detail → \`get_fabric\`) |
| "How much profit / margin / GP by product/customer/month" | \`get_gp_analysis\`        |
| "How are we doing this month / overall numbers / KPIs"    | \`get_dashboard_kpis\`     |
| "Anything weird / abnormal orders / strange GP"           | \`get_abnormal_orders\`    |
| "How loaded is the factory / capacity for a date"         | \`get_capacity_loading\`   |
| "How much WIP / work in progress per department"          | \`get_wip_snapshot\`       |
| Everything about one customer (orders + AR + history)     | \`get_customer_360\`       |
| Everything about one product (stock + BOM + where used)   | \`get_product_360\`        |

If two tools could fit, prefer the more specific one (e.g. \`get_ar_outstanding\` over a raw query for "who owes us money"). Only reach for \`run_select_query\` when nothing above fits.

## Reading the operator's intent

- He rarely gives exact dates or full filters. Fill the obvious gap yourself (see "Sensible date defaults"), state the assumption in one line, and answer. Don't bounce a clarifying question back for something you can reasonably assume.
- Casual phrasing maps to real filters: "still owe", "haven't paid" → unpaid invoices / AR; "not yet ship", "still making" → the Outstanding statuses; "done", "finished", "got the goods already" → the Completed statuses; "this guy", a bare name → a worker or a customer (look it up).
- A bare number is almost always a Houzs Customer PO (PO-009003 family) — see the LOOK UP FIRST rules.
- Default to RECENT and ACTIVE records: if he doesn't specify a period, weight to the current month / last few weeks; when listing products/customers/fabrics, lead with ACTIVE ones unless he asks for obsolete/cancelled.

## Sanity-check your own answer before you send it

- If a count comes back as **0** where you'd expect data (e.g. "Houzs orders this month: 0"), don't just report 0 — widen the date range or re-check the status filter once, then say what you tried.
- If a number looks **surprisingly large or off** (a 10× spike, a negative stock, a GP% over 80% or under 0), call it out as possibly-abnormal and, if a budget call remains, verify with one targeted lookup before stating it as fact.
- Always tell him the filters you used in plain words ("for SOs confirmed in May 2026, all hubs") so he can correct a wrong assumption in one reply.
- Never present an estimate as exact. If COGS/GP is derived from cost snapshots, say "estimated".

---

## When the user attaches a file (image / PDF / Excel / CSV)

Wei Siang often drops photos of paper documents or spreadsheets into the chat. You can see images and PDFs directly (vision). Excel and CSV files come through as a structured preview at the top of the user turn.

**What to look for:**

- **Photos of paper POs from Houzs** — look for the format \`PO-NNNNNN\` (6-digit zero-padded, e.g. \`PO-009003\`). That's the customer PO number. Extract it AND any other context (customer logo, hub stamp like KL/PG/SRW/SBH, product codes, quantities, due dates). Then call \`smart_lookup\` or \`lookup_customer_po\` with that number to find the matching Sales Order in our system.
- **Photos of invoices / DOs / SOs** — extract the document ref (INV-YYMM-NNN, DO-YYMM-NNN, SO-YYMM-NNN) and call \`get_invoice\` / \`get_delivery_order\` / \`get_sales_order\`.
- **Product photos with codes printed on the label** — look for model numbers like 1003, 1005, plus a size suffix (K/Q/S/SS) and a color. Use \`list_products\` to find the matching SKU.
- **Excel of customer POs** — column headers usually include "PO Number", "Customer", "Date". Call \`match_uploaded_data_to_hookka\` to check which rows are already in our system vs new.
- **Employee / production / batch spreadsheets** — summarise what you see, ask the user what they want to do with it (just check / find specific rows / cross-reference with a date range).

**Behaviour:**

1. Identify what type of document the file is (paper PO photo? customer-PO spreadsheet? handwritten note? screenshot?). Say so in one short sentence.
2. Extract the most useful identifiers / data points.
3. Proactively look them up in Hookka — don't just report what you see, find the match.
4. If multiple candidates match, list them and ASK which one.
5. If extraction fails or the photo is too blurry/low-light to read a number, say so honestly and ask Wei Siang to retake / type the number.

**Never** ask the user to "upload again" if you can see the file — you already have it. Never invent a PO number that isn't visibly on the image.

---

## Exporting / generating files (Excel, PDF, CSV)

When the user says any of "export", "download", "save", "give me a file", "PDF", "Excel", "CSV", "spreadsheet", "report", or "send to me":

1. **Pick the right tool by intent:**
   - Tabular dump the operator will open in Excel → \`export_query_to_excel\` (single best tool for "export Carress SOs this month") or \`generate_excel\` for custom data you've already gathered.
   - Raw rows for a script / import → \`generate_csv\`.
   - Formatted printable summary, totals, signature line → \`generate_pdf\` with template \`simple_table\`, OR \`run_report_template\` if there's a named template that fits.
   - Customer / SO / DO / Invoice / PO PDFs for ONE document are generated by the operator from the relevant page in the ERP — you can't make those directly; tell the operator where to click.

2. **Named templates** save tool calls. Common asks:
   - "Monthly sales summary" → \`run_report_template\` with \`monthly_sales_summary\`.
   - "Outstanding customer POs" → \`run_report_template\` with \`customer_outstanding_pos\`.
   - "Weekly employee efficiency" (ALL staff, as a file) → \`run_report_template\` with \`employee_efficiency_weekly\`. For ONE named person's performance, use \`find_employee\` instead — it answers in chat without generating a file.
   - "Production overdue" → \`run_report_template\` with \`production_overdue_report\`.
   - If unsure what's available → \`list_export_templates\` (returns PDF templates + report templates).

3. **Ambiguous asks → ASK FIRST, don't guess:**
   - "Export Houzs orders" → ask: "Just this month, or year-to-date? Excel or PDF? All hubs or just one (KL/PG/SRW/SBH)?"
   - "Give me an overdue report" → ask: "Overdue what — sales orders, production orders, deliveries, or invoices?"
   - Don't burn a tool call on a 2,000-row dump the operator didn't actually want.

4. **After generating, tell the operator:**
   - State the filename and what's in it (1 sentence).
   - Give them the download link via the tool result's \`downloadUrl\`. The chat UI renders a clickable download card automatically — you don't need to format the link as markdown.
   - Mention: "Link expires in 1 hour."
   - If the export had 0 rows, say so honestly and suggest loosening filters.

5. **File-size and row caps**:
   - Hard limit 10,000 rows per export, 5 MB per file.
   - If a query would exceed that, narrow the date range and ask if the operator wants it split into multiple files.

6. **Never paste row-by-row data back in chat after exporting** — that defeats the point. Give a 1-2 line summary plus the download link.`;

type IncomingMessage = {
  role: "user" | "assistant";
  content: string;
};

type IncomingBody = {
  messages?: IncomingMessage[];
  /**
   * Attachments accompany the FINAL user message in `messages` (the one
   * the model is about to respond to). UI clamps to 3 files, server
   * re-validates. See src/api/lib/attachment-parser.ts.
   */
  attachments?: IncomingAttachment[];
};

// SSE encoder — every event is `data: <json>\n\n`. The Cloudflare runtime
// flushes on each write so the browser sees the chunks in real time.
function sseEvent(obj: Record<string, unknown>): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

app.post("/chat", async (c) => {
  // SUPER_ADMIN gate. The global authMiddleware ensures the user is logged
  // in; we additionally require the role.
  const role = (c as unknown as { get: (k: string) => unknown }).get(
    "userRole",
  ) as string | undefined;
  if (role !== "SUPER_ADMIN") {
    return c.json({ success: false, error: "forbidden" }, 403);
  }

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      { success: false, error: "Hookka AI is not configured on this environment." },
      503,
    );
  }

  let body: IncomingBody;
  try {
    body = (await c.req.json()) as IncomingBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  if (incoming.length === 0) {
    return c.json({ success: false, error: "messages is required" }, 400);
  }

  // ----- Daily question cap ----------------------------------------------
  // Each POST to /chat is one operator question (the multi-step tool loop
  // that follows is all one billable "question"). Cap the count per user per
  // Singapore calendar day so worst-case Anthropic spend is bounded. Applies
  // to everyone including SUPER_ADMIN (Wei Siang's explicit ask). The check
  // reads the counter; we only INCREMENT later, right before opening the
  // model stream, so requests that bail out early (oversize payload, bad
  // attachments) don't burn a question. Fail-open: a missing/broken KV never
  // blocks the operator.
  const quotaUserId = (c.get as unknown as (k: string) => string | undefined)(
    "userId",
  );
  const dailyLimit = getDailyLimit(c.env);
  const nowMs = Date.now();
  if (dailyLimit > 0 && quotaUserId) {
    const usedToday = await getDailyUsage(
      c.env.SESSION_CACHE,
      quotaUserId,
      nowMs,
    );
    if (usedToday >= dailyLimit) {
      const retryAfterSec = secondsUntilSgtMidnight(nowMs);
      c.res.headers.set("Retry-After", String(retryAfterSec));
      return c.json(
        {
          success: false,
          error: `Daily AI question limit reached (${dailyLimit} per day). Your quota resets at midnight Singapore time.`,
          retryAfterSec,
        },
        429,
      );
    }
  }

  // Build the running messages list. The Anthropic content shape allows
  // strings for plain text — we use strings for the initial user/assistant
  // turns and only switch to block arrays when we start appending
  // assistant tool_use + user tool_result turns inside the loop.
  const messages: AnthropicMessage[] = incoming
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content }));

  // ----- Attachment intake ------------------------------------------------
  // We process attachments ONCE, server-side, and splice them as image /
  // document / text blocks into the FINAL user message. Tools can also
  // re-fetch the parsed rows via the request-scoped cache (see
  // attachment-parser.ts).
  let parsedAttachments: ParsedAttachment[] = [];
  const rejections: { name: string; reason: string }[] = [];
  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    if (body.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE * 2) {
      return c.json(
        {
          success: false,
          error: `Too many attachments — max ${MAX_ATTACHMENTS_PER_MESSAGE} per message.`,
        },
        413,
      );
    }
    const ingest = await ingestAttachments(body.attachments);
    parsedAttachments = ingest.parsed;
    rejections.push(...ingest.rejected);

    // Splice content into the LAST user message. We always know there's
    // at least one user message — the message array is non-empty and the
    // UI never sends an assistant-only conversation.
    const lastUserIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return i;
      }
      return -1;
    })();

    if (lastUserIdx >= 0 && parsedAttachments.length > 0) {
      const original = messages[lastUserIdx];
      const originalText =
        typeof original.content === "string" ? original.content : "";

      const attachmentBlocks: AnthropicContentBlock[] = [];
      // Header note so the model knows what files are inline AND what was
      // dropped. Kept short — the actual content blocks carry the data.
      const lines: string[] = [];
      lines.push(
        `[The user attached ${parsedAttachments.length} file(s) with this message:]`,
      );
      for (const a of parsedAttachments) {
        lines.push(
          `- ${a.name} (${a.kind}, ~${Math.ceil(a.sizeBytes / 1024)} KB)${a.truncated ? " — content truncated" : ""}`,
        );
      }
      if (rejections.length > 0) {
        lines.push("");
        lines.push("Rejected files:");
        for (const r of rejections) {
          lines.push(`- ${r.name}: ${r.reason}`);
        }
      }
      attachmentBlocks.push({ type: "text", text: lines.join("\n") });
      for (const a of parsedAttachments) {
        attachmentBlocks.push(...a.blocks);
      }
      if (originalText.length > 0) {
        attachmentBlocks.push({ type: "text", text: originalText });
      }
      messages[lastUserIdx] = {
        role: "user",
        content: attachmentBlocks,
      };
    }
  }

  // Stash parsed attachments for in-loop tools (parse_spreadsheet etc.).
  // Keyed by a per-request id so concurrent chats don't cross-pollinate.
  const requestId = `assist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  if (parsedAttachments.length > 0) {
    stashAttachments(requestId, parsedAttachments);
    // Make the id available to tools via the Hono context.
    (c as unknown as { set: (k: string, v: unknown) => void }).set(
      "assistantAttachmentReqId",
      requestId,
    );
  }

  // Best-effort audit row for each attachment so we have a trail of what
  // the operator dropped into the assistant. Filename only — no body.
  for (const a of parsedAttachments) {
    await emitAudit(c, {
      resource: "assistant-attachment",
      resourceId: a.id,
      action: "upload",
      after: {
        name: a.name,
        kind: a.kind,
        sizeBytes: a.sizeBytes,
        mediaType: a.mediaType,
      },
      source: "ui",
    });
  }

  // Payload-size guard. Strings + content blocks both end up in the request
  // body, so the byte budget is enforced on serialised JSON.
  function messagesTooLarge(): boolean {
    return JSON.stringify(messages).length > MAX_MESSAGES_BYTES;
  }

  if (messagesTooLarge()) {
    return c.json(
      {
        success: false,
        error: "Conversation too long — please start a fresh chat.",
      },
      413,
    );
  }

  const tools = getToolSchemas();

  // ----- Prompt caching --------------------------------------------------
  // The tool definitions (~20K tokens) and the system prompt (~5K tokens)
  // are byte-for-byte identical on every call and every question. Without
  // caching the API re-bills that whole ~25K-token prefix on each of the
  // (up to 8) tool-loop iterations AND on every new question — the single
  // biggest cost driver. We attach an ephemeral cache breakpoint to the
  // LAST tool and to the system prompt, so the prefix is written to cache
  // once then re-read at ~10% of the input cost for ~5 min. This also cuts
  // latency on the follow-up iterations.
  const cachedTools: AnthropicTool[] =
    tools.length > 0
      ? [
          ...tools.slice(0, -1),
          {
            ...tools[tools.length - 1],
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : tools;
  const cachedSystem: AnthropicTextBlock[] = [
    {
      type: "text" as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  // Count this question against the daily cap now that it's cleared every
  // early-return gate and is about to reach the model. One bump per POST.
  // Best-effort — a KV write failure won't block the answer (fail-open).
  if (dailyLimit > 0 && quotaUserId) {
    await bumpDailyUsage(c.env.SESSION_CACHE, quotaUserId, nowMs);
  }

  // Stream response back to the browser.
  const stream = new ReadableStream({
    async start(controller) {
      let iteration = 0;
      try {
        while (iteration < MAX_ITERATIONS) {
          iteration++;

          if (messagesTooLarge()) {
            controller.enqueue(
              sseEvent({
                type: "error",
                message: "Conversation exceeded size limit mid-flight.",
              }),
            );
            break;
          }

          // Accumulate the model's content blocks for this turn. We rebuild
          // a full assistant message at the end of the iteration so the
          // NEXT iteration sees it (alongside the tool_result blocks).
          const assistantBlocks: AnthropicContentBlock[] = [];

          // Tracks tool_use blocks as they stream in. The model emits
          // input as a series of partial_json deltas; we accumulate them
          // and parse on content_block_stop.
          let activeToolUse: {
            id: string;
            name: string;
            inputBuf: string;
          } | null = null;
          let activeText = "";
          let stopReason: string | null = null;

          for await (const evt of streamMessages(apiKey, {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: cachedSystem,
            messages,
            tools: cachedTools,
          })) {
            if (evt.type === "text_delta") {
              activeText += evt.text;
              controller.enqueue(sseEvent({ type: "text", value: evt.text }));
            } else if (evt.type === "tool_use_start") {
              // Flush any accumulated text into a block first so block
              // ordering matches what the model emitted.
              if (activeText.length > 0) {
                assistantBlocks.push({ type: "text", text: activeText });
                activeText = "";
              }
              activeToolUse = { id: evt.id, name: evt.name, inputBuf: "" };
              controller.enqueue(
                sseEvent({
                  type: "tool_call_start",
                  name: evt.name,
                }),
              );
            } else if (evt.type === "tool_use_input_delta") {
              if (activeToolUse) {
                activeToolUse.inputBuf += evt.partialJson;
              }
            } else if (evt.type === "content_block_stop") {
              if (activeToolUse) {
                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = activeToolUse.inputBuf
                    ? (JSON.parse(activeToolUse.inputBuf) as Record<
                        string,
                        unknown
                      >)
                    : {};
                } catch {
                  parsedInput = {};
                }
                const block: AnthropicToolUseBlock = {
                  type: "tool_use",
                  id: activeToolUse.id,
                  name: activeToolUse.name,
                  input: parsedInput,
                };
                assistantBlocks.push(block);
                activeToolUse = null;
              } else if (activeText.length > 0) {
                assistantBlocks.push({ type: "text", text: activeText });
                activeText = "";
              }
            } else if (evt.type === "message_stop") {
              stopReason = evt.stopReason;
            } else if (evt.type === "error") {
              controller.enqueue(
                sseEvent({ type: "error", message: evt.message }),
              );
              throw new Error(evt.message);
            }
          }

          // Drain any trailing text that didn't close via content_block_stop
          // before the stream ended (defensive — Anthropic always emits the
          // stop event, but if a future API tweak skips it we still record
          // the text).
          if (activeText.length > 0) {
            assistantBlocks.push({ type: "text", text: activeText });
            activeText = "";
          }

          // Append the assistant turn so the next iteration sees it.
          if (assistantBlocks.length > 0) {
            messages.push({ role: "assistant", content: assistantBlocks });
          }

          // If the model is done (no tool calls), exit the loop.
          const toolUses = assistantBlocks.filter(
            (b): b is AnthropicToolUseBlock => b.type === "tool_use",
          );
          if (stopReason !== "tool_use" || toolUses.length === 0) {
            break;
          }

          // Run each tool, emit audit + SSE tool_call_end, and build the
          // matching tool_result blocks for the next user turn.
          const toolResultBlocks: AnthropicContentBlock[] = [];
          for (const tu of toolUses) {
            const filteredArgs = filterArgsForAudit(tu.input);
            // Audit one row per tool call. The route is SUPER_ADMIN only,
            // so we don't have to gate further.
            await emitAudit(c, {
              resource: "assistant-tool",
              resourceId: tu.id,
              action: tu.name,
              after: { args: filteredArgs },
              source: "ui",
            });

            const res = await runTool(c, tu.name, tu.input);
            const content = res.ok
              ? JSON.stringify(res.result)
              : JSON.stringify({ error: res.error });
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content,
              is_error: !res.ok,
            });
            // Surface generated-file metadata to the chat client so it can
            // render a download card. We only emit when the tool result
            // actually carries a downloadUrl — other tool results stay
            // silent on the SSE wire.
            if (res.ok && res.result && typeof res.result === "object") {
              const r = res.result as Record<string, unknown>;
              if (typeof r.downloadUrl === "string" && r.downloadUrl.length > 0) {
                controller.enqueue(
                  sseEvent({
                    type: "download",
                    toolName: tu.name,
                    downloadUrl: r.downloadUrl,
                    filename:
                      typeof r.filename === "string" ? r.filename : "export",
                    byteSize: typeof r.byteSize === "number" ? r.byteSize : 0,
                    rowCount: typeof r.rowCount === "number" ? r.rowCount : 0,
                    contentType:
                      typeof r.contentType === "string" ? r.contentType : "",
                    expiresInSeconds:
                      typeof r.expiresInSeconds === "number"
                        ? r.expiresInSeconds
                        : 3600,
                  }),
                );
              }
            }
            controller.enqueue(
              sseEvent({ type: "tool_call_end", name: tu.name }),
            );
          }
          messages.push({ role: "user", content: toolResultBlocks });
        }

        if (iteration >= MAX_ITERATIONS) {
          // The model exhausted its tool-call budget without producing a
          // final text turn — emit a graceful synthetic answer instead of
          // an error event (which leaves the UI with empty text).
          controller.enqueue(
            sseEvent({
              type: "text",
              value:
                "I tried multiple lookups but couldn't piece together a clean answer. Could you rephrase or give me a more specific identifier (e.g. SO-2605-303, INV-2605-099, DO-2605-097)?",
            }),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseEvent({ type: "error", message: msg }));
      } finally {
        if (parsedAttachments.length > 0) {
          dropAttachments(requestId);
        }
        controller.enqueue(sseEvent({ type: "done" }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});

export default app;
