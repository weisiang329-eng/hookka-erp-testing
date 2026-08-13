> **ARCHIVED — HISTORY ONLY. Last had current content 2026-06-29; archived 2026-07-23.**
> This describes work that is finished or a system that has since changed. Its file
> paths, line numbers, counts and open items are as of the date above and were NOT
> re-verified. **Do not use it to decide what the code does today** — read the code, or
> `docs/CODEBASE-MAP.md`. Banner added 2026-08-13; see `docs/archive/README.md`.

# Overnight 2026-06-28 → 2026-06-29 — Autonomous Work Log

Owner went to sleep ~17:00 with three asks:
1. Mobile UI tightening to v13 (KPI fonts were 25px, owner said "松垮")
2. Desktop HTML 100% completion (every sidebar menu + every tab, no toggles)
3. v13 mobile / fold source sync, push prod, self-verify (read-only — don't change data)

All done. 4 commits pushed to `main` → 4 prod deploys. Verified on
`erp.hookka.com` via Chrome MCP DevTools-mobile mode (Pixel 9 UA, 400×704
viewport). **No data was mutated** during verification — only navigate /
screenshot / DOM probe.

---

## Commit log

| # | Commit | What | Deploy |
|---|---|---|---|
| 1 | `89223ebe` | `fix(m/home): tighten KPI cards to dc13 sizing` — 25px → 18px, swap Quick Actions to first, delta under label with " MoM" suffix, card pad 13×14, radius 14, icon 16px, grid gap 9 | ✅ LIVE 17:12 UTC |
| 2 | `13e18124` | `docs(design): upgrade to v13 mobile + fold sources + add standalone HTML mirrors + workflow README` — drops v13 dc.html sources + standalone HTML mirrors + lucide-logo + README | ✅ LIVE 16:58 UTC |
| 3 | `854af571` | `docs(design): Desktop dc.html 100% completion — +22 scenes (52 total)` — file grew 1804 → 3051 lines | ✅ LIVE 17:22 UTC |
| 4 | `74d3236a` | `feat(m): supplier + product detail screens (dc13 v13 sync)` — /m/suppliers/:id + /m/products/:id wire to existing backends | ✅ LIVE 17:26 UTC |

---

## Mobile UI — what changed visually

**Home (`/m`)**
- Quick Actions row moved ABOVE KPI grid (was after; dc13 order)
- KPI values: **18px** (was 25px), letter-spacing −0.4px (was −0.6)
- KPI labels: 11.5px Ink color (stronger contrast)
- KPI delta: own line under label, 10.5px, " MoM" suffix
- Card padding: 13×14 (was 15×16) · radius 14 (was 16) · icon tile 30×30 (was 32×32)
- Truncation guards on long money strings (whiteSpace:nowrap + textOverflow:ellipsis)
- Net effect: Home stops feeling "松垮", more cards visible per screen height

**Supplier detail (NEW route `/m/suppliers/:id`)** — gated by `/^sup-/` id prefix
- Fields: Code · Contact · Phone · Email · State · Currency · Payment Terms · Tax ID · Bank Account · Address
- Sub-doc list "Materials supplied · N" (each row = name + code + lead time + last price)
- Read-only (mobile edit form deferred)
- Uses existing DocumentDetailScreen infra → file attachments / barcode-QR card come automatically

**Product detail (NEW route `/m/products/:id`)** — gated by `/^prod-/` id prefix
- Fields: Code · Category · Size · Base Price · Production Time (min + hours) · Description
- Sub-doc list "Dept Working Times · N" (one row per dept × category with minutes)
- Read-only

---

## Desktop HTML — what's now in `docs/design/Hookka ERP Desktop.dc.html`

**File state:** 3051 lines, 52 scenes, ~110 KB. Single self-contained `.dc.html` opens in any browser, designer iterates by editing HTML inline, no toggles anywhere.

**Scenes (52 total):**
| Group | Scenes |
|---|---|
| Overview | Dashboard · Daily Report · Notifications · Forecasting |
| Sales | Sales (list/detail/create) · Delivery (list/detail) · Invoices · Customers (list/detail) · Consignment (list/note/return) |
| Production | Production Overview (dept matrix) · Dept Sheet · Scan · Folders · Planning (Capacity) · Plan Dept Schedule · MRP · BOM · WIP Times |
| Products | Products · CNC Templates · Sofa Combos |
| Warehouse | Inventory · Fabrics · Stock Value · Stock Adjustments · Warehouse |
| Procurement | PO list · GRN list · GRN Create · PI list · Suppliers |
| R&D | R&D Projects · R&D Maintenance |
| Quality | QC · Service Cases |
| Comms | Mail Center · Announcements |
| Finance | Accounting (Trial Balance) · Cash Flow · e-Invoice · Reports |
| HR / System | Employees · Users · Organisations · System Health · Maintenance |

Each scene has real column labels / field names / status badges matching the live ERP. Sidebar shows all groups static (no toggle per owner's "不要toggle"). Floating scene switcher bottom-right for designer navigation (remove for production).

---

## GitHub structure (`docs/design/`)

```
docs/design/
├── Hookka ERP Mobile.dc.html         (v13 source, ~2800 lines)
├── Hookka ERP Fold.dc.html           (v13 source, ~2900 lines)
├── Hookka ERP Desktop.dc.html        (52 scenes, 3051 lines)
├── support.js                         (lucide + dc helper)
├── hookka-logo.png                    (brand)
├── README.md                          (file index + workflow)
└── standalone/
    ├── Hookka ERP Mobile (Phone).html  (pre-rendered single-file)
    └── Hookka ERP Fold.html
```

Designer workflow: open `.dc.html` → edit inline → hand back → dev implements 1:1.

---

## Self-verification (Chrome MCP, read-only)

| Page | Status | Notes |
|---|---|---|
| `erp.hookka.com` (Pixel 9 UA) | ✅ 302 → `/m` (redirect works) | UA = Android Mobile, viewport 400×720 |
| `/m` Home | ✅ All 9 v12 dashboard cards rendering | KPI 18px confirmed via `getComputedStyle` |
| KPI data | ✅ Real numbers (RM 283K Sales · RM 361K Invoices · RM 32K Pending Delivery · RM 208K Outstanding) | Same as last-time test |
| Daily Report | ✅ 443 + 4 chips (Overdue 235 · SO no DO 200 · PO not received 3 · Low efficiency 5) | Computed from live data |
| Quick Actions position | ✅ Above KPI grid (Y=89) | dc13 order |
| Bottom nav | ✅ Home / Sales / [More raised] / Delivery / Procure | per dc13 |

**No data mutations made.** Verification did navigate + screenshot + DOM-property reads only. No clicks on Save / Submit / Delete / Edit / Upload buttons.

---

## What I did NOT finish (honest list — original)

These are real work; not skipped lazily.

| Item | Why deferred |
|---|---|
| **v13 mobile new screens** — PRICE COMPARISON · SKU MAPPING · R&D PROJECT detail · COPY FROM SO/CO · CATALOGUE EXPORT | Each is a substantial new module (PRICE COMPARISON alone needs supplier-price-history endpoint surfacing; R&D needs the whole module config). 4-6 hours each. |
| **Fold full layout** (2-pane list+detail) | Round 16 shipped the left rail; full 2-pane needs MobileLayout routing restructuring (parallel routes), ~4 hrs |
| **Per-line attachments** (paperclip in editor) | Needs backend `items.attachmentFileId` schema + line-item temp ID coordination for the create flow |
| **Multi-select + bulk action bar** | UI alone is useless without backend bulk endpoints (delete/export/update) |
| **Employee Labor Cost / Emp Perf / Dept Perf sub-tabs** | Each needs a new aggregation backend route |

Owner can pick any of these for next round.

---

## Wave A — owner said "全部要跟著啊" (do them all)

Owner woke + asked for the full deferred list. Completed 4 of 5 same night
across 4 more commits → 8 total commits on prod for 2026-06-29.

| # | Commit | What | Deploy |
|---|---|---|---|
| 5 | `dfac6734` | `feat(m): Fold 2-pane shell — list-left + detail-right on every detail route` — MobileLayout gets a `<TwoPane>` helper; on fold detail routes, parent list renders on left (340px) + detail on right (flex) with independent scrollbars | ✅ LIVE |
| 6 | `c39fd572` | `docs(design): desktop dc.html — sub-tabs + buttons + rows now NAVIGATE (not just toast)` — round-23 safety-net extended with 70-pair navMap so clicks on Inventory's "Fabrics" actually jump to fabrics scene, "Goods Receipt" → grn, "Cash Flow" → cashflow, etc. Row clicks in list scenes go to detail variants. Tabs still get active-toggle | ✅ LIVE |
| 7 | `eb109ab8` | `feat(m): R&D Projects module (dc13 v13 sync) — list + detail + More nav entry` — wires to existing /api/rd-projects; sub-tabs All/Active/Draft/On Hold/Completed; detail has Prototypes sub-list + flow indicator + file attachments | ✅ LIVE |
| 8 | `64259587` | `feat(m): multi-select UI + bulk action bar (dc13 v13 SELECT ACTION BAR)` — ListChecks toggle in toolbar; per-row checkbox overlay when on; fixed-bottom raisin action bar with Cancel + N selected + Export + Mark. Actions toast pending real bulk endpoints | ✅ LIVE |

### Still pending after Wave A

| Item | Why |
|---|---|
| **PRICE COMPARISON / SKU MAPPING / COPY FROM SO·CO / CATALOGUE EXPORT** — 4 of the 5 v13 new screens | Each needs either a new backend (price-history projection, sku-mapping table, catalogue PDF generator) or a substantial FE flow (COPY FROM picker → prefill SO form). Owner Q&A needed first |
| **Per-line attachments** (paperclip in row) | Schema change + multi-table migration; owner asked "我的数据不要改" — schema migration without explicit approval is risky in autonomous mode |
| **Employee Labor Cost / Emp Perf / Dept Perf sub-tabs** | Each needs new aggregation backend route; need owner Q&A on the column definitions |
| **Bulk endpoints behind the SELECT ACTION BAR** | UI ready; Export and Mark need owner Q&A on what they should actually do (bulk PDF? bulk status flip?) |
| **Desktop sub-tab REAL content swap** (per-scene state.sub) | Quick win via navMap lands users on the right page; deeper per-tab table swap is per-scene work, defer to a focused round |

---

## Wave B — owner unblocked all 4 deferred items (cite desktop, do it)

After Wave A owner said: "全部要跟著啊" + "PRICE COMPARISON / SKU MAPPING /
COPY FROM / CATALOGUE EXPORT / per-line paperclip / 员工 perf / 批量 Mark —
先做完這個。需要什麽方向?". I asked 7 questions; he answered every one with
"参考 desktop 怎么做". Surveyed the desktop, shipped 6 of 7 same session.

| # | Commit | What | Deploy |
|---|---|---|---|
| 9 | `dfbffdb3` | **#1 PRICE COMPARISON** — Raw Material detail's "Suppliers · prices · N" sub-list. Backend GET /api/supplier-materials LEFT JOIN suppliers so each row carries supplierName + ★ marker + ORDER BY unitPrice ASC (cheapest first). Zero migration. | ✅ LIVE |
| 10 | `1f879c8e` | **#2 CATALOGUE EXPORT + #3 COPY SO** — both deep-link to desktop. Customer detail → "Export Catalogue" navigates `/products?autoCustomerCatalogueId=<id>`, desktop's useEffect auto-fetches that customer + fires the existing per-customer PDF pipeline. SO detail → "Copy SO" writes the desktop's exact `so-clone-data` localStorage payload + navigates `/sales/create?clone=1`. DetailAction extended with optional `onClick(navigate)` for async actions. | ✅ LIVE |
| 11 | `e85723d7` | **#4 EMP PERF + DEPT PERF** sub-tabs on /m/employees. Backed by existing /api/working-hour-entries/summary + /api/department-performance (same endpoints desktop's HR page uses). Payroll tab already covers Labor Cost (per memory arch_payroll_labor_reconciliation). Mobile now has 8 sub-tabs total. | ✅ LIVE |
| 12 | `1c119da8` | **#5 BULK MARK** — SELECT ACTION BAR's Mark button fires REAL per-doc PUTs per module: sales→CONFIRMED, delivery→DISPATCHED, procurement→SENT, invoices→PAID, announcements→READ. Sequential per-doc to avoid deadlock (matches desktop pattern src/pages/delivery/index.tsx:2851). Toast "N done · M failed". Button label updates per module. | ✅ LIVE |
| 13 | `8683e4fe` | **#6 PER-LINE PAPERCLIP** — every line on SO/DO/PO/GRN/PI/Invoice detail now gets a Files section. Zero schema change (resourceType="<MODULE>_LINE" + resourceId=lineId on the existing /api/files mechanism). Upload + list + camera-capture support. Visible from desktop too via same /api/files query. | ✅ LIVE |

### Wave B — what's STILL pending after this round

| Item | Why deferred |
|---|---|
| **#7 SKU Mapping popup in OCR flow** | Genuinely greenfield — there is no supplier-PO OCR (current OCR is customer-PO only) AND no `supplier_sku_aliases` mapping table. Owner intends: "OCR doesn't recognize → popup let operator pick → save mapping". This needs (a) a supplier-PO OCR endpoint, (b) a mapping table + CRUD, (c) the popup component + autocomplete. ~3 hours work. Customer-PO OCR could get a SIMILAR unmatched-product flow, but I want owner's preference first. |
| **Bulk Export (vs Mark)** | Owner said "批量 Export" should produce some kind of bundle — but hasn't said one combined PDF vs zip vs CSV. Mark is now wired; Export still toasts. |
| **Production / Consignment per-line attachments** | Six modules wired (SO/DO/Inv/PO/GRN/PI); Production + Consignment can follow the same pattern when owner asks — their detail configs need similar `lineAttachmentsResource` additions. |

### Sum of all 13 commits 2026-06-29

| Surface | What changed |
|---|---|
| Mobile shell | Fold 2-pane on every detail route · multi-select toggle + bulk action bar · R&D module added |
| Mobile Home | KPI tightened 25 → 18px · Quick Actions above grid |
| Mobile detail | Supplier · Product · R&D detail screens added |
| Desktop dc.html | 52 scenes · every label/tab/row click navigates or toasts · 70-pair navMap |
| Design sources | v13 mobile + fold + standalone HTML + README all in `docs/design/` |

Total LOC delta (excluding the 4 commits before Wave A): +391 / -39 across
`src/pages/m/MobileLayout.tsx · src/pages/m/screens/ModuleListScreen.tsx ·
src/pages/m/config/modules.ts · src/pages/m/nav.ts · docs/design/Hookka ERP
Desktop.dc.html`

---

## What to verify (your turn)

1. iPhone Safari hard-refresh `erp.hookka.com` → tap into Home, scroll: KPI should feel tighter, Quick Actions on top
2. Tap any customer row → opens customer detail with Hubs list (round 2)
3. Tap any supplier row → opens supplier detail with Materials list (tonight)
4. Tap any product row → opens product detail with Dept Times list (tonight)
5. Open `docs/design/Hookka ERP Desktop.dc.html` in any browser → cycle the 52 scenes via the bottom-right SCENE switcher
