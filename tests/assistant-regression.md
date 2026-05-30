# Hookka AI Assistant — Regression Test Plan

Run these 10 queries against prod `/api/assistant/chat` (POST, SSE stream)
after every change to `src/api/lib/assistant-tools.ts` or the assistant
route. Auth: must be a logged-in SUPER_ADMIN session (browser cookie).

For each query, record:
- `total_ms`: wall-clock time from request start to `done` event.
- `tool_count`: number of `tool_call_start` events fired.
- `tool_names`: list of tool names that fired (in order).
- `text_length`: total length of `text` deltas concatenated.
- `text_first_300`: first 300 chars of the final answer text.
- `error_event_fired`: `true` if any `error` SSE event came back.

## Pass criteria

The fix that landed in `fix(assistant): root-cause get_sales_order silent-null + sibling lookup tools` should:
- Reduce average `tool_count` from 6 (cascade-loop budget exhausted) back to 1-3 per query.
- Eliminate "I couldn't piece together a clean answer" synthetic replies on lookup queries.
- Keep `get_bom` (Q3), `get_sales_order` (Q1/Q2), `trace_order` (Q7) all returning real data.

---

## Q1. `Check SO-2605-303`
- Expected tool: `get_sales_order` × 1
- Expected: 3-6 seconds, customer is **Carress**, status reported, line items listed.
- Regression: previously returned "couldn't piece together" after 6-tool cascade.

## Q2. `Check so-4e5f8592`
- Same SO as Q1, looked up by internal id instead of visible code.
- Expected tool: `get_sales_order` × 1
- Expected: identical SO data to Q1.

## Q3. `Show me BOM for 1003-(K)`
- Expected tool: `get_bom` × 1
- Expected: full BOM markdown table with WIP components.
- Sanity check — already verified working post-1578cda8.

## Q4. `What did Carress order recently? Top 3.`
- Expected tool: `list_sales_orders` × 1 with `customer="carress", limit=3`.
- Expected: markdown table with 3 most recent Carress SOs (SO-code, date, status, RM).

## Q5. `Top 5 customers by revenue this month`
- Expected tool: `get_dashboard_kpis` × 1 (which has `top5Customers`).
- Acceptable alternative: `run_select_query` if the model picks ad-hoc SQL.
- Expected: 5-row table sorted by revenue, current month range.

## Q6. `How do I create a sales order?`
- Expected tool: `explain_feature` × 1 with `featureName="create sales order"`.
- Expected: step-by-step instructions citing sidebar location.

## Q7. `How is SO-2605-303 doing?`
- Expected tool: `trace_order` × 1 (type=SO, id=SO-2605-303). Optionally followed by `analyze_po_delay` if PO appears stuck.
- Expected: cascade summary (SO → POs → DOs → invoices → payments) with a 1-2 sentence recommendation at the end.
- Regression: previously crashed on the invoiceNumber column inside trace_order — now uses invoiceNo.

## Q8. `Check SO 2505 300` (wrong format, possibly wrong year)
- Expected behaviour:
  - AI normalises to `SO-2505-300` per the identifier-formats system prompt, calls `get_sales_order`.
  - OR asks "Did you mean SO-2605-300 (May 2026) or SO-2505-300 (May 2025)?" before searching.
- Must NOT loop (≤2 tool calls).

## Q9. `Check SO-9999-999` (definitely doesn't exist)
- Expected tool: `get_sales_order` × 1 returns not-found.
- Expected: ≤6 seconds, AI says "I couldn't find SO-9999-999. Could you double-check the number?" and STOPS.
- Regression: previously cascaded through trace_order → search_anything → run_select_query and exhausted budget. The stopping rule in the system prompt + lowered MAX_ITERATIONS=6 should keep this clean.

## Q10. `Anything I should worry about today?`
- Expected tool: `get_dashboard_kpis` × 1 OR `list_overdue_orders` × 1-2 (for SO/PO/DO/INVOICE).
- Expected: data summary + recommendation (e.g. "8 SOs are overdue this week — focus on Dept SEW backlog").

---

## How to run

The parent session can:

1. Be logged into prod as SUPER_ADMIN via Chrome.
2. Open browser devtools → Console.
3. Paste and execute the script in `assistant-regression.run.js` (TODO — not yet written).

OR, simpler: use the in-app chat panel (slide-over) and just type each
query one at a time, watching the tool-call indicators and timing.

## Known limitations

- `get_dashboard_kpis` on-time % was previously self-comparing the deliveryDate
  column (snake/camel rewrite collision). Fix applied: now compares
  `SUBSTR(deliveredAt,1,10) <= deliveryDate`. Verify the % is sane (typically
  60-90%) — if every-row counts as on-time, the fix didn't deploy.
- `payment_records.orgId` column existence is assumed based on prod usage in
  `routes/payments.ts`. If `get_customer_360` fails with "column org_id does
  not exist", revisit the lastPayment query.
