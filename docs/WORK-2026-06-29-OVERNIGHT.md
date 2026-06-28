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

## What I did NOT finish (honest list)

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

## What to verify (your turn)

1. iPhone Safari hard-refresh `erp.hookka.com` → tap into Home, scroll: KPI should feel tighter, Quick Actions on top
2. Tap any customer row → opens customer detail with Hubs list (round 2)
3. Tap any supplier row → opens supplier detail with Materials list (tonight)
4. Tap any product row → opens product detail with Dept Times list (tonight)
5. Open `docs/design/Hookka ERP Desktop.dc.html` in any browser → cycle the 52 scenes via the bottom-right SCENE switcher
