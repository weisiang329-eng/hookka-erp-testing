# Purchase Return module (owner 2026-07-30)

## The ask
Mirror the customer-side **Delivery Return** flow on the supplier side:
> After a Purchase Invoice / Goods Receipt (GR), I need a **Purchase Return**.
> From the GR or PI, create a Purchase Return directly → the Purchase Return can
> open a **Debit Note (DN)** to the supplier → which prompts the supplier to
> issue a **Credit Note (CN)** to me. The whole flow works like Delivery Return.

## Direction of the money (important — this moves AP + stock)
Customer side (existing): we ship → customer returns → **we issue a CN** to the
customer (we owe them / reduce their AR).

Supplier side (this module) is the mirror: we received goods → we return some to
the supplier → **we issue a Debit Note (DN)** to the supplier (they owe us /
reduce our AP to them) → the supplier confirms by issuing **their CN** to us.

Two ledgers move, and both must be right:
- **Inventory**: the returned raw materials leave our stock (reverse the GR
  receipt for the returned qty — FIFO layer aware, mirroring how a PI/GR added
  them). Never let a return drive stock negative.
- **AP**: the DN reduces what we owe the supplier (a debit against the PI). If
  the PI was already paid, the DN becomes a claim (supplier CN / refund).

Because this touches money and stock, it ships in **verifiable slices** and the
owner verifies each on staging before prod — same discipline as the RM gate.

## Mirror map (Delivery Return → Purchase Return)
| Delivery Return (customer) | Purchase Return (supplier) |
|---|---|
| `delivery_returns` header + items | `purchase_returns` header + items |
| source = DO / SO | source = **GR / PI** |
| `customer_id` / `customer_name` | `supplier_id` / `supplier_name` |
| return_no (DR-YYMM-###) | return_no (**PR-YYMM-###**) |
| spawns a **Credit Note** (we→customer) | spawns a **Debit Note** (we→supplier) |
| reduces our AR | reduces our **AP** |
| goods come back INTO stock (customer FG) | goods leave stock (**supplier RM out**) |
| status OPEN → … → CN issued | status OPEN → DN issued → supplier CN recorded |

`delivery-return-create.ts` is the single shared writer (office route + public
scan both call it) — Purchase Return gets the same shape: one
`purchase-return-create.ts` writer, tables self-applied at runtime (migration
files are inert on deploy), snake_case columns, org-scoped, RBAC-gated.

## Slices (each its own PR → staging, owner-verified)
1. **Header + items + PR numbering** — create a Purchase Return from a GR or PI
   (pick lines + qty + reason), snapshot the item detail. No ledger movement yet
   (status OPEN). Read-path only; safe to land + eyeball first.
2. **Inventory reversal** — on confirm, remove the returned qty from stock
   (reverse the GR/FIFO layer), guarded against negative stock; idempotent.
3. **Debit Note** — issue a DN to the supplier from the Purchase Return; post the
   AP reduction (debit against the source PI); record the supplier's CN when it
   arrives. Accounting review required.
4. **UI** — a Purchase Returns list + a "Create Purchase Return" action on the
   GR / PI detail, mirroring the Delivery Returns page.

## Open questions for the owner (before slice 2/3)
- When the source PI is **already paid**, should the DN produce a **refund
  claim** (supplier owes cash) or a **credit** carried against the next PI?
- Does a Purchase Return ever go back to stock at a **different cost** than it
  came in (price renegotiation), or always at the original GR cost?
- Restocking fee / partial-return handling?

## Non-negotiables
- No table reaches prod except via runtime self-apply.
- Inventory + AP writes are idempotent and never drive a balance negative.
- Structural + behavioural tests per slice; build:strict + full suite green.
- Owner verifies each slice on staging (money + stock) before prod.
