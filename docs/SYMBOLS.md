# SYMBOLS — API Endpoint Index

API endpoint index for the Hookka ERP Hono backend. **Ctrl-F the path or a keyword** (e.g. `year-close`, `scan-complete`, `/api/sales-orders`) to jump straight to a handler's `file:line` instead of grepping the repo (which times out).

Router mounts live in `src/api/worker.ts`; every handler below is in `src/api/routes/<file>.ts`. **Regenerate when routes change:** re-run the route sweep (see bottom note) and refresh the affected subsection. ~893 endpoints across 140 mounted routers + 14 inline endpoints. Line numbers are the `.get/.post/...` handler registration.

Conventions: `:param` = path param. Root route (`.get("/")`) shows as the bare mount path. A few routers mount at two bases (noted inline). `all` = any method.

---

## Auth, Sessions & Users

### /api/auth (`src/api/routes/auth.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/auth/login | auth.ts:136 | Dashboard login, issue Bearer token |
| POST /api/auth/logout | auth.ts:399 | Invalidate session |
| GET /api/auth/me | auth.ts:432 | Current user profile |
| GET /api/auth/me/permissions | auth.ts:462 | Current user permission set |
| POST /api/auth/change-password | auth.ts:556 | Change own password |
| POST /api/auth/forgot-password | auth.ts:668 | Request password reset email |
| POST /api/auth/reset-password | auth.ts:824 | Reset password via token |
| GET /api/auth/invite/:token | auth.ts:985 | Resolve invite token |
| POST /api/auth/accept-invite | auth.ts:1030 | Accept invite, set password |

### /api/auth/oauth (`src/api/routes/auth-oauth.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/auth/oauth/google/start | auth-oauth.ts:52 | Begin Google OAuth flow |
| GET /api/auth/oauth/google/callback | auth-oauth.ts:97 | Google OAuth callback exchange |

### /api/auth/totp (`src/api/routes/auth-totp.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/auth/totp/enroll | auth-totp.ts:77 | Start TOTP 2FA enrollment |
| POST /api/auth/totp/verify | auth-totp.ts:134 | Verify TOTP enrollment code |
| POST /api/auth/totp/login-verify | auth-totp.ts:183 | Verify TOTP at login |
| POST /api/auth/totp/setup-start | auth-totp.ts:330 | Begin 2FA setup |
| POST /api/auth/totp/setup-confirm | auth-totp.ts:406 | Confirm 2FA setup |
| POST /api/auth/totp/dismiss-prompt | auth-totp.ts:477 | Dismiss 2FA enrollment prompt |
| POST /api/auth/totp/disable | auth-totp.ts:499 | Disable TOTP 2FA |

### /api/worker-auth (`src/api/routes/worker-auth.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/worker-auth/login | worker-auth.ts:124 | Worker PIN login (token) |
| POST /api/worker-auth/reset-pin | worker-auth.ts:241 | Reset worker PIN |
| POST /api/worker-auth/logout | worker-auth.ts:297 | Worker logout |
| GET /api/worker-auth/me | worker-auth.ts:312 | Current worker identity |

### /api/users (`src/api/routes/users.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/users | users.ts:136 | List admin users |
| POST /api/users | users.ts:157 | Create user |
| PUT /api/users/:id | users.ts:230 | Update user |
| DELETE /api/users/:id | users.ts:417 | Delete user |
| POST /api/users/:id/reset-password | users.ts:480 | Admin-reset a user password |
| POST /api/users/invite | users.ts:625 | Send user invite |
| GET /api/users/invites | users.ts:770 | List pending invites |
| POST /api/users/invites/:token/resend | users.ts:791 | Resend invite email |
| DELETE /api/users/invites/:token | users.ts:846 | Revoke invite |
| GET /api/users/:id | users.ts:876 | Get user detail |

### /api/presence (`src/api/routes/presence.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/presence | presence.ts:56 | Heartbeat online presence |
| GET /api/presence | presence.ts:106 | List active users |
| DELETE /api/presence | presence.ts:131 | Clear own presence |

---

## Customers, Products & Pricing

### /api/customers (`src/api/routes/customers.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/customers | customers.ts:259 | List customers |
| POST /api/customers | customers.ts:294 | Create customer |
| GET /api/customers/:id | customers.ts:368 | Get customer |
| PUT /api/customers/:id | customers.ts:386 | Update customer |
| DELETE /api/customers/:id | customers.ts:586 | Delete customer |

### /api/customer-hubs (`src/api/routes/customer-hubs.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/customer-hubs | customer-hubs.ts:58 | List customer delivery hubs |

### /api/customer-products (`src/api/routes/customer-products.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/customer-products | customer-products.ts:113 | List customer-product bindings |
| GET /api/customer-products/by-product/:productId | customer-products.ts:273 | Bindings for a product |
| POST /api/customer-products | customer-products.ts:316 | Create binding |
| GET /api/customer-products/:customerProductId/price-history | customer-products.ts:412 | Price history for binding |
| POST /api/customer-products/:customerProductId/prices | customer-products.ts:434 | Add price row |
| DELETE /api/customer-products/price-row/:priceRowId | customer-products.ts:590 | Delete price row |
| PUT /api/customer-products/:id | customer-products.ts:614 | Update binding |
| DELETE /api/customer-products/:id | customer-products.ts:714 | Delete binding |
| POST /api/customer-products/bulk-assign | customer-products.ts:743 | Bulk-assign products to customer |
| POST /api/customer-products/copy-from-master | customer-products.ts:833 | Copy master catalog to customer |
| GET /api/customer-products/price-for/:productId/:customerId | customer-products.ts:1111 | Resolve effective price |

### /api/customer-maintenance (`src/api/routes/customer-maintenance.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/customer-maintenance/:customerId/copy-from-master | customer-maintenance.ts:30 | Copy master maintenance to customer |

### /api/customer-quotation (`src/api/routes/customer-quotation.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/customer-quotation | customer-quotation.ts:81 | Customer quotation data |

### /api/products (`src/api/routes/products.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/products | products.ts:421 | List products |
| POST /api/products | products.ts:491 | Create product |
| GET /api/products/:id | products.ts:628 | Get product |
| PUT /api/products/:id | products.ts:637 | Update product |
| DELETE /api/products/:id | products.ts:845 | Delete product |
| GET /api/products/:productId/price-history | products.ts:968 | Master price history |
| POST /api/products/:productId/prices | products.ts:990 | Add master price row |
| DELETE /api/products/price-row/:priceRowId | products.ts:1126 | Delete master price row |

### /api/product-configs (`src/api/routes/product-configs.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/product-configs | product-configs.ts:75 | Product config options |

### /api/sofa-combos (`src/api/routes/sofa-combos.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/sofa-combos | sofa-combos.ts:118 | List sofa combos |
| POST /api/sofa-combos | sofa-combos.ts:208 | Create sofa combo |
| POST /api/sofa-combos/copy-from-master | sofa-combos.ts:357 | Copy master sofa combos |
| PUT /api/sofa-combos/:id | sofa-combos.ts:493 | Update sofa combo |
| DELETE /api/sofa-combos/:id | sofa-combos.ts:630 | Delete sofa combo |

### /api/price-history (`src/api/routes/price-history.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/price-history | price-history.ts:56 | List price-history entries |
| POST /api/price-history | price-history.ts:101 | Record price change |

---

## BOM & CNC Templates

### /api/bom (`src/api/routes/bom.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/bom | bom.ts:130 | List BOMs |
| POST /api/bom | bom.ts:144 | Create BOM |
| GET /api/bom/templates | bom.ts:231 | List BOM templates |
| POST /api/bom/templates | bom.ts:302 | Create BOM template |
| PUT /api/bom/templates | bom.ts:377 | Update templates (batch) |
| PUT /api/bom/templates/:id | bom.ts:484 | Update one template |
| POST /api/bom/templates/bulk-process-edit | bom.ts:631 | Bulk-edit template processes |
| POST /api/bom/resync-job-card-times | bom.ts:823 | Resync JC times from BOM |
| POST /api/bom/audit-contamination | bom.ts:1197 | Audit cross-BOM contamination |
| GET /api/bom/:id | bom.ts:1336 | Get BOM |
| PUT /api/bom/:id | bom.ts:1348 | Update BOM |

### /api/bom-master-templates (`src/api/routes/bom-master-templates.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/bom-master-templates | bom-master-templates.ts:80 | List master templates |
| GET /api/bom-master-templates/:id | bom-master-templates.ts:89 | Get master template |
| PUT /api/bom-master-templates/:id | bom-master-templates.ts:101 | Update master template |
| DELETE /api/bom-master-templates/:id | bom-master-templates.ts:179 | Delete master template |
| PUT /api/bom-master-templates | bom-master-templates.ts:190 | Bulk update master templates |

### /api/cnc-templates (`src/api/routes/cnc-templates.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/cnc-templates | cnc-templates.ts:693 | List CNC cutting templates |
| GET /api/cnc-templates/:id | cnc-templates.ts:742 | Get CNC template |
| GET /api/cnc-templates/:id/file/:kind | cnc-templates.ts:763 | Download CNC template file |
| POST /api/cnc-templates | cnc-templates.ts:822 | Create CNC template |
| POST /api/cnc-templates/import | cnc-templates.ts:948 | Import CNC templates |
| PATCH /api/cnc-templates/:id | cnc-templates.ts:1179 | Update CNC template |
| DELETE /api/cnc-templates/:id | cnc-templates.ts:1273 | Delete CNC template |

---

## Sales Orders

### /api/sales-orders (`src/api/routes/sales-orders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/sales-orders | sales-orders.ts:952 | List sales orders |
| GET /api/sales-orders/status-changes | sales-orders.ts:1178 | SO status-change feed |
| GET /api/sales-orders/stats | sales-orders.ts:1219 | SO summary stats |
| GET /api/sales-orders/delivery-progress | sales-orders.ts:1336 | Per-SO delivery progress |
| GET /api/sales-orders/repair-components | sales-orders.ts:1384 | Repair component lookup |
| GET /api/sales-orders/:id/edit-eligibility | sales-orders.ts:1579 | Can this SO be edited |
| POST /api/sales-orders/:id/override-edit-lock | sales-orders.ts:1693 | Override SO edit lock |
| POST /api/sales-orders | sales-orders.ts:1995 | Create sales order |
| POST /api/sales-orders/:id/confirm | sales-orders.ts:2653 | Confirm SO (cascade POs) |
| GET /api/sales-orders/:id | sales-orders.ts:3051 | Get sales order |
| PUT /api/sales-orders/:id | sales-orders.ts:3303 | Update sales order |
| PATCH /api/sales-orders/:id/hub | sales-orders.ts:4627 | Change SO delivery hub |
| DELETE /api/sales-orders/:id | sales-orders.ts:5291 | Delete sales order |
| POST /api/sales-orders/copy-for-service-order | sales-orders.ts:5349 | Clone SO for service order |
| POST /api/sales-orders/batch-company | sales-orders.ts:5730 | Batch set SO company |

---

## Procurement (Purchasing, Suppliers, GRN, Matching)

### /api/purchase-orders (`src/api/routes/purchase-orders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/purchase-orders | purchase-orders.ts:308 | List purchase orders |
| POST /api/purchase-orders | purchase-orders.ts:344 | Create purchase order |
| GET /api/purchase-orders/:id | purchase-orders.ts:593 | Get purchase order |
| PUT /api/purchase-orders/:id | purchase-orders.ts:604 | Update purchase order |
| POST /api/purchase-orders/:id/email | purchase-orders.ts:941 | Email PO to supplier |
| DELETE /api/purchase-orders/:id | purchase-orders.ts:1002 | Delete purchase order |

### /api/purchase-invoices (`src/api/routes/purchase-invoices.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/purchase-invoices | purchase-invoices.ts:655 | List purchase invoices |
| GET /api/purchase-invoices/:id | purchase-invoices.ts:693 | Get purchase invoice |
| POST /api/purchase-invoices | purchase-invoices.ts:729 | Create purchase invoice (GL post) |
| POST /api/purchase-invoices/repair-gl-visibility | purchase-invoices.ts:1393 | Repair PI GL visibility |
| POST /api/purchase-invoices/backfill-gl-postings | purchase-invoices.ts:1439 | Backfill PI→GL postings |
| PUT /api/purchase-invoices/:id | purchase-invoices.ts:1458 | Update purchase invoice |
| DELETE /api/purchase-invoices/:id | purchase-invoices.ts:2070 | Delete purchase invoice |

### /api/suppliers (`src/api/routes/suppliers.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/suppliers | suppliers.ts:262 | List suppliers |
| POST /api/suppliers | suppliers.ts:288 | Create supplier |
| GET /api/suppliers/:id | suppliers.ts:418 | Get supplier |
| PUT /api/suppliers/:id | suppliers.ts:439 | Update supplier |
| DELETE /api/suppliers/:id | suppliers.ts:652 | Delete supplier |

### /api/supplier-materials (`src/api/routes/supplier-materials.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/supplier-materials | supplier-materials.ts:134 | List supplier-material bindings |
| POST /api/supplier-materials | supplier-materials.ts:166 | Create binding |
| GET /api/supplier-materials/:id | supplier-materials.ts:284 | Get binding |
| PUT /api/supplier-materials/:id | supplier-materials.ts:296 | Update binding |
| DELETE /api/supplier-materials/:id | supplier-materials.ts:430 | Delete binding |

_(Compat: `/api/supplier-material-bindings[/*]` 308-redirects here — worker.ts:1155.)_

### /api/supplier-scorecards (`src/api/routes/supplier-scorecards.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/supplier-scorecards | supplier-scorecards.ts:47 | List supplier scorecards |
| GET /api/supplier-scorecards/summary | supplier-scorecards.ts:94 | Scorecard summary |
| GET /api/supplier-scorecards/:supplierId | supplier-scorecards.ts:182 | One supplier scorecard |

### /api/grn (`src/api/routes/grn.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/grn | grn.ts:1025 | List goods-received notes |
| POST /api/grn | grn.ts:1094 | Create GRN |
| GET /api/grn/:id | grn.ts:1443 | Get GRN |
| PUT /api/grn/:id | grn.ts:1459 | Update GRN |
| PUT /api/grn/:id/arrival | grn.ts:1807 | Mark GRN arrival |
| DELETE /api/grn/:id | grn.ts:1917 | Delete GRN |

### /api/three-way-match (`src/api/routes/three-way-match.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/three-way-match | three-way-match.ts:117 | List PO/GRN/PI matches |
| GET /api/three-way-match/by-po/:poId | three-way-match.ts:221 | Match detail for a PO |
| POST /api/three-way-match | three-way-match.ts:457 | Run/save three-way match |

### /api/goods-in-transit (`src/api/routes/goods-in-transit.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/goods-in-transit | goods-in-transit.ts:92 | List in-transit goods |
| POST /api/goods-in-transit | goods-in-transit.ts:117 | Create in-transit record |
| GET /api/goods-in-transit/:id | goods-in-transit.ts:240 | Get in-transit record |
| PUT /api/goods-in-transit/:id | goods-in-transit.ts:255 | Update in-transit record |
| DELETE /api/goods-in-transit/:id | goods-in-transit.ts:364 | Delete in-transit record |

---

## Invoicing, Payments & Notes

### /api/invoices (`src/api/routes/invoices.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/invoices/backfill-customer-fields | invoices.ts:587 | Backfill invoice customer fields |
| POST /api/invoices/backfill-date-from-delivery | invoices.ts:730 | Backfill invoice date from DO |
| GET /api/invoices | invoices.ts:809 | List invoices |
| GET /api/invoices/stats | invoices.ts:913 | Invoice stats |
| GET /api/invoices/aging | invoices.ts:1038 | AR aging |
| POST /api/invoices | invoices.ts:1131 | Create invoice |
| GET /api/invoices/:id/print-extras | invoices.ts:1391 | Invoice print extras |
| GET /api/invoices/:id | invoices.ts:1403 | Get invoice |
| PUT /api/invoices/:id | invoices.ts:1418 | Update invoice |
| DELETE /api/invoices/:id | invoices.ts:2124 | Delete invoice |

### /api/e-invoices (`src/api/routes/e-invoices.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/e-invoices | e-invoices.ts:119 | List e-invoices (MyInvois) |
| POST /api/e-invoices | e-invoices.ts:134 | Create e-invoice |
| GET /api/e-invoices/:id | e-invoices.ts:235 | Get e-invoice |
| PUT /api/e-invoices/:id | e-invoices.ts:257 | Update e-invoice |

### /api/credit-notes (`src/api/routes/credit-notes.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/credit-notes | credit-notes.ts:189 | List credit notes |
| POST /api/credit-notes | credit-notes.ts:204 | Create credit note |
| GET /api/credit-notes/:id | credit-notes.ts:448 | Get credit note |
| PUT /api/credit-notes/:id | credit-notes.ts:471 | Update credit note |

### /api/debit-notes (`src/api/routes/debit-notes.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/debit-notes | debit-notes.ts:122 | List debit notes |
| POST /api/debit-notes | debit-notes.ts:137 | Create debit note |
| GET /api/debit-notes/:id | debit-notes.ts:282 | Get debit note |
| PUT /api/debit-notes/:id | debit-notes.ts:302 | Update debit note |

### /api/payments (`src/api/routes/payments.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/payments | payments.ts:388 | List customer payments |
| POST /api/payments | payments.ts:439 | Record payment |
| GET /api/payments/:id | payments.ts:883 | Get payment |
| PUT /api/payments/:id | payments.ts:899 | Update payment |
| POST /api/payments/:id/lifecycle | payments.ts:1112 | Payment lifecycle transition |
| POST /api/payments/:id/restate | payments.ts:1155 | Restate payment |

### /api/supplier-payments (`src/api/routes/supplier-payments.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/supplier-payments | supplier-payments.ts:47 | List supplier payments |
| POST /api/supplier-payments | supplier-payments.ts:119 | Record supplier payment |
| POST /api/supplier-payments/knock-off | supplier-payments.ts:415 | Knock off invoices |
| POST /api/supplier-payments/un-knock | supplier-payments.ts:558 | Reverse knock-off |
| POST /api/supplier-payments/:paymentNo/void | supplier-payments.ts:957 | Void supplier payment |
| POST /api/supplier-payments/:paymentNo/lifecycle | supplier-payments.ts:1005 | Lifecycle transition |
| POST /api/supplier-payments/recompute-pi-paid | supplier-payments.ts:1057 | Recompute PI paid amounts |
| POST /api/supplier-payments/:paymentNo/restate | supplier-payments.ts:1085 | Restate supplier payment |

---

## Accounting & Finance

### /api/accounting (`src/api/routes/accounting.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/accounting/aging | accounting.ts:410 | AR/AP aging |
| POST /api/accounting/aging | accounting.ts:602 | Aging snapshot compute |
| GET /api/accounting/coa | accounting.ts:690 | Chart of accounts |
| POST /api/accounting/coa | accounting.ts:700 | Create GL account |
| PUT /api/accounting/coa | accounting.ts:780 | Update GL account |
| POST /api/accounting/coa/rename | accounting.ts:913 | Rename GL account |
| GET /api/accounting/journals | accounting.ts:1025 | List journals |
| POST /api/accounting/journals | accounting.ts:1055 | Create journal entry |
| GET /api/accounting/journals/:id | accounting.ts:1139 | Get journal |
| PUT /api/accounting/journals/:id | accounting.ts:1162 | Update journal |
| POST /api/accounting/journals/:id/lifecycle | accounting.ts:1456 | Journal lifecycle transition |
| DELETE /api/accounting/journals/:id | accounting.ts:1510 | Delete journal |
| GET /api/accounting/ar-control | accounting.ts:1543 | AR control account |
| GET /api/accounting/customer-statement | accounting.ts:1680 | Customer statement |
| GET /api/accounting/purchase-credit-notes | accounting.ts:1877 | List purchase credit notes |
| POST /api/accounting/purchase-credit-notes | accounting.ts:1890 | Create purchase credit note |
| PUT /api/accounting/purchase-credit-notes/:id | accounting.ts:2010 | Update purchase credit note |
| POST /api/accounting/purchase-credit-notes/:id/void | accounting.ts:2215 | Void purchase credit note |
| GET /api/accounting/ap-control | accounting.ts:2331 | AP control account |
| GET /api/accounting/ap-reconciliation | accounting.ts:2557 | AP reconciliation |
| GET /api/accounting/ar-reconciliation | accounting.ts:2732 | AR reconciliation |
| POST /api/accounting/ar-control/rebuild-counter | accounting.ts:2965 | Rebuild AR running counter |
| POST /api/accounting/ap-control/rebuild-counter | accounting.ts:2988 | Rebuild AP running counter |
| GET /api/accounting/supplier-statement | accounting.ts:3009 | Supplier statement |
| GET /api/accounting/debtor-ledger | accounting.ts:3127 | Debtor ledger |
| GET /api/accounting/creditor-ledger | accounting.ts:3172 | Creditor ledger |
| GET /api/accounting/other-parties | accounting.ts:3290 | List other parties |
| POST /api/accounting/other-parties | accounting.ts:3311 | Create other party |
| PUT /api/accounting/other-parties/:id | accounting.ts:3370 | Update other party |
| DELETE /api/accounting/other-parties/:id | accounting.ts:3450 | Delete other party |
| POST /api/accounting/other-party-bills | accounting.ts:3474 | Create other-party bill |
| PUT /api/accounting/other-party-bills/:billNo | accounting.ts:3612 | Update other-party bill |
| GET /api/accounting/other-party-bills | accounting.ts:3763 | List other-party bills |
| DELETE /api/accounting/other-party-bills/:billNo | accounting.ts:3825 | Delete other-party bill |
| POST /api/accounting/other-party-bills/:billNo/lifecycle | accounting.ts:3879 | Bill lifecycle transition |
| POST /api/accounting/other-party-payments | accounting.ts:3913 | Create other-party payment |
| GET /api/accounting/other-party-payments | accounting.ts:4013 | List other-party payments |
| GET /api/accounting/audit-log | accounting.ts:4050 | Accounting audit log |
| GET /api/accounting/other-party-aging | accounting.ts:4157 | Other-party aging |
| POST /api/accounting/other-party-payments/:paymentNo/void | accounting.ts:4392 | Void other-party payment |
| POST /api/accounting/other-party-payments/:paymentNo/lifecycle | accounting.ts:4413 | Lifecycle transition |
| POST /api/accounting/other-party-payments/:paymentNo/restate | accounting.ts:4435 | Restate other-party payment |
| GET /api/accounting/stock-map/effective | accounting.ts:4489 | Effective stock GL map |
| GET /api/accounting/trial-balance | accounting.ts:4560 | Trial balance |
| GET /api/accounting/gl | accounting.ts:4628 | General ledger |
| GET /api/accounting/year-close/preview | accounting.ts:4974 | Year-end close preview |
| POST /api/accounting/year-close | accounting.ts:5003 | Run year-end close |
| POST /api/accounting/stock/close-post | accounting.ts:5467 | Post stock close |
| GET /api/accounting/stock-summary | accounting.ts:5587 | Stock valuation summary |
| GET /api/accounting/cost-by-line | accounting.ts:5722 | Cost by line |
| GET /api/accounting/wip-detail | accounting.ts:5738 | WIP detail |
| GET /api/accounting/cleanup-report | accounting.ts:5793 | GL cleanup report |
| GET /api/accounting/cost-structure | accounting.ts:7146 | Cost structure |
| GET /api/accounting/cost-expense-classes | accounting.ts:7238 | Cost/expense classes |
| GET /api/accounting/pl-trend | accounting.ts:7333 | P&L trend |
| GET /api/accounting/pl-statement | accounting.ts:7367 | P&L statement |
| GET /api/accounting/pl-monthly | accounting.ts:7434 | Monthly P&L |
| GET /api/accounting/cashflow-statement | accounting.ts:7503 | Cash flow statement |
| GET /api/accounting/pl | accounting.ts:7605 | P&L (legacy) |
| GET /api/accounting/payment-vouchers | accounting.ts:8029 | List payment vouchers |
| POST /api/accounting/payment-vouchers | accounting.ts:8058 | Create payment voucher |
| POST /api/accounting/payment-vouchers/:id/settle | accounting.ts:8181 | Settle payment voucher |
| POST /api/accounting/payment-vouchers/:id/lifecycle | accounting.ts:8257 | Voucher lifecycle transition |
| POST /api/accounting/payment-vouchers/:id/restate | accounting.ts:8297 | Restate payment voucher |
| GET /api/accounting/official-receipts | accounting.ts:8356 | List official receipts |
| POST /api/accounting/official-receipts | accounting.ts:8385 | Create official receipt |
| POST /api/accounting/official-receipts/:id/lifecycle | accounting.ts:8478 | Receipt lifecycle transition |
| POST /api/accounting/fund-transfers | accounting.ts:8513 | Create fund transfer |
| GET /api/accounting/fund-transfers | accounting.ts:8618 | List fund transfers |
| POST /api/accounting/fund-transfers/:no/lifecycle | accounting.ts:8722 | Transfer lifecycle transition |
| GET /api/accounting/contra/candidates | accounting.ts:8759 | Contra candidates |
| POST /api/accounting/contra | accounting.ts:8795 | Create contra entry |
| GET /api/accounting/labor/preview | accounting.ts:9102 | Labor cost posting preview |
| POST /api/accounting/labor/post | accounting.ts:9138 | Post labor cost |
| GET /api/accounting/labor/map | accounting.ts:9207 | Labor GL map |
| PUT /api/accounting/labor/map | accounting.ts:9214 | Update labor GL map |
| GET /api/accounting/cashflow/map | accounting.ts:9239 | Cash flow map |
| PUT /api/accounting/cashflow/map | accounting.ts:9247 | Update cash flow map |
| GET /api/accounting/doc-number-prefixes | accounting.ts:9288 | Document number prefixes |
| PUT /api/accounting/doc-number-prefixes | accounting.ts:9295 | Update doc-number prefixes |
| GET /api/accounting/pnl/section-map | accounting.ts:9318 | P&L section map |
| PUT /api/accounting/pnl/section-map | accounting.ts:9325 | Update P&L section map |
| GET /api/accounting/bs/section-map | accounting.ts:9344 | Balance-sheet section map |
| PUT /api/accounting/bs/section-map | accounting.ts:9351 | Update BS section map |
| GET /api/accounting/landed-cost/preview | accounting.ts:9439 | Landed cost preview |
| POST /api/accounting/landed-cost | accounting.ts:9473 | Apply landed cost |
| GET /api/accounting/gl-report | accounting.ts:9556 | GL report |
| GET /api/accounting/fixed-assets | accounting.ts:9740 | List fixed assets |
| POST /api/accounting/fixed-assets | accounting.ts:9751 | Create fixed asset |
| PUT /api/accounting/fixed-assets/:id | accounting.ts:9802 | Update fixed asset |
| DELETE /api/accounting/fixed-assets/:id | accounting.ts:9837 | Delete fixed asset |
| GET /api/accounting/fixed-assets/depreciation-preview | accounting.ts:9857 | Depreciation preview |
| POST /api/accounting/fixed-assets/depreciation-run | accounting.ts:9902 | Run depreciation |
| GET /api/accounting/bank-reco | accounting.ts:10022 | Bank reconciliation |
| POST /api/accounting/bank-reco/import | accounting.ts:10100 | Import bank statement |
| POST /api/accounting/bank-reco/match | accounting.ts:10140 | Match bank lines |
| POST /api/accounting/bank-reco/unmatch | accounting.ts:10188 | Unmatch bank lines |
| POST /api/accounting/bank-reco/automatch | accounting.ts:10206 | Auto-match bank lines |
| DELETE /api/accounting/bank-reco/line/:id | accounting.ts:10287 | Delete bank-reco line |
| GET /api/accounting/opening-balance | accounting.ts:10525 | Opening balances |
| POST /api/accounting/opening-balance/ap-exclude | accounting.ts:10632 | Exclude AP from opening |
| PUT /api/accounting/opening-balance/pnl-prior-cum | accounting.ts:10688 | Set prior cumulative P&L |
| PUT /api/accounting/opening-date | accounting.ts:10735 | Set opening date |
| POST /api/accounting/opening-balance/ar | accounting.ts:10764 | Add AR opening balance |
| DELETE /api/accounting/opening-balance/ar/:id | accounting.ts:10817 | Delete AR opening balance |
| POST /api/accounting/opening-balance/ap | accounting.ts:10845 | Add AP opening balance |
| DELETE /api/accounting/opening-balance/ap/:id | accounting.ts:10897 | Delete AP opening balance |
| POST /api/accounting/opening-balance/post | accounting.ts:10928 | Post opening balances |
| GET /api/accounting/stock-take | accounting.ts:11085 | Stock take |
| PUT /api/accounting/rm-valuation-mode | accounting.ts:11115 | Set RM valuation mode |
| GET /api/accounting/stock-take-item-aliases | accounting.ts:11147 | Stock-take item aliases |
| PUT /api/accounting/stock-take | accounting.ts:11175 | Update stock take |
| POST /api/accounting/stock-take-item-alias-seed | accounting.ts:11252 | Seed stock-take aliases |
| GET /api/accounting/material-opening-stock | accounting.ts:11362 | Material opening stock |
| PUT /api/accounting/material-opening-stock | accounting.ts:11411 | Update material opening stock |

### /api/cash-flow (`src/api/routes/cash-flow.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/cash-flow | cash-flow.ts:144 | Cash flow data |
| POST /api/cash-flow | cash-flow.ts:240 | Record cash flow entry |

### /api/cost-ledger (`src/api/routes/cost-ledger.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/cost-ledger | cost-ledger.ts:120 | Cost ledger entries |
| GET /api/cost-ledger/rm-batches | cost-ledger.ts:163 | RM batch costs |
| GET /api/cost-ledger/fg-batches | cost-ledger.ts:188 | FG batch costs |
| GET /api/cost-ledger/summary | cost-ledger.ts:224 | Cost ledger summary |

### /api/stock-value (`src/api/routes/stock-value.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/stock-value | stock-value.ts:58 | List stock valuations |
| POST /api/stock-value | stock-value.ts:72 | Create stock valuation |
| GET /api/stock-value/:id | stock-value.ts:170 | Get stock valuation |
| PUT /api/stock-value/:id | stock-value.ts:185 | Update stock valuation |

### /api/stock-accounts (`src/api/routes/stock-accounts.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/stock-accounts | stock-accounts.ts:29 | Stock GL accounts |

---

## Production

### /api/production-orders (`src/api/routes/production-orders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/production-orders/overdue-counts | production-orders.ts:4818 | Overdue PO counts |
| GET /api/production-orders | production-orders.ts:5438 | List production orders |
| GET /api/production-orders/historical-wips | production-orders.ts:5745 | Historical WIP snapshot |
| GET /api/production-orders/historical-fgs | production-orders.ts:5817 | Historical FG snapshot |
| POST /api/production-orders/stock | production-orders.ts:5878 | Stock-in finished goods |
| POST /api/production-orders/resync-po-numbers | production-orders.ts:6211 | Resync PO numbers |
| POST /api/production-orders/packing-rack-tokens | production-orders.ts:6333 | Generate packing rack tokens |
| POST /api/production-orders/:id/scan-complete | production-orders.ts:6553 | Scan-complete a job card |
| POST /api/production-orders/:id/scan-complete-dept | production-orders.ts:7151 | Scan-complete by department |
| POST /api/production-orders/:id/scan-complete-shared | production-orders.ts:7478 | Scan-complete shared piece |
| GET /api/production-orders/board | production-orders.ts:7992 | Production board view |
| GET /api/production-orders/:id | production-orders.ts:8079 | Get production order |
| POST /api/production-orders/bulk-patch | production-orders.ts:8173 | Bulk-patch production orders |
| PUT /api/production-orders/:id | production-orders.ts:8409 | Update production order |
| PATCH /api/production-orders/:id | production-orders.ts:8419 | Patch production order |
| POST /api/production-orders/:id/hold | production-orders.ts:8574 | Hold production order |
| POST /api/production-orders/:id/resume | production-orders.ts:8581 | Resume production order |
| POST /api/production-orders/:id/cancel | production-orders.ts:8588 | Cancel production order |

### /api/production-folders (`src/api/routes/production-folders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/production-folders | production-folders.ts:94 | List production folders |
| POST /api/production-folders | production-folders.ts:119 | Create folder snapshot |
| GET /api/production-folders/:id | production-folders.ts:176 | Get folder |
| PATCH /api/production-folders/:id | production-folders.ts:218 | Update folder |
| DELETE /api/production-folders/:id | production-folders.ts:269 | Delete folder |
| POST /api/production-folders/:id/add-jcs | production-folders.ts:289 | Add job cards to folder |
| POST /api/production-folders/:id/remove-jcs | production-folders.ts:337 | Remove job cards from folder |

### /api/production-leadtimes + /api/production/leadtimes (`src/api/routes/production-leadtimes.ts`)
_Mounted at both bases (worker.ts:1246-1247)._
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/production-leadtimes | production-leadtimes.ts:193 | List lead times |
| PUT /api/production-leadtimes/settings | production-leadtimes.ts:202 | Update leadtime settings |
| PUT /api/production-leadtimes | production-leadtimes.ts:230 | Update lead times |
| POST /api/production-leadtimes/recalc-all | production-leadtimes.ts:310 | Recalculate all lead times |
| GET /api/production-leadtimes/history | production-leadtimes.ts:404 | Leadtime change history |
| POST /api/production-leadtimes/schedule | production-leadtimes.ts:519 | Schedule leadtime change |
| DELETE /api/production-leadtimes/history/:id | production-leadtimes.ts:595 | Delete history entry |

### /api/production/sync-jobcards-from-bom (`src/api/routes/jobcard-sync.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/production/sync-jobcards-from-bom | jobcard-sync.ts:208 | Reconcile job cards with BOM |

### /api/job-cards (`src/api/routes/job-cards.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/job-cards | job-cards.ts:72 | List job cards |
| GET /api/job-cards/summary | job-cards.ts:207 | Job-card summary |
| GET /api/job-cards/:id/events | job-cards.ts:374 | Job-card audit events |
| GET /api/job-cards/duedate-original-backup | job-cards.ts:480 | Original due-date backup |
| GET /api/job-cards/completion-pic-original-backup | job-cards.ts:632 | Original completion-pic backup |

### /api/mrp (`src/api/routes/mrp.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/mrp | mrp.ts:399 | MRP requirements view |
| GET /api/mrp/runs | mrp.ts:460 | List MRP runs |
| GET /api/mrp/runs/:id | mrp.ts:481 | Get MRP run |
| POST /api/mrp | mrp.ts:538 | Run MRP |

### /api/forecasts (`src/api/routes/forecasts.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/forecasts | forecasts.ts:47 | List demand forecasts |
| POST /api/forecasts | forecasts.ts:72 | Create forecast |

### /api/historical-sales (`src/api/routes/historical-sales.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/historical-sales | historical-sales.ts:38 | Historical sales data |

---

## Planning & Scheduling

### /api/planning (schedule) (`src/api/routes/planning-schedule.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/planning/schedule/fabric-cutting | planning-schedule.ts:104 | Fabric-cutting schedule |
| GET /api/planning/schedule/:dept | planning-schedule.ts:505 | Department schedule |

### /api/planning (proposals) (`src/api/routes/schedule-proposals.ts`)
_Second router on the /api/planning base (worker.ts:1271)._
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/planning/proposals/generate | schedule-proposals.ts:75 | Generate due-date proposals |
| GET /api/planning/proposals | schedule-proposals.ts:101 | List schedule proposals |
| POST /api/planning/proposals/approve | schedule-proposals.ts:138 | Approve proposal |
| POST /api/planning/proposals/reject | schedule-proposals.ts:213 | Reject proposal |

### /api/scheduling (`src/api/routes/scheduling.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/scheduling | scheduling.ts:186 | List schedules |
| POST /api/scheduling | scheduling.ts:195 | Create schedule |
| GET /api/scheduling/capacity | scheduling.ts:275 | Capacity view |

### /api/promise-date (`src/api/routes/promise-date.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/promise-date | promise-date.ts:181 | Compute promise date |

### /api/cs-agent (`src/api/routes/cs-agent.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/cs-agent/promise | cs-agent.ts:31 | Reasoned promise date (SO/what-if) |
| GET /api/cs-agent/procurement/readiness | cs-agent.ts:76 | Procurement readiness gate |

---

## Inventory, Warehouse, Stock & Fabric

### /api/inventory (`src/api/routes/inventory.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/inventory | inventory.ts:148 | Inventory overview |
| GET /api/inventory/shortage-forecast | inventory.ts:225 | Material shortage forecast |
| POST /api/inventory/raw-materials | inventory.ts:395 | Adjust RM inventory |
| GET /api/inventory/rm-source/:rmId | inventory.ts:536 | RM stock source trace |
| GET /api/inventory/fg-stock | inventory.ts:613 | FG stock levels |

### /api/inventory/wip (`src/api/routes/inventory-wip.ts`)
_Mounted before /api/inventory (worker.ts:1135)._
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/inventory/wip | inventory-wip.ts:158 | Aggregated WIP view |

### /api/raw-materials (`src/api/routes/raw-materials.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/raw-materials | raw-materials.ts:147 | List raw materials |
| GET /api/raw-materials/:id | raw-materials.ts:162 | Get raw material |
| GET /api/raw-materials/:id/used-in | raw-materials.ts:180 | Where RM is used |
| POST /api/raw-materials | raw-materials.ts:217 | Create raw material |
| PUT /api/raw-materials/:id | raw-materials.ts:318 | Update raw material |
| DELETE /api/raw-materials/:id | raw-materials.ts:465 | Delete raw material |
| POST /api/raw-materials/bulk-import | raw-materials.ts:524 | Bulk-import raw materials |
| POST /api/raw-materials/_unlock-duplicate-codes | raw-materials.ts:668 | Unlock duplicate-code guard |
| POST /api/raw-materials/_relock-duplicate-codes | raw-materials.ts:699 | Re-lock duplicate-code guard |

### /api/rm-batches (`src/api/routes/rm-batches.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/rm-batches | rm-batches.ts:60 | List RM batches |
| GET /api/rm-batches/:id | rm-batches.ts:79 | Get RM batch |

### /api/fg-units (`src/api/routes/fg-units.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/fg-units | fg-units.ts:517 | List finished-good units |
| GET /api/fg-units/:id | fg-units.ts:572 | Get FG unit |
| POST /api/fg-units/backfill-dedupe-fg-units | fg-units.ts:610 | Dedupe FG units |
| POST /api/fg-units/generate/:poId | fg-units.ts:709 | Generate FG units for PO |
| POST /api/fg-units/backfill-hub | fg-units.ts:736 | Backfill FG unit hub |
| POST /api/fg-units/scan | fg-units.ts:801 | Scan FG unit |

### /api/fabrics (`src/api/routes/fabrics.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/fabrics | fabrics.ts:36 | List fabrics |
| POST /api/fabrics | fabrics.ts:64 | Create fabric |
| PUT /api/fabrics/:id | fabrics.ts:65 | Update fabric |
| DELETE /api/fabrics/:id | fabrics.ts:66 | Delete fabric |

### /api/fabric-tracking (`src/api/routes/fabric-tracking.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/fabric-tracking | fabric-tracking.ts:133 | List fabric-tracking records |
| POST /api/fabric-tracking | fabric-tracking.ts:278 | Create fabric-tracking record |
| DELETE /api/fabric-tracking/:id | fabric-tracking.ts:358 | Delete record |
| PUT /api/fabric-tracking/:id | fabric-tracking.ts:382 | Update record |

### /api/warehouse (`src/api/routes/warehouse.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/warehouse | warehouse.ts:248 | List warehouses |
| POST /api/warehouse | warehouse.ts:298 | Create warehouse |
| POST /api/warehouse/racks | warehouse.ts:396 | Create rack |
| GET /api/warehouse/movements | warehouse.ts:456 | List stock movements |
| POST /api/warehouse/movements | warehouse.ts:497 | Record stock movement |
| GET /api/warehouse/:id/details | warehouse.ts:565 | Warehouse details |
| GET /api/warehouse/:id | warehouse.ts:611 | Get warehouse |
| PUT /api/warehouse/:id | warehouse.ts:628 | Update warehouse |
| DELETE /api/warehouse/:id | warehouse.ts:697 | Delete warehouse |

### /api/stock-adjustments (`src/api/routes/stock-adjustments.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/stock-adjustments | stock-adjustments.ts:152 | List stock adjustments |
| POST /api/stock-adjustments | stock-adjustments.ts:209 | Create stock adjustment |

---

## Delivery & Logistics

### /api/delivery-orders (`src/api/routes/delivery-orders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/delivery-orders | delivery-orders.ts:1236 | List delivery orders |
| GET /api/delivery-orders/stats | delivery-orders.ts:1377 | DO stats |
| GET /api/delivery-orders/po-values | delivery-orders.ts:1451 | DO PO values |
| GET /api/delivery-orders/linked-po-ids | delivery-orders.ts:1500 | Linked PO ids |
| GET /api/delivery-orders/ready-planning | delivery-orders.ts:1533 | Ready-for-planning list |
| GET /api/delivery-orders/pending-sos | delivery-orders.ts:1715 | Pending SOs for delivery |
| POST /api/delivery-orders/backfill-customer-po | delivery-orders.ts:1767 | Backfill customer PO |
| POST /api/delivery-orders/backfill-customer-so | delivery-orders.ts:1865 | Backfill customer SO |
| POST /api/delivery-orders/backfill-delivered-cascade | delivery-orders.ts:2011 | Backfill delivered cascade |
| POST /api/delivery-orders/backfill-fix-underbilled-invoices | delivery-orders.ts:2138 | Fix underbilled invoices |
| POST /api/delivery-orders/backfill-void-reissue-underbilled | delivery-orders.ts:2370 | Void+reissue underbilled |
| POST /api/delivery-orders/backfill-normalize-invoiced-to-delivered | delivery-orders.ts:2734 | Normalize invoiced→delivered |
| POST /api/delivery-orders/backfill-dedupe-delivered | delivery-orders.ts:2838 | Dedupe delivered rows |
| POST /api/delivery-orders | delivery-orders.ts:3981 | Create delivery order |
| POST /api/delivery-orders/packing-list-first | delivery-orders.ts:4028 | Create DO from packing list |
| GET /api/delivery-orders/:id/print-extras | delivery-orders.ts:5097 | DO print extras |
| POST /api/delivery-orders/:id/notify-customer | delivery-orders.ts:5200 | Notify customer of delivery |
| POST /api/delivery-orders/:id/resend-notice | delivery-orders.ts:5244 | Resend delivery notice |
| POST /api/delivery-orders/:id/resolve-incomplete | delivery-orders.ts:5362 | Resolve incomplete DO |
| GET /api/delivery-orders/:id/qr-token | delivery-orders.ts:6071 | Get DO QR token |
| GET /api/delivery-orders/:id | delivery-orders.ts:6101 | Get delivery order |
| PUT /api/delivery-orders/:id | delivery-orders.ts:6119 | Update delivery order |
| DELETE /api/delivery-orders/:id | delivery-orders.ts:7103 | Delete delivery order |

### /api/delivery-returns (`src/api/routes/delivery-returns.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/delivery-returns | delivery-returns.ts:155 | List delivery returns |
| GET /api/delivery-returns/:id | delivery-returns.ts:178 | Get delivery return |
| GET /api/delivery-returns/do-items | delivery-returns.ts:202 | DO items for return |
| POST /api/delivery-returns | delivery-returns.ts:216 | Create delivery return |
| POST /api/delivery-returns/:id/return-to-stock | delivery-returns.ts:310 | Return items to stock |
| POST /api/delivery-returns/:id/set-outcome | delivery-returns.ts:357 | Set return outcome |
| POST /api/delivery-returns/:id/mark-redelivered | delivery-returns.ts:414 | Mark redelivered |
| POST /api/delivery-returns/:id/cancel | delivery-returns.ts:430 | Cancel return |

### /api/packing-lists (`src/api/routes/packing-lists.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/packing-lists | packing-lists.ts:408 | List packing lists |
| GET /api/packing-lists/:id/qr-token | packing-lists.ts:454 | Packing-list QR token |
| GET /api/packing-lists/:id | packing-lists.ts:495 | Get packing list |
| POST /api/packing-lists | packing-lists.ts:753 | Create packing list |
| DELETE /api/packing-lists/:id | packing-lists.ts:780 | Delete packing list |

### /api/drivers (`src/api/routes/drivers.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/drivers | drivers.ts:72 | List drivers |
| POST /api/drivers | drivers.ts:143 | Create driver |
| GET /api/drivers/:id | drivers.ts:199 | Get driver |
| PUT /api/drivers/:id | drivers.ts:211 | Update driver |
| DELETE /api/drivers/:id | drivers.ts:300 | Delete driver |

### /api/lorries (`src/api/routes/lorries.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/lorries | lorries.ts:47 | List lorries |
| POST /api/lorries | lorries.ts:59 | Create lorry |
| PUT /api/lorries | lorries.ts:103 | Bulk update lorries |
| GET /api/lorries/:id | lorries.ts:159 | Get lorry |
| PUT /api/lorries/:id | lorries.ts:171 | Update lorry |
| DELETE /api/lorries/:id | lorries.ts:229 | Delete lorry |

### /api/three-pl-vehicles (`src/api/routes/three-pl-vehicles.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/three-pl-vehicles | three-pl-vehicles.ts:140 | List 3PL vehicles |
| POST /api/three-pl-vehicles | three-pl-vehicles.ts:156 | Create 3PL vehicle |
| GET /api/three-pl-vehicles/:id | three-pl-vehicles.ts:230 | Get 3PL vehicle |
| PUT /api/three-pl-vehicles/:id | three-pl-vehicles.ts:245 | Update 3PL vehicle |
| DELETE /api/three-pl-vehicles/:id | three-pl-vehicles.ts:350 | Delete 3PL vehicle |

### /api/three-pl-drivers (`src/api/routes/three-pl-drivers.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/three-pl-drivers | three-pl-drivers.ts:57 | List 3PL drivers |
| POST /api/three-pl-drivers | three-pl-drivers.ts:72 | Create 3PL driver |
| GET /api/three-pl-drivers/:id | three-pl-drivers.ts:128 | Get 3PL driver |
| PUT /api/three-pl-drivers/:id | three-pl-drivers.ts:142 | Update 3PL driver |
| DELETE /api/three-pl-drivers/:id | three-pl-drivers.ts:199 | Delete 3PL driver |

### /api/three-pl-state-rates (`src/api/routes/three-pl-state-rates.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/three-pl-state-rates | three-pl-state-rates.ts:173 | List 3PL state rates |
| PUT /api/three-pl-state-rates/bulk | three-pl-state-rates.ts:191 | Bulk-update state rates |

### /api/delivery-agent (`src/api/routes/delivery-agent.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/delivery-agent/brief.json | delivery-agent.ts:138 | TMS agent brief |
| POST /api/delivery-agent/proposals/generate | delivery-agent.ts:159 | Generate delivery proposals |
| GET /api/delivery-agent/proposals | delivery-agent.ts:180 | List proposals |
| POST /api/delivery-agent/proposals/approve | delivery-agent.ts:254 | Approve proposal |
| POST /api/delivery-agent/proposals/reject | delivery-agent.ts:267 | Reject proposal |
| POST /api/delivery-agent/run | delivery-agent.ts:346 | Run agent (session) |
| GET /api/delivery-agent/truck-capacity-analysis | delivery-agent.ts:445 | Truck capacity analysis |

_Internal (mounted /api/internal/delivery-agent, CRON_SECRET-gated):_
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/internal/delivery-agent/run-trigger | delivery-agent.ts:401 | Cron trigger for agent run |

---

## Consignment

### /api/consignments (`src/api/routes/consignments.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/consignments | consignments.ts:33 | List consignments |
| POST /api/consignments | consignments.ts:73 | Create consignment |
| GET /api/consignments/:id | consignments.ts:301 | Get consignment |
| PUT /api/consignments/:id | consignments.ts:327 | Update consignment |
| DELETE /api/consignments/:id | consignments.ts:479 | Delete consignment |

### /api/consignment-orders (`src/api/routes/consignment-orders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/consignment-orders | consignment-orders.ts:451 | List consignment orders |
| POST /api/consignment-orders | consignment-orders.ts:532 | Create consignment order |
| GET /api/consignment-orders/stats | consignment-orders.ts:846 | CO stats |
| GET /api/consignment-orders/status-changes | consignment-orders.ts:889 | CO status-change feed |
| GET /api/consignment-orders/:id/edit-eligibility | consignment-orders.ts:938 | CO edit eligibility |
| POST /api/consignment-orders/:id/override-edit-lock | consignment-orders.ts:1058 | Override CO edit lock |
| GET /api/consignment-orders/:id | consignment-orders.ts:1229 | Get consignment order |
| POST /api/consignment-orders/:id/confirm | consignment-orders.ts:1345 | Confirm consignment order |
| PUT /api/consignment-orders/:id | consignment-orders.ts:1460 | Update consignment order |
| POST /api/consignment-orders/:id/cancel | consignment-orders.ts:2045 | Cancel consignment order |
| PATCH /api/consignment-orders/:id/hub | consignment-orders.ts:2188 | Change CO hub |
| DELETE /api/consignment-orders/:id | consignment-orders.ts:2520 | Delete consignment order |

### /api/consignment-notes (`src/api/routes/consignment-notes.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/consignment-notes | consignment-notes.ts:67 | List consignment notes |
| GET /api/consignment-notes/linked-po-ids | consignment-notes.ts:169 | Linked PO ids |
| GET /api/consignment-notes/ready-planning | consignment-notes.ts:201 | Ready-for-planning list |
| GET /api/consignment-notes/stats | consignment-notes.ts:438 | CN stats |
| GET /api/consignment-notes/:id/print-extras | consignment-notes.ts:510 | CN print extras |
| POST /api/consignment-notes | consignment-notes.ts:740 | Create consignment note |
| POST /api/consignment-notes/:id/return | consignment-notes.ts:1015 | Process CN return |
| POST /api/consignment-notes/:id/convert-to-invoice | consignment-notes.ts:1334 | Convert CN to invoice |
| POST /api/consignment-notes/:id/notify-customer | consignment-notes.ts:1658 | Notify customer |
| PATCH /api/consignment-notes | consignment-notes.ts:1939 | Bulk-patch consignment notes |
| PUT /api/consignment-notes/:id | consignment-notes.ts:1990 | Update consignment note |

### /api/cn-packing-lists (`src/api/routes/cn-packing-lists.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/cn-packing-lists | cn-packing-lists.ts:381 | List CN packing lists |
| GET /api/cn-packing-lists/:id | cn-packing-lists.ts:425 | Get CN packing list |
| POST /api/cn-packing-lists | cn-packing-lists.ts:662 | Create CN packing list |
| DELETE /api/cn-packing-lists/:id | cn-packing-lists.ts:695 | Delete CN packing list |

---

## QC (Quality Control)

### /api/qc-templates (`src/api/routes/qc-templates.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/qc-templates | qc-templates.ts:89 | List QC checklist templates |
| GET /api/qc-templates/:id | qc-templates.ts:128 | Get QC template |
| POST /api/qc-templates | qc-templates.ts:143 | Create QC template |
| PUT /api/qc-templates/:id | qc-templates.ts:223 | Update QC template |
| DELETE /api/qc-templates/:id | qc-templates.ts:311 | Delete QC template |

### /api/qc-pending (`src/api/routes/qc-pending.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/qc-pending | qc-pending.ts:321 | List pending QC slots |
| POST /api/qc-pending/trigger | qc-pending.ts:368 | Cron: generate pending slots |
| POST /api/qc-pending/generate-now | qc-pending.ts:400 | Manually generate slots |
| POST /api/qc-pending/:id/start | qc-pending.ts:418 | Start QC inspection |
| POST /api/qc-pending/:id/skip | qc-pending.ts:445 | Skip QC slot |
| POST /api/qc-pending/:id/complete | qc-pending.ts:489 | Complete QC slot |
| DELETE /api/qc-pending/:id | qc-pending.ts:725 | Delete QC slot |

### /api/qc-inspections (`src/api/routes/qc-inspections.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/qc-inspections | qc-inspections.ts:157 | List QC inspections |
| POST /api/qc-inspections | qc-inspections.ts:228 | Create QC inspection |
| GET /api/qc-inspections/:id | qc-inspections.ts:309 | Get QC inspection |
| PUT /api/qc-inspections/:id | qc-inspections.ts:332 | Update QC inspection |
| DELETE /api/qc-inspections/:id | qc-inspections.ts:418 | Delete QC inspection |

---

## R&D

### /api/rd-projects (`src/api/routes/rd-projects.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/rd-projects | rd-projects.ts:356 | List R&D projects |
| POST /api/rd-projects | rd-projects.ts:383 | Create R&D project |
| GET /api/rd-projects/:id | rd-projects.ts:518 | Get R&D project |
| PUT /api/rd-projects/:id | rd-projects.ts:543 | Update R&D project |
| POST /api/rd-projects/:id/start | rd-projects.ts:796 | Start project |
| POST /api/rd-projects/:id/hold | rd-projects.ts:862 | Hold project |
| POST /api/rd-projects/:id/resume | rd-projects.ts:915 | Resume project |
| POST /api/rd-projects/:id/complete | rd-projects.ts:976 | Complete project |
| POST /api/rd-projects/:id/move-to-draft | rd-projects.ts:1038 | Move project to draft |
| POST /api/rd-projects/:id/reopen | rd-projects.ts:1098 | Reopen project |
| POST /api/rd-projects/:id/issue-material | rd-projects.ts:1157 | Issue material to project |
| GET /api/rd-projects/:id/issuances | rd-projects.ts:1373 | List material issuances |
| POST /api/rd-projects/:id/issuances | rd-projects.ts:1403 | Create issuance |
| POST /api/rd-projects/:id/issuances/batch | rd-projects.ts:1555 | Batch material issuances |
| DELETE /api/rd-projects/:id/issuances/:issuanceId | rd-projects.ts:1807 | Delete issuance |
| POST /api/rd-projects/:id/labour-log | rd-projects.ts:1896 | Log labour |
| GET /api/rd-projects/:id/labour-hours | rd-projects.ts:2013 | List labour hours |
| POST /api/rd-projects/:id/labour-hours | rd-projects.ts:2048 | Add labour hours |
| DELETE /api/rd-projects/:id/labour-hours/:logId | rd-projects.ts:2147 | Delete labour-hours log |
| PATCH /api/rd-projects/:id/labour-cost | rd-projects.ts:2172 | Update labour cost |
| DELETE /api/rd-projects/:id | rd-projects.ts:2237 | Delete R&D project |

### /api/rd-team-members (`src/api/routes/rd-team-members.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/rd-team-members | rd-team-members.ts:61 | List R&D team members |
| POST /api/rd-team-members | rd-team-members.ts:77 | Add team member |
| PUT /api/rd-team-members/:id | rd-team-members.ts:180 | Update team member |
| DELETE /api/rd-team-members/:id | rd-team-members.ts:275 | Remove team member |

---

## HR: Payroll, Attendance & Time

### /api/attendance (`src/api/routes/attendance.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/attendance | attendance.ts:121 | List attendance / punches |
| DELETE /api/attendance/:id | attendance.ts:154 | Delete punch |
| GET /api/attendance/:id/photo | attendance.ts:176 | Punch photo |
| POST /api/attendance | attendance.ts:222 | Create attendance entry |

### /api/working-hour-entries (`src/api/routes/working-hour-entries.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/working-hour-entries/production-revenue | working-hour-entries.ts:199 | Production revenue by hours |
| GET /api/working-hour-entries/summary | working-hour-entries.ts:491 | Working-hours summary |
| GET /api/working-hour-entries/dept-category-summary | working-hour-entries.ts:603 | Dept/category summary |
| GET /api/working-hour-entries/daily-breakdown | working-hour-entries.ts:691 | Daily hours breakdown |
| GET /api/working-hour-entries | working-hour-entries.ts:862 | List working-hour entries |
| POST /api/working-hour-entries | working-hour-entries.ts:898 | Create entry |
| POST /api/working-hour-entries/bulk | working-hour-entries.ts:963 | Bulk-create entries |
| PUT /api/working-hour-entries/:id | working-hour-entries.ts:1033 | Update entry |
| DELETE /api/working-hour-entries/:id | working-hour-entries.ts:1079 | Delete entry |
| GET /api/working-hour-entries/nonprod-requests | working-hour-entries.ts:1152 | List non-prod requests |
| POST /api/working-hour-entries/nonprod-requests/:id/approve | working-hour-entries.ts:1190 | Approve non-prod request |
| POST /api/working-hour-entries/nonprod-requests/:id/reject | working-hour-entries.ts:1438 | Reject non-prod request |
| POST /api/working-hour-entries/nonprod-requests/:id/remove | working-hour-entries.ts:1504 | Remove non-prod request |

### /api/payroll-hour-deductions (`src/api/routes/payroll-hour-deductions.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/payroll-hour-deductions | payroll-hour-deductions.ts:64 | List hour deductions |
| POST /api/payroll-hour-deductions | payroll-hour-deductions.ts:85 | Create hour deduction |
| POST /api/payroll-hour-deductions/auto-from-punch | payroll-hour-deductions.ts:149 | Auto-deduct from punches |
| POST /api/payroll-hour-deductions/settle-period | payroll-hour-deductions.ts:211 | Settle period deductions |
| DELETE /api/payroll-hour-deductions/:id | payroll-hour-deductions.ts:391 | Delete hour deduction |

### /api/payroll (`src/api/routes/payroll.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/payroll | payroll.ts:119 | List payroll runs |
| POST /api/payroll | payroll.ts:137 | Create payroll run |
| PUT /api/payroll | payroll.ts:248 | Update payroll run |

### /api/pay-rules (`src/api/routes/pay-rules.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/pay-rules | pay-rules.ts:48 | List pay rules |
| POST /api/pay-rules | pay-rules.ts:64 | Create pay rule |
| DELETE /api/pay-rules/:id | pay-rules.ts:107 | Delete pay rule |

### /api/payslips (`src/api/routes/payslips.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/payslips | payslips.ts:339 | List payslips |
| GET /api/payslips/projected | payslips.ts:406 | Projected payslip |
| POST /api/payslips | payslips.ts:642 | Generate payslips |
| PUT /api/payslips | payslips.ts:998 | Update payslip |
| GET /api/payslips/:id | payslips.ts:1027 | Get payslip |

### /api/leaves (`src/api/routes/leaves.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/leaves | leaves.ts:53 | List leave requests |
| POST /api/leaves | leaves.ts:76 | Create leave request |
| PUT /api/leaves | leaves.ts:137 | Bulk update leaves |
| PUT /api/leaves/:id | leaves.ts:175 | Update leave |
| DELETE /api/leaves/:id | leaves.ts:229 | Delete leave |

---

## Org, Departments, Workers & Equipment

### /api/organisations (`src/api/routes/organisations.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/organisations | organisations.ts:215 | List organisations |
| POST /api/organisations | organisations.ts:241 | Create organisation |
| PATCH /api/organisations/:id | organisations.ts:327 | Update organisation |
| DELETE /api/organisations/:id | organisations.ts:428 | Delete organisation |
| PUT /api/organisations | organisations.ts:453 | Bulk update organisations |

### /api/departments (`src/api/routes/departments.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/departments | departments.ts:103 | List departments |
| POST /api/departments | departments.ts:114 | Create department |
| PUT /api/departments/:id | departments.ts:219 | Update department |
| DELETE /api/departments/:id | departments.ts:338 | Delete department |

### /api/department-performance (`src/api/routes/department-performance.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/department-performance | department-performance.ts:89 | Department KPI feed |

### /api/workers (`src/api/routes/workers.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/workers | workers.ts:139 | List workers |
| POST /api/workers | workers.ts:163 | Create worker |
| GET /api/workers/:id | workers.ts:304 | Get worker |
| PUT /api/workers/:id | workers.ts:318 | Update worker |
| DELETE /api/workers/:id | workers.ts:616 | Delete worker |
| POST /api/workers/:id/set-pin | workers.ts:731 | Set worker PIN |
| POST /api/workers/bulk-generate-pins | workers.ts:807 | Bulk-generate PINs |
| GET /api/workers/:id/salary-history | workers.ts:918 | Worker salary history |
| POST /api/workers/:id/salary-history | workers.ts:939 | Add salary-history row |
| GET /api/workers/salary/effective | workers.ts:980 | Effective salary lookup |
| DELETE /api/workers/:id/salary-history/:rowId | workers.ts:1035 | Delete salary-history row |

### /api/equipment (`src/api/routes/equipment.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/equipment | equipment.ts:90 | List equipment |
| POST /api/equipment | equipment.ts:102 | Create equipment |
| GET /api/equipment/:id | equipment.ts:144 | Get equipment |
| PUT /api/equipment/:id | equipment.ts:167 | Update equipment |
| DELETE /api/equipment/:id | equipment.ts:292 | Delete equipment |

### /api/maintenance-logs (`src/api/routes/maintenance-logs.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/maintenance-logs | maintenance-logs.ts:49 | List maintenance logs |
| POST /api/maintenance-logs | maintenance-logs.ts:64 | Create maintenance log |
| GET /api/maintenance-logs/:id | maintenance-logs.ts:115 | Get maintenance log |
| DELETE /api/maintenance-logs/:id | maintenance-logs.ts:132 | Delete maintenance log |

### /api/wip-times (`src/api/routes/wip-times.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/wip-times | wip-times.ts:113 | WIP catalog times |
| PUT /api/wip-times | wip-times.ts:216 | Update WIP times |
| POST /api/wip-times/bulk-import | wip-times.ts:376 | Bulk-import WIP times |

---

## Communications (Mail, Announcements, Notifications)

### /api/mail-center (`src/api/routes/mail-center.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/mail-center/threads | mail-center.ts:921 | List mail threads |
| GET /api/mail-center/threads/:id | mail-center.ts:985 | Get thread |
| GET /api/mail-center/outbox | mail-center.ts:1126 | List outbox emails |
| GET /api/mail-center/outbox/:id | mail-center.ts:1218 | Get outbox email |
| GET /api/mail-center/outbox/:id/attachments/:idx/download | mail-center.ts:1271 | Download outbox attachment |
| GET /api/mail-center/addresses | mail-center.ts:1342 | List mail addresses |
| GET /api/mail-center/labels | mail-center.ts:1418 | List labels |
| POST /api/mail-center/labels | mail-center.ts:1433 | Create label |
| PATCH /api/mail-center/labels/:id | mail-center.ts:1486 | Update label |
| DELETE /api/mail-center/labels/:id | mail-center.ts:1555 | Delete label |
| POST /api/mail-center/test-inject | mail-center.ts:1620 | Inject test email |
| POST /api/mail-center/addresses | mail-center.ts:1661 | Create mail address |
| PATCH /api/mail-center/addresses/:id | mail-center.ts:1739 | Update mail address |
| GET /api/mail-center/access | mail-center.ts:1814 | List mailbox access |
| POST /api/mail-center/access | mail-center.ts:1840 | Grant mailbox access |
| DELETE /api/mail-center/access | mail-center.ts:1878 | Revoke mailbox access |
| GET /api/mail-center/scope-levels | mail-center.ts:1910 | List scope levels |
| PUT /api/mail-center/scope-level | mail-center.ts:1939 | Set scope level |
| POST /api/mail-center/threads/:id/reply | mail-center.ts:2021 | Reply in thread |
| POST /api/mail-center/compose | mail-center.ts:2200 | Compose new email |
| PATCH /api/mail-center/threads/:id | mail-center.ts:2348 | Update thread |

_(Public inbound ingestion `POST /api/mail-center/inbound` is inline in worker.ts:810 — see Inline endpoints.)_

### /api/announcements (admin) (`src/api/routes/announcements.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/announcements | announcements.ts:459 | List announcements (admin) |
| GET /api/announcements/:id/acks | announcements.ts:479 | Acknowledgement list |
| POST /api/announcements | announcements.ts:550 | Create announcement |
| PATCH /api/announcements/:id | announcements.ts:667 | Update announcement |
| POST /api/announcements/:id/remind | announcements.ts:820 | Remind non-acknowledgers |
| DELETE /api/announcements/:id | announcements.ts:887 | Delete announcement |

### /api/worker/announcements (worker) (`src/api/routes/announcements.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/worker/announcements | announcements.ts:1001 | Worker-facing announcements |
| POST /api/worker/announcements/:id/ack | announcements.ts:1097 | Acknowledge announcement |

### /api/notifications (`src/api/routes/notifications.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/notifications | notifications.ts:43 | List notifications |
| PUT /api/notifications | notifications.ts:68 | Mark notifications read |

### /api/push (`src/api/routes/push.ts`)
_Mounted BEFORE the auth gate; handlers self-auth (worker token / push secret)._
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/push/vapid-public-key | push.ts:106 | Public VAPID key |
| POST /api/push/subscribe | push.ts:119 | Subscribe to push |
| POST /api/push/unsubscribe | push.ts:179 | Unsubscribe from push |
| POST /api/push/clock-reminder | push.ts:209 | Cron: send clock reminders |

---

## Agents & AI Assistant

### /api/agents (`src/api/routes/agent-console.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/agents/status | agent-console.ts:164 | Agent status console |
| GET /api/agents/review | agent-console.ts:386 | Agent review queue |
| POST /api/agents/run-now | agent-console.ts:538 | Run agent now |
| POST /api/agents/pause | agent-console.ts:679 | Pause agent |
| POST /api/agents/kill-all | agent-console.ts:706 | Kill all agent runs |
| POST /api/agents/gate | agent-console.ts:733 | Set approval gate |
| POST /api/agents/phase | agent-console.ts:763 | Set agent phase |
| POST /api/agents/rollback-last-batch | agent-console.ts:815 | Rollback last batch |
| GET /api/agents/config-proposals | agent-console.ts:925 | List config proposals |
| POST /api/agents/config-proposals/decide | agent-console.ts:955 | Decide config proposal |

### /api/internal/agents (`src/api/routes/agent-heartbeat.ts`)
_CRON_SECRET-gated heartbeat behind agent self-scheduling._
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/internal/agents/run-generate | agent-heartbeat.ts:54 | Generate scheduled agent runs |
| POST /api/internal/agents/heartbeat | agent-heartbeat.ts:79 | Agent scheduler heartbeat |

### /api/assistant (`src/api/routes/assistant.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/assistant/chat | assistant.ts:495 | Streaming AI assistant chat |

### /api/assistant/conversations (`src/api/routes/assistant-history.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/assistant/conversations | assistant-history.ts:88 | List conversations |
| GET /api/assistant/conversations/:id | assistant-history.ts:113 | Get conversation |
| PUT /api/assistant/conversations/:id | assistant-history.ts:141 | Update conversation |
| PATCH /api/assistant/conversations/:id | assistant-history.ts:205 | Patch conversation |
| DELETE /api/assistant/conversations/:id | assistant-history.ts:235 | Delete conversation |

---

## Scanning / OCR

### /api/scan-po (`src/api/routes/scan-po.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/scan-po/catalog | scan-po.ts:477 | OCR catalog lookup |
| POST /api/scan-po/extract | scan-po.ts:516 | Extract customer PO via AI |
| POST /api/scan-po/samples/:id/confirm | scan-po.ts:678 | Confirm scan sample |
| GET /api/scan-po/samples/by-po/:poIdentifier | scan-po.ts:778 | Samples by PO |
| PATCH /api/scan-po/samples/by-po/:poIdentifier | scan-po.ts:835 | Update samples by PO |
| GET /api/scan-po/customer-rules/:customerId | scan-po.ts:877 | Customer OCR rules |
| PUT /api/scan-po/customer-rules/:customerId | scan-po.ts:908 | Update customer OCR rules |
| POST /api/scan-po/customer-rules/:customerId/distill | scan-po.ts:964 | Distill customer OCR rules |

### /api/scan-supplier (`src/api/routes/scan-supplier.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/scan-supplier/extract | scan-supplier.ts:36 | Extract supplier doc via AI |
| POST /api/scan-supplier/samples/:id/confirm | scan-supplier.ts:127 | Confirm supplier sample |

### /api/scan-finance (`src/api/routes/scan-finance.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/scan-finance/extract | scan-finance.ts:54 | Extract finance doc via AI |

### /api/scan-queue (`src/api/routes/scan-queue.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/scan-queue/upload | scan-queue.ts:671 | Queue files for async OCR |
| GET /api/scan-queue/batch/:batchId | scan-queue.ts:849 | Batch status |
| GET /api/scan-queue/pending | scan-queue.ts:928 | Pending queue items |
| GET /api/scan-queue/:id | scan-queue.ts:1052 | Get queue item |
| GET /api/scan-queue/:id/bytes | scan-queue.ts:1111 | Stashed file bytes |
| POST /api/scan-queue/:id/retry | scan-queue.ts:1171 | Retry queue item |
| POST /api/scan-queue/:id/consume | scan-queue.ts:1243 | Consume queue result |

### /api/ocr-accuracy (`src/api/routes/ocr-accuracy.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/ocr-accuracy | ocr-accuracy.ts:61 | OCR accuracy metrics |

---

## Service Orders

### /api/service-cases (`src/api/routes/service-cases.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/service-cases | service-cases.ts:480 | List service cases |
| GET /api/service-cases/:id | service-cases.ts:517 | Get service case |
| POST /api/service-cases | service-cases.ts:564 | Create service case |
| PUT /api/service-cases/:id | service-cases.ts:707 | Update service case |
| PUT /api/service-cases/:id/status | service-cases.ts:881 | Change case status |
| DELETE /api/service-cases/:id | service-cases.ts:934 | Delete service case |

### /api/service-orders (`src/api/routes/service-orders.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/service-orders | service-orders.ts:315 | List service orders |
| GET /api/service-orders/:id | service-orders.ts:353 | Get service order |
| POST /api/service-orders | service-orders.ts:433 | Create service order |
| PUT /api/service-orders/:id | service-orders.ts:784 | Update service order |
| PUT /api/service-orders/:id/status | service-orders.ts:859 | Change SO status |
| PUT /api/service-orders/:id/mode | service-orders.ts:978 | Set resolution mode |
| POST /api/service-orders/:id/returns | service-orders.ts:1193 | Create service return |
| PUT /api/service-orders/:id/returns/:rid | service-orders.ts:1278 | Update service return |
| POST /api/service-orders/:id/returns/:rid/scrap | service-orders.ts:1384 | Scrap returned item |
| DELETE /api/service-orders/:id | service-orders.ts:1542 | Delete service order |

---

## Reports, Dashboard, Health & Admin

### /api/reports (`src/api/routes/reports.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/reports/efficiency | reports.ts:280 | Efficiency report (HTML) |
| GET /api/reports/efficiency.json | reports.ts:314 | Efficiency report (JSON) |
| GET /api/reports/operations.json | reports.ts:340 | Operations report (JSON) |
| POST /api/reports/efficiency/send | reports.ts:369 | Email efficiency report |
| GET /api/reports/schedule | reports.ts:379 | Schedule report (HTML) |
| GET /api/reports/schedule.json | reports.ts:398 | Schedule report (JSON) |
| GET /api/reports/overdue | reports.ts:415 | Overdue report (HTML) |
| GET /api/reports/overdue.json | reports.ts:434 | Overdue report (JSON) |
| GET /api/reports/brief | reports.ts:484 | Morning brief (HTML) |
| GET /api/reports/brief.json | reports.ts:503 | Morning brief (JSON) |
| POST /api/reports/brief/send | reports.ts:517 | Email morning brief |
| GET /api/reports/compliance.json | reports.ts:529 | Compliance report (JSON) |
| POST /api/reports/schedule/send | reports.ts:810 | Email schedule report |
| POST /api/reports/overdue/send | reports.ts:815 | Email overdue report |

_Internal (mounted /api/internal/reports, CRON_SECRET-gated):_
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/internal/reports/efficiency-trigger | reports.ts:771 | Cron: efficiency report |
| POST /api/internal/reports/schedule-trigger | reports.ts:777 | Cron: schedule report |
| POST /api/internal/reports/overdue-trigger | reports.ts:783 | Cron: overdue report |
| POST /api/internal/reports/brief-trigger | reports.ts:789 | Cron: morning brief |

### /api/dashboard/overview (`src/api/routes/dashboard-overview.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/dashboard/overview | dashboard-overview.ts:49 | Dashboard overview (cache-aside) |

### /api/admin (`src/api/routes/admin.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/admin/archive/run | admin.ts:152 | Run archive maintenance |
| POST /api/admin/rebuild-all-pos | admin.ts:560 | Rebuild all production orders |
| POST /api/admin/rebuild-pos/:soId | admin.ts:664 | Rebuild POs for one SO |
| POST /api/admin/ensure-perf-indexes | admin.ts:798 | Ensure performance indexes |
| POST /api/admin/dedupe-invoices | admin.ts:834 | Dedupe invoices |
| POST /api/admin/backfill-so-prices | admin.ts:969 | Backfill SO prices |
| POST /api/admin/backfill-invoice-prices | admin.ts:1078 | Backfill invoice prices |
| GET /api/admin/backfill-special-order-surcharge | admin.ts:1297 | Preview special-order surcharge |
| POST /api/admin/backfill-invoice-po-link | admin.ts:1474 | Backfill invoice↔PO links |
| GET /api/admin/backfill-invoiced-plan | admin.ts:1800 | Preview invoiced backfill |
| POST /api/admin/backfill-special-order-surcharge | admin.ts:1852 | Apply special-order surcharge |

### /api/admin/health (`src/api/routes/admin-health.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/admin/health/kpis-diag | admin-health.ts:379 | KPI diagnostics |
| GET /api/admin/health/kpis | admin-health.ts:447 | Health KPIs |
| GET /api/admin/health/by-endpoint | admin-health.ts:527 | Latency by endpoint |
| GET /api/admin/health/errors-by-endpoint | admin-health.ts:610 | Errors by endpoint |
| GET /api/admin/health/errors-hourly | admin-health.ts:679 | Hourly error counts |
| GET /api/admin/health/status-breakdown | admin-health.ts:732 | HTTP status breakdown |
| GET /api/admin/health/error-messages | admin-health.ts:763 | Recent error messages |
| GET /api/admin/health/daily-trend | admin-health.ts:816 | Daily traffic trend |
| GET /api/admin/health/deploys | admin-health.ts:893 | Deploy history |
| GET /api/admin/health/github-runs | admin-health.ts:943 | GitHub Actions runs |
| GET /api/admin/health/slow-sql | admin-health.ts:1032 | Slow SQL queries |
| GET /api/admin/health/long-tasks | admin-health.ts:1105 | Long-running tasks |
| GET /api/admin/health/audit-feed | admin-health.ts:1151 | Audit event feed |
| GET /api/admin/health/security-events | admin-health.ts:1274 | Security events |
| GET /api/admin/health/fe-errors | admin-health.ts:1465 | Frontend JS errors (RUM) |
| GET /api/admin/health/fe-perf | admin-health.ts:1512 | Frontend Web Vitals |
| GET /api/admin/health/fe-api | admin-health.ts:1580 | Frontend API timing |
| GET /api/admin/health/fe-stuck | admin-health.ts:1668 | Frontend stuck sessions |

### /api/fe-rum (`src/api/routes/fe-rum.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/fe-rum/event | fe-rum.ts:98 | Ingest frontend RUM events |

### /api/audit-events (`src/api/routes/audit-events.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/audit-events | audit-events.ts:47 | Universal audit-event read |

### /api/mdm (`src/api/routes/mdm.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/mdm/review-queue | mdm.ts:89 | Duplicate review queue |
| POST /api/mdm/review-queue/:id/dismiss | mdm.ts:198 | Dismiss duplicate |
| POST /api/mdm/review-queue/:id/merge | mdm.ts:212 | Merge duplicates |
| POST /api/mdm/detection/run | mdm.ts:232 | Run duplicate detection |

---

## Files, Config & Integrations

### /api/files (`src/api/routes/files.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/files | files.ts:219 | Upload file asset |
| GET /api/files | files.ts:376 | List file assets |
| PATCH /api/files/:id/cover | files.ts:407 | Set cover image |
| GET /api/files/:id | files.ts:431 | Get file asset |
| GET /api/files/:id/download | files.ts:446 | Download file |
| GET /api/files/:id/stream | files.ts:485 | Stream file |
| DELETE /api/files/:id | files.ts:526 | Delete file asset |

### /api/datagrid-layouts (`src/api/routes/datagrid-layouts.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/datagrid-layouts | datagrid-layouts.ts:128 | Get org grid presets |
| PUT /api/datagrid-layouts | datagrid-layouts.ts:163 | Save org grid preset |
| DELETE /api/datagrid-layouts | datagrid-layouts.ts:252 | Delete grid preset |

### /api/kv-config (`src/api/routes/kv-config.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/kv-config/:key | kv-config.ts:27 | Get KV config value |
| PUT /api/kv-config/:key | kv-config.ts:56 | Set KV config value |

### /api/maintenance-config (`src/api/routes/maintenance-config.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/maintenance-config/resolved | maintenance-config.ts:120 | Resolved maintenance config |
| GET /api/maintenance-config/history | maintenance-config.ts:141 | Config change history |
| POST /api/maintenance-config/changes | maintenance-config.ts:174 | Add config change |
| DELETE /api/maintenance-config/changes/:id | maintenance-config.ts:227 | Delete config change |

### /api/sheets-sync (`src/api/routes/sheets-sync.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/sheets-sync/apps-script-webhook | sheets-sync.ts:55 | Sheets→ERP webhook (HMAC) |
| POST /api/sheets-sync/backfill | sheets-sync.ts:293 | ERP→Sheets backfill |

---

## Worker Portal (`/api/worker`, worker-token auth)

### /api/worker (`src/api/routes/worker.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/worker/ann-files/:id/download | worker.ts:304 | Download announcement file |
| GET /api/worker/today | worker.ts:359 | Today's worker dashboard |
| GET /api/worker/wip-times | worker.ts:529 | WIP times reference |
| GET /api/worker/current-dept | worker.ts:579 | Current department |
| GET /api/worker/scan-lookup | worker.ts:605 | Scan token lookup |
| GET /api/worker/racks | worker.ts:796 | Worker rack list |
| POST /api/worker/packing-rack | worker.ts:821 | Assign packing rack |
| POST /api/worker/clock | worker.ts:996 | Clock in/out punch |
| POST /api/worker/dept-scan | worker.ts:1225 | Department scan complete |
| GET /api/worker/history | worker.ts:1291 | Worker punch history |
| GET /api/worker/payslips | worker.ts:1818 | Worker payslips |
| GET /api/worker/leaves | worker.ts:2095 | Worker leave list |
| POST /api/worker/leaves | worker.ts:2157 | Submit leave request |
| POST /api/worker/issues | worker.ts:2220 | Report an issue |
| GET /api/worker/issues | worker.ts:2254 | List reported issues |
| PATCH /api/worker/profile | worker.ts:2270 | Update worker profile |
| GET /api/worker/nonprod-departments | worker.ts:2427 | Non-prod departments |
| GET /api/worker/production-departments | worker.ts:2456 | Production departments |
| GET /api/worker/nonprod-requests | worker.ts:2480 | List non-prod requests |
| POST /api/worker/nonprod-requests | worker.ts:2507 | Submit non-prod request |
| GET /api/worker/team-stats | worker.ts:2623 | Team stats (leader) |
| GET /api/worker/department-performance | worker.ts:2929 | Dept performance (leader) |
| POST /api/worker/rack-bulk-stock-in | worker.ts:3439 | Bulk rack stock-in |

---

## Public QR Flows (no login — token IS the credential)

### /api/public/do-qr (`src/api/routes/public-do-qr.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/public/do-qr/:token/edit | public-do-qr.ts:610 | DO QR edit view |
| GET /api/public/do-qr/:token | public-do-qr.ts:659 | Resolve DO by QR token |
| POST /api/public/do-qr/:token/advance | public-do-qr.ts:707 | Advance DO status (dispatch/deliver) |

### /api/public/rack-qr (`src/api/routes/public-rack-qr.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/public/rack-qr/:rackId | public-rack-qr.ts:526 | Resolve rack by id |
| GET /api/public/rack-qr/:rackId/item | public-rack-qr.ts:600 | Rack item lookup |
| POST /api/public/rack-qr/:rackId/stock-in | public-rack-qr.ts:776 | Public rack stock-in |

### /api/public/rack-write (`src/api/routes/public-rack-write.ts`)
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/public/rack-write/:token | public-rack-write.ts:179 | Resolve packing card by token |
| POST /api/public/rack-write/:token/rack | public-rack-write.ts:228 | Set/clear rack on packing card |

---

## Data Import & Backfill Toolbox (`/api/import`, super-admin one-shots)

### /api/import (`src/api/routes/import-completion.ts`)
One-shot historical-migration / backfill / audit endpoints (super-admin, gated). Mostly run-once operations; keep for provenance.
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| POST /api/import/job-card-completion | import-completion.ts:695 | Import historical JC completions |
| POST /api/import/clear-future-completions | import-completion.ts:792 | Clear future completions |
| POST /api/import/cascade-upstream-completion | import-completion.ts:1010 | Cascade upstream completions |
| POST /api/import/uph-pofold-backfill | import-completion.ts:1583 | Backfill UPH pofold |
| POST /api/import/sync-maintenance-history-from-kv | import-completion.ts:1871 | Sync maintenance history from KV |
| POST /api/import/cleanup-snapshot-from-master-rows | import-completion.ts:1989 | Cleanup snapshot from masters |
| POST /api/import/derive-historical-price-baselines | import-completion.ts:2098 | Derive price baselines |
| POST /api/import/fab-cut-pofold-backfill | import-completion.ts:2428 | Backfill fab-cut pofold |
| POST /api/import/fix-misparsed-jan-dates | import-completion.ts:2777 | Fix misparsed Jan dates |
| POST /api/import/cascade-leak-pass | import-completion.ts:3014 | Cascade leak pass |
| POST /api/import/fix-misparsed-dates | import-completion.ts:3347 | Fix misparsed dates |
| POST /api/import/refund-backfill-overconsume | import-completion.ts:3540 | Refund over-consumed materials |
| POST /api/import/normalize-fullwidth-parens | import-completion.ts:3834 | Normalize fullwidth parens |
| POST /api/import/dedupe-wip-items | import-completion.ts:4156 | Dedupe WIP items |
| POST /api/import/zero-out-negative-wips | import-completion.ts:4429 | Zero negative WIPs |
| POST /api/import/rebuild-wip-from-jcs | import-completion.ts:4595 | Rebuild WIP from job cards |
| POST /api/import/backfill-fab-cut-merge | import-completion.ts:5284 | Backfill fab-cut merge |
| POST /api/import/backfill-fc-label-refresh | import-completion.ts:5609 | Refresh fabric-cut labels |
| POST /api/import/backfill-split-multi-qty | import-completion.ts:5884 | Split multi-qty rows |
| POST /api/import/queen-price-correction-rm5 | import-completion.ts:6223 | Queen price correction |
| POST /api/import/cancel-leaked-co-pos | import-completion.ts:6401 | Cancel leaked CO POs |
| POST /api/import/apply-houzs-sofa-pricesheet | import-completion.ts:6673 | Apply Houzs sofa pricesheet |
| POST /api/import/recompute-so-sofa-prices | import-completion.ts:6936 | Recompute SO sofa prices |
| POST /api/import/recompute-co-sofa-prices | import-completion.ts:7449 | Recompute CO sofa prices |
| POST /api/import/resync-co-totals | import-completion.ts:7797 | Resync CO totals |
| POST /api/import/resync-so-totals | import-completion.ts:7838 | Resync SO totals |
| POST /api/import/suppliers-from-history | import-completion.ts:7910 | Create suppliers from history |
| POST /api/import/supplier-bindings-from-history | import-completion.ts:7998 | Bindings from history |
| POST /api/import/historical-purchases-backfill | import-completion.ts:8201 | Backfill historical purchases |
| POST /api/import/migrate-do-from-excel | import-completion.ts:8751 | Migrate DOs from Excel |
| POST /api/import/revert-dos-to-draft | import-completion.ts:9058 | Revert DOs to draft |
| POST /api/import/backfill-so-expected-dd | import-completion.ts:9127 | Backfill SO expected delivery |
| POST /api/import/backfill-so-item-product-name | import-completion.ts:9167 | Backfill SO item product name |
| POST /api/import/backfill-5543-co2606002 | import-completion.ts:9228 | One-off backfill (5543/CO2606002) |
| POST /api/import/create-updated-at-indexes | import-completion.ts:9380 | Create updated_at indexes |
| POST /api/import/backfill-punch-autofill-blocked | import-completion.ts:9454 | Backfill punch autofill flag |
| POST /api/import/backfill-complete-stray-jc-co2606002 | import-completion.ts:9543 | Complete stray JC (one-off) |
| POST /api/import/backfill-downstream-product-names | import-completion.ts:9631 | Backfill downstream product names |
| POST /api/import/backfill-so-reference | import-completion.ts:9716 | Backfill SO reference |
| POST /api/import/backfill-ocr-so-fields | import-completion.ts:9839 | Backfill OCR SO fields |
| POST /api/import/migrate-nonstandard-sofa-sizes | import-completion.ts:10092 | Migrate nonstandard sofa sizes |
| POST /api/import/rebuild-production-orders-from-soi | import-completion.ts:10206 | Rebuild POs from SO items |
| POST /api/import/backfill-supplier-material-bindings | import-completion.ts:10483 | Backfill supplier-material bindings |
| POST /api/import/backfill-supplier-bindings-multi | import-completion.ts:10659 | Backfill multi supplier bindings |
| POST /api/import/backfill-historical-grns | import-completion.ts:10993 | Backfill historical GRNs |
| GET /api/import/po-no-duplicates | import-completion.ts:11188 | Audit duplicate PO numbers |
| POST /api/import/audit-procurement-integrity | import-completion.ts:11227 | Audit procurement integrity |
| POST /api/import/recompute-po-status-progress | import-completion.ts:11628 | Recompute PO status/progress |
| POST /api/import/backfill-fabcut-rm-issue | import-completion.ts:11847 | Backfill fabcut RM issue |
| POST /api/import/audit-orphan-fabric-codes | import-completion.ts:11999 | Audit orphan fabric codes |
| POST /api/import/apply-fabric-code-fixes | import-completion.ts:12145 | Apply fabric-code fixes |
| POST /api/import/backfill-jc-production-time-from-bom | import-completion.ts:12400 | Backfill JC time from BOM |
| POST /api/import/refresh-jcs-by-id | import-completion.ts:12736 | Refresh job cards by id |
| POST /api/import/backfill-po-from-so-lines | import-completion.ts:13128 | Backfill PO from SO lines |
| POST /api/import/correct-so-line-qty-cascade | import-completion.ts:13439 | Correct SO line qty cascade |
| POST /api/import/delete-fg-units-by-ids | import-completion.ts:13767 | Delete FG units by id |
| POST /api/import/append-missing-pos | import-completion.ts:13876 | Append missing POs |
| POST /api/import/delete-jcs-by-ids | import-completion.ts:14018 | Delete job cards by id |
| GET /api/import/audit-po-alignment | import-completion.ts:14128 | Audit PO alignment |
| POST /api/import/backfill-po-line-no | import-completion.ts:14214 | Backfill PO line numbers |
| POST /api/import/regen-fg-units | import-completion.ts:14395 | Regenerate FG units |
| POST /api/import/backfill-sofa-leg-heights | import-completion.ts:14551 | Backfill sofa leg heights |
| POST /api/import/backfill-pillow-packing-jc | import-completion.ts:14722 | Backfill pillow packing JC |
| POST /api/import/backfill-supplier-sku-1to1 | import-completion.ts:14950 | Backfill supplier SKU 1:1 |
| POST /api/import/cleanup-headboard-only-divans | import-completion.ts:15047 | Cleanup headboard-only divans |

---

## Inline endpoints (`src/api/worker.ts`)

Public / machine-to-machine endpoints defined directly in `worker.ts` (not a mounted router). `/api/internal/*` are CRON_SECRET-gated; `/api/mail-center/inbound` is MAIL_INBOUND_SECRET-gated; `/api/qc-pending/trigger` is CRON_SECRET-gated. `/api/health` and `/api/pg-ping` are public.
| Method + Path | file:line | Purpose |
| --- | --- | --- |
| GET /api/health | worker.ts:332 | Health check |
| GET /api/pg-ping | worker.ts:346 | Postgres/Hyperdrive heartbeat |
| POST /api/internal/rebuild-dashboard-snapshot | worker.ts:385 | Cron: invalidate dashboard snapshot |
| POST /api/internal/warm-lists | worker.ts:427 | Cron: warm heavy list caches |
| POST /api/internal/process-email-outbox | worker.ts:494 | Cron: drain email outbox |
| POST /api/internal/replay-audit-dlq | worker.ts:534 | Cron: replay audit DLQ |
| POST /api/internal/nightly-pi-gl-backfill | worker.ts:571 | Cron: PI→GL backfill |
| POST /api/internal/nightly-counter-rebuild | worker.ts:600 | Cron: AR/AP counter rebuild |
| POST /api/internal/distill-ocr-rules | worker.ts:630 | Cron: distill OCR rules |
| POST /api/qc-pending/trigger | worker.ts:697 | Cron: QC pending slots |
| POST /api/internal/scan-queue-sweep | worker.ts:731 | Cron: re-queue stuck scans |
| POST /api/internal/backup-prune | worker.ts:756 | Cron: prune old backups |
| POST /api/internal/auto-clockout | worker.ts:784 | Cron: auto-clockout stale punches |
| POST /api/mail-center/inbound | worker.ts:810 | Inbound email ingestion |

---

### Regeneration note
To rebuild this index, sweep route registrations under `src/api/routes/` (paths always start with `/`):

```
rg -no '\.(get|post|put|patch|delete|all)\("/[^"]*' src/api/routes -g '!*.test.ts'
```

Use `grep -a` for `accounting.ts` (a `\0` byte in a large string literal makes ripgrep stop early — it silently truncates ~60 routes past line ~7367). Cross-reference mounts in `src/api/worker.ts` (`app.route(...)` for the base path, plus the inline `app.get/post(...)` handlers listed above).
