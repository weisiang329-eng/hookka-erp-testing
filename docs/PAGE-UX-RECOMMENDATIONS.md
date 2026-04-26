# Page UX recommendations — multi-tab and beyond

How leading ERPs handle the multi-tab + state-preservation problems Hookka now hits at long-shift volume, with a ranked recommendation table at the end.

## What other ERPs do

### 1. Multi-tab navigation: cap or no cap?

| Suite | Approach |
|---|---|
| **SAP S/4HANA Fiori** | Each app is a tile in the [launchpad](https://help.sap.com/docs/SAP_S4HANA_CLOUD/0f69f8fb28ac4bf48d2b57b9637e81fa/4f7e60afa1264e409a0f16ae04aae339.html); related records open as tabs in the shell bar. **Soft cap** — overflow → "more" dropdown. |
| **Oracle Cloud (Fusion)** | Single-active-page; **Recently Visited** list in the global header. Not multi-tab. |
| **Microsoft Dynamics 365** | [Multi-session apps](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/multi-session-overview) — Customer Service Workspace caps at **9 sessions**. Hard cap, toast on overflow. |
| **NetSuite** | Master-detail split panel; tabs are *form sections*, not records. |
| **Odoo** | Single-page; breadcrumbs at top. No tabs. |
| **Salesforce Lightning Console** | [Subtabs](https://help.salesforce.com/s/articleView?id=service.console_lex_workspace_tabs.htm) with **LRU eviction at 30** + pinning that exempts a tab from eviction. |
| **Workday** | Inbox + breadcrumb; modal-heavy. |

Two patterns dominate: hard cap + toast (Dynamics, Odoo-as-no-tabs) vs LRU + pin (Salesforce, SAP). Hookka's bedframe-detail-heavy workflow looks more like Salesforce — many short-lived "look up this SO" interruptions per shift.

### 2. Side panel / detail pane

NetSuite, Salesforce list views, and Dynamics 365 all support **split master-detail**: row click → detail in right-hand pane without leaving the list. Pro: no tab pollution for peeks. Con: doubles working width — bad on 1366-wide factory laptops, and a multi-day rebuild of existing list pages.

### 3. Recently visited

Oracle Fusion and Fiori both surface ~10 most-recent records as a dropdown, distinct from open tabs. Cheap: write to `localStorage` on detail-page mount, render a dropdown in the topbar.

### 4. Pinning

Salesforce Lightning's pinned subtabs survive eviction and reload. Hookka already has `togglePinned` (right-click → Pin); this batch's LRU change exempts pinned tabs. Missing: default-pinned set ("Sales Orders", "MRP") for new users.

### 5. Workspaces

Dynamics 365 [Workspaces](https://learn.microsoft.com/en-us/dynamics365/customer-service/implement/multisession-multi-app) are named tab-groups (e.g. "Customer call session"). Implementation effort is high and the value peaks at multi-thousand-employee call-centre scale. Skip for Hookka.

### 6. State preservation (filter / sort / scroll)

Bigger pain than tab count. Fiori encodes filter state into the URL (`?$filter=…`); Salesforce stores list-view state in `localStorage` per user+list. Hookka currently loses everything on `TabbedOutlet` mount because only the active pane renders. Fix: a `useUrlState(key, default)` hook syncing critical filters into `?` (already in flight on a sibling branch). Scroll restoration is harder — defer.

## Recommendations for Hookka

| # | Recommendation | Effort | Impact | Decision |
|---|---|---|---|---|
| 1 | **10-tab LRU cap with dirty-aware eviction modal** | M | High | DO NOW (this batch) |
| 2 | **Tab pinning UX polish** — default pins for Dashboard/MRP/SO; pin glyph in tab strip already exists | S | Medium | NEXT BATCH |
| 3 | **Recently-visited dropdown** in topbar (10 most-recent records, cross-tab, persists) | S | Medium | NEXT BATCH |
| 4 | **URL-synced filters/sort** on `/sales`, `/production`, `/procurement` lists (`?status=DRAFT&sort=-companySODate`) | M | High | NEXT BATCH |
| 5 | **Master-detail split** for SO list (peek a record without opening a tab) | L | Medium | DEFER |
| 6 | **Scroll restoration** on tab switch | M | Low | DEFER |
| 7 | **Workspace concept** (Dynamics-style named groups) | XL | Low at Hookka size | SKIP |

Top three for next batch: pinning defaults (#2) + recently-visited (#3) ship in a single small PR; URL-synced list filters (#4) is a separate one. After those, master-detail (#5) is worth piloting on the SO list because it's the page users keep peeking at.
