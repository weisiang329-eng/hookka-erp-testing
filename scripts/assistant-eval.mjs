// ---------------------------------------------------------------------------
// scripts/assistant-eval.mjs — offline "does the AI pick the right tool?" eval.
//
// WHAT THIS IS (and is NOT):
//   This does NOT train or change the model. The model is fixed. Hookka AI's
//   only "memory" is the SYSTEM_PROMPT text in src/api/routes/assistant.ts,
//   re-sent on every call. This harness is a TEST: it feeds the model the
//   EXACT same manual + tool list the live assistant ships, asks it a bank of
//   realistic operator questions, and inspects the AI's FIRST move — did it
//   call the right tool, or did it wrongly ask a clarifying question back /
//   pick the wrong tool? Wherever it fails, the fix is to edit the
//   SYSTEM_PROMPT and re-run until it passes.
//
//   Tools are NOT executed — no DB, no auth, no deployment. One API call per
//   question. Prompt caching makes the shared ~25K-token prefix (manual +
//   tool list) cheap across the whole bank, so a full run is a few US cents.
//
// PRE-REQ:
//   The Anthropic key is read from your OWN environment — never stored here.
//     PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."
//     bash/zsh:    export ANTHROPIC_API_KEY="sk-ant-..."
//
// RUN (from the worktree root):
//   node --import tsx/esm scripts/assistant-eval.mjs            # full bank
//   node --import tsx/esm scripts/assistant-eval.mjs --list     # no API, print bank only
//   node --import tsx/esm scripts/assistant-eval.mjs --limit 10 # first 10 questions
//   node --import tsx/esm scripts/assistant-eval.mjs --module Finance
//   node --import tsx/esm scripts/assistant-eval.mjs --verbose  # show model text on failures
// ---------------------------------------------------------------------------
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

// Let tsx strip types so we can import the live .ts modules. Guarded because
// `node --import tsx/esm` may have already registered it.
try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Already registered (or native type-stripping) — fine.
}

// Import the EXACT manual + tool list the live route ships. If these imports
// ever break, the eval is no longer faithful — fix the import, don't fake it.
const { SYSTEM_PROMPT } = await import("../src/api/routes/assistant.ts");
const { getToolSchemas } = await import("../src/api/lib/assistant-tools.ts");

// Keep in sync with MODEL in src/api/routes/assistant.ts (not exported there
// to avoid widening the route's public surface — it changes ~once a year).
const MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// We only need the model's FIRST move, so a small cap keeps cost + latency low.
const MAX_TOKENS = 1024;
const CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Question bank.
//
// Each entry:
//   q       — the operator's message, verbatim in their real mix of
//             English / Chinese / Malay shorthand (this is TEST DATA, not UI
//             copy — multilingual input is the whole point of the routing test).
//   module  — which Hookka area it exercises (drives the per-module report).
//   accept  — the set of tool names that count as a correct FIRST call. More
//             than one when the manual genuinely allows several (e.g. an
//             invoice number could go to get_invoice OR trace_order OR
//             smart_lookup). Omit for `mustAct`-only checks.
//   mustAct — true: any tool call passes; the failure we care about is the AI
//             asking a clarifying question instead of just looking it up.
//   expectAsk — true: the input is genuinely unanswerable, so asking back
//             (no tool call) is the CORRECT behaviour. Guards against
//             over-correcting into a bot that never clarifies.
//   why     — short note on the expected routing (for the failure report).
// ---------------------------------------------------------------------------
const BANK = [
  // ---- Sales / SO --------------------------------------------------------
  {
    q: "SO-2605-253 现在到哪个阶段了？",
    module: "Sales",
    accept: ["trace_order"],
    why: "status/stage of one document -> trace_order",
  },
  {
    q: "which sales orders still missing info? 资料不齐的单有哪些",
    module: "Sales",
    accept: ["get_so_missing_data"],
    why: "incomplete orders -> get_so_missing_data",
  },
  {
    q: "list all confirmed sales orders this month",
    module: "Sales",
    accept: ["list_sales_orders"],
    why: "browse/filter many SOs -> list_sales_orders",
  },
  {
    q: "Houzs 这个客户的所有资料给我看一下",
    module: "Customers",
    accept: ["get_customer_360", "smart_lookup"],
    why: "everything about one customer -> get_customer_360",
  },

  // ---- Consignment -------------------------------------------------------
  {
    q: "寄卖单有哪些 还没结的",
    module: "Consignment",
    accept: ["list_consignment_orders"],
    why: "browse consignment orders -> list_consignment_orders",
  },

  // ---- Production --------------------------------------------------------
  {
    q: "现在有哪些生产单还没做完",
    module: "Production",
    accept: ["list_production_orders"],
    why: "browse open production orders -> list_production_orders",
  },
  {
    q: "PO-2605-009 的 job card 做到哪里了",
    module: "Production",
    accept: ["trace_order", "list_job_cards", "get_production_order"],
    why: "job-card progress of one PO -> trace_order / list_job_cards / get_production_order",
  },
  {
    q: "为什么 PO-2605-009 delay 这么久 卡在哪里",
    module: "Production",
    accept: ["analyze_po_delay"],
    why: "why is a PO late / bottleneck -> analyze_po_delay",
  },
  {
    q: "现在各部门 WIP 在制品有多少",
    module: "Production",
    accept: ["get_wip_snapshot"],
    why: "WIP per department -> get_wip_snapshot",
  },
  {
    q: "下个礼拜五的产能够不够 排得满吗",
    module: "Production",
    accept: ["get_capacity_loading"],
    why: "how loaded is a day -> get_capacity_loading",
  },

  // ---- Delivery / Packing ------------------------------------------------
  {
    q: "今天出了多少货 各个 hub 的情况",
    module: "Delivery",
    accept: ["get_dispatch_summary"],
    why: "what shipped today per hub -> get_dispatch_summary",
  },
  {
    q: "list delivery orders this week",
    module: "Delivery",
    accept: ["list_delivery_orders"],
    why: "browse DOs -> list_delivery_orders",
  },
  {
    q: "今天有哪些 packing list",
    module: "Delivery",
    accept: ["list_packing_lists"],
    why: "browse packing lists -> list_packing_lists",
  },

  // ---- Finance -----------------------------------------------------------
  {
    q: "谁还欠我钱 outstanding 还没收的",
    module: "Finance",
    accept: ["get_ar_outstanding"],
    why: "who owes / outstanding receivables -> get_ar_outstanding",
  },
  {
    q: "这个月毛利多少 GP by product",
    module: "Finance",
    accept: ["get_gp_analysis"],
    why: "profit/margin/GP -> get_gp_analysis",
  },
  {
    q: "还没付钱的 invoice 有哪些",
    module: "Finance",
    accept: ["list_invoices", "get_ar_outstanding"],
    why: "haven't paid -> unpaid invoices / AR",
  },
  {
    q: "INV-2605-099 这张 invoice 的详情",
    module: "Finance",
    accept: ["get_invoice", "trace_order", "smart_lookup"],
    why: "one invoice's detail -> get_invoice / trace_order / smart_lookup",
  },
  {
    q: "最近收到的 payment 有哪些",
    module: "Finance",
    accept: ["list_payments"],
    why: "recent payments -> list_payments",
  },
  {
    q: "berapa banyak hutang customer setakat ni",
    module: "Finance",
    accept: ["get_ar_outstanding"],
    why: "Malay: how much customer debt -> get_ar_outstanding",
  },

  // ---- Inventory / Catalog ----------------------------------------------
  {
    q: "foam 还剩多少 泡棉库存",
    module: "Inventory",
    accept: ["list_foam_inventory"],
    why: "foam stock (tracked as WIP) -> list_foam_inventory",
  },
  {
    q: "成品仓有什么 ready to ship 的 units",
    module: "Inventory",
    accept: ["list_fg_units"],
    why: "finished goods ready to ship -> list_fg_units",
  },
  {
    q: "什么布需要补货了 够不够用",
    module: "Inventory",
    accept: ["predict_reorder_needs"],
    why: "what fabric needs reordering -> predict_reorder_needs",
  },
  {
    q: "list 一下我们有什么布",
    module: "Inventory",
    accept: ["list_fabrics"],
    why: "browse fabrics -> list_fabrics",
  },
  {
    q: "产品 1003 的用料表 BOM",
    module: "Inventory",
    accept: ["get_bom", "get_product_360", "get_product", "smart_lookup"],
    why: "one product's BOM -> get_bom / get_product_360",
  },
  {
    q: "哪些产品有用到 BO315 这个布",
    module: "Inventory",
    accept: ["find_products_using_fabric"],
    why: "which products use a fabric -> find_products_using_fabric",
  },
  {
    q: "产品 1003 整体情况 库存用料还有用在哪些单",
    module: "Inventory",
    accept: ["get_product_360", "smart_lookup"],
    why: "everything about one product -> get_product_360",
  },
  {
    q: "五金配件 accessories 库存还有多少",
    module: "Inventory",
    accept: ["list_accessories"],
    why: "accessories stock -> list_accessories",
  },
  {
    q: "stok kain ada lagi tak cukup ke tak",
    module: "Inventory",
    accept: ["predict_reorder_needs", "list_fabrics"],
    why: "Malay: enough fabric stock -> predict_reorder_needs / list_fabrics",
  },

  // ---- People / HR -------------------------------------------------------
  {
    q: "zaw lin 上礼拜的 performance 怎样",
    module: "People",
    accept: ["find_employee"],
    why: "named person's recent work -> find_employee (resolves AND returns perf)",
  },
  {
    q: "sewing 部门这个月的效率",
    module: "People",
    accept: ["get_department_efficiency"],
    why: "a whole department's efficiency -> get_department_efficiency",
  },
  {
    q: "这个月的 payroll 工资单",
    module: "People",
    accept: ["get_payroll"],
    why: "payroll -> get_payroll",
  },

  // ---- Customers / Suppliers --------------------------------------------
  {
    q: "list 所有 supplier",
    module: "Customers",
    accept: ["list_suppliers"],
    why: "browse suppliers -> list_suppliers",
  },
  {
    q: "Carress 这个客户欠多少 + 之前的单",
    module: "Customers",
    accept: ["get_customer_360", "get_ar_outstanding", "smart_lookup"],
    why: "one customer's AR + history -> get_customer_360",
  },

  // ---- Overview / cross-module ------------------------------------------
  {
    q: "今个月生意怎样 overall 的数字",
    module: "Overview",
    accept: ["get_dashboard_kpis", "get_dashboard_stats"],
    why: "month overview/KPIs -> get_dashboard_kpis",
  },
  {
    q: "有哪些 order 迟了 全部 overdue 的",
    module: "Overview",
    accept: ["list_overdue_orders"],
    why: "what's overdue -> list_overdue_orders",
  },
  {
    q: "有没有不正常的 order 奇怪的 GP",
    module: "Overview",
    accept: ["get_abnormal_orders"],
    why: "anything abnormal -> get_abnormal_orders",
  },
  {
    q: "最近谁改了 SO-2605-253",
    module: "Overview",
    accept: ["list_audit_events", "trace_order"],
    why: "who changed what -> list_audit_events",
  },
  {
    q: "今天的 daily report 给我",
    module: "Overview",
    accept: ["get_daily_report"],
    why: "today's daily report -> get_daily_report",
  },

  // ---- Find anything fuzzy ----------------------------------------------
  {
    q: "PO9003",
    module: "Fuzzy",
    accept: ["smart_lookup", "lookup_customer_po"],
    why: "bare Houzs customer-PO shorthand -> smart_lookup / lookup_customer_po",
  },
  {
    q: "9003",
    module: "Fuzzy",
    accept: ["smart_lookup", "lookup_customer_po"],
    why: "bare number -> smart_lookup (look up first, don't ask)",
  },
  {
    q: "帮我找一下 zaw lin",
    module: "Fuzzy",
    accept: ["find_employee", "smart_lookup"],
    why: "bare name -> find_employee / smart_lookup, not a clarifying question",
  },
  {
    q: "Carress",
    module: "Fuzzy",
    accept: ["smart_lookup", "get_customer_360", "list_customers"],
    why: "bare customer name -> smart_lookup, don't ask 'what about Carress?'",
  },

  // ---- How-to ------------------------------------------------------------
  {
    q: "怎样开一张 delivery order",
    module: "HowTo",
    accept: ["explain_feature"],
    why: "how do I do X -> explain_feature",
  },
  {
    q: "where do I change a worker's salary in the system",
    module: "HowTo",
    accept: ["explain_feature"],
    why: "how-to / where is X -> explain_feature",
  },

  // ---- Genuinely ambiguous (asking back is CORRECT) ---------------------
  {
    q: "帮我搞一下那个东西",
    module: "Ambiguous",
    expectAsk: true,
    why: "truly contentless -> asking what they mean is correct, not a tool call",
  },
];

// ---------------------------------------------------------------------------
// Prompt caching — the system prompt + tool list are byte-identical across
// every question, so one cache entry serves the whole bank. Mirror the live
// route: ephemeral breakpoint on the LAST tool and on the system text block.
// ---------------------------------------------------------------------------
function buildCachedPrefix() {
  const tools = getToolSchemas();
  const cachedTools =
    tools.length > 0
      ? [
          ...tools.slice(0, -1),
          { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } },
        ]
      : tools;
  const cachedSystem = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  return { cachedTools, cachedSystem };
}

// ---------------------------------------------------------------------------
// Ask the model for ONE question; return its first move.
// ---------------------------------------------------------------------------
async function askModel(apiKey, prefix, userText) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: prefix.cachedSystem,
    tools: prefix.cachedTools,
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userText }],
  };

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = `network: ${err?.message ?? String(err)}`;
      await sleep(800 * (attempt + 1));
      continue;
    }

    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${t.slice(0, 300)}` };
    }

    const data = await res.json();
    const blocks = Array.isArray(data.content) ? data.content : [];
    const firstToolBlock = blocks.find((b) => b?.type === "tool_use");
    const textParts = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    return {
      firstTool: firstToolBlock ? firstToolBlock.name : null,
      stopReason: data.stop_reason ?? null,
      text: textParts.join(" ").trim(),
    };
  }
  return { error: lastErr || "unknown error" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Resolve the Anthropic key WITHOUT ever printing it. Order:
//   1. process.env.ANTHROPIC_API_KEY (your shell)
//   2. a local .dev.vars file (the same wrangler-style secrets file local dev
//      uses) in the worktree or the main repo root.
// The value is read straight into the API call — it is never logged.
// ---------------------------------------------------------------------------
function resolveApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const candidates = [
    ".dev.vars",
    "../../../.dev.vars",
    "C:/Users/User/hookka-erp-testing/.dev.vars",
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith("ANTHROPIC_API_KEY=")) continue;
        let v = line.slice("ANTHROPIC_API_KEY=".length).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v) return v;
      }
    } catch {
      // Unreadable file — fall through to the next candidate.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Score one result against its bank entry.
// ---------------------------------------------------------------------------
function score(entry, result) {
  if (result.error) {
    return { pass: false, kind: "error", detail: result.error };
  }
  const acted = result.firstTool !== null;

  if (entry.expectAsk) {
    // Correct behaviour is to ask (no tool call).
    return acted
      ? {
          pass: false,
          kind: "should-have-asked",
          detail: `called ${result.firstTool} on a contentless request`,
        }
      : { pass: true, kind: "asked-correctly", detail: snippet(result.text) };
  }

  // Action expected.
  if (!acted) {
    return {
      pass: false,
      kind: "over-asked",
      detail: snippet(result.text) || "(no tool, no text)",
    };
  }
  if (entry.mustAct && !entry.accept) {
    return { pass: true, kind: "acted", detail: result.firstTool };
  }
  if (entry.accept && entry.accept.includes(result.firstTool)) {
    return { pass: true, kind: "right-tool", detail: result.firstTool };
  }
  return {
    pass: false,
    kind: "wrong-tool",
    detail: `got ${result.firstTool}, wanted one of [${(entry.accept || []).join(", ")}]`,
  };
}

function snippet(s) {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 117) + "..." : one;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency runner.
// ---------------------------------------------------------------------------
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function drain() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    runners.push(drain());
  }
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { list: false, verbose: false, limit: 0, module: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--module") out.module = argv[++i] || null;
  }
  return out;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let bank = BANK;
  if (args.module) {
    const m = args.module.toLowerCase();
    bank = bank.filter((e) => e.module.toLowerCase() === m);
  }
  if (args.limit > 0) bank = bank.slice(0, args.limit);

  console.log(
    `Hookka AI routing eval — ${bank.length} question(s), model ${MODEL}`,
  );
  console.log(
    `System prompt: ${SYSTEM_PROMPT.length} chars · tools: ${getToolSchemas().length}`,
  );
  console.log("");

  if (args.list) {
    for (const e of bank) {
      const expect = e.expectAsk
        ? "(should ask back)"
        : e.accept
          ? `[${e.accept.join(", ")}]`
          : "(any tool)";
      console.log(`  ${pad(e.module, 12)} ${expect}`);
      console.log(`               "${e.q}"`);
    }
    console.log("\n--list: no API calls made.");
    return;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      "ERROR: no Anthropic key found.\n" +
        "  Option 1 — put it in your shell:\n" +
        '    PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."\n' +
        '    bash/zsh:    export ANTHROPIC_API_KEY="sk-ant-..."\n' +
        "  Option 2 — add a line to a .dev.vars file in the repo root:\n" +
        "    ANTHROPIC_API_KEY=sk-ant-...\n" +
        "Then re-run. (The key stays on your machine — this script never logs or stores it.)",
    );
    process.exit(1);
  }

  const prefix = buildCachedPrefix();
  const t0 = Date.now();

  const scored = await runPool(bank, CONCURRENCY, async (entry) => {
    const result = await askModel(apiKey, prefix, entry.q);
    return { entry, result, verdict: score(entry, result) };
  });

  // ---- Report ----------------------------------------------------------
  const failures = [];
  const byModule = new Map();
  for (const s of scored) {
    const mod = s.entry.module;
    if (!byModule.has(mod)) byModule.set(mod, { pass: 0, total: 0 });
    const m = byModule.get(mod);
    m.total++;
    if (s.verdict.pass) m.pass++;
    else failures.push(s);
  }

  console.log("Per-module:");
  for (const [mod, m] of [...byModule.entries()].sort()) {
    const ok = m.pass === m.total ? "OK " : "  X";
    console.log(`  ${ok} ${pad(mod, 12)} ${m.pass}/${m.total}`);
  }

  const total = scored.length;
  const passed = scored.filter((s) => s.verdict.pass).length;
  const pct = total ? Math.round((passed / total) * 100) : 0;
  console.log("");
  console.log(`Overall: ${passed}/${total} (${pct}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  [${f.entry.module}] (${f.verdict.kind}) "${f.entry.q}"`);
      console.log(`      want: ${f.entry.why}`);
      console.log(`      got:  ${f.verdict.detail}`);
      if (args.verbose && f.result.text) {
        console.log(`      text: ${snippet(f.result.text)}`);
      }
    }
  } else {
    console.log("\nAll questions passed. The manual routes every probed intent correctly.");
  }

  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err) => {
  console.error("Eval crashed:", err);
  process.exit(1);
});
