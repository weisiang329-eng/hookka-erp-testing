// ---------------------------------------------------------------------------
// supplier-binding-learn.ts — remember what a human already worked out.
//
// Owner 2026-08-04: "为什么要手动 pick 呢？… 包括之前的记录，你也可以看的，它有
// 记录的."
//
// The records existed and were being thrown away. `supplier_material_bindings`
// had exactly ONE writer — the supplier-materials maintenance page — so when an
// operator resolved a scanned line to an internal code and created the PI or
// GRN, that decision went nowhere. The same supplier document next month
// presented the same line, unrecognised, and was picked by hand again.
//
// So: when a document is created from lines that already carry BOTH the
// supplier's own wording and a resolved internal code, record the pairing. The
// next scan resolves it automatically.
//
// Deliberately conservative:
//   • never overwrite an existing binding's commercial terms — price, lead
//     time and MOQ are negotiated data, not something a scan may rewrite;
//   • only FILL IN a blank supplierSku / supplierDescription on an existing
//     row, so a binding gains the second lookup key without losing the first;
//   • a line missing either half teaches nothing and is skipped;
//   • every failure is swallowed. Learning is a side benefit of creating a
//     document — it must never be the reason a receipt or an invoice fails.
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export interface LearnableLine {
  /** Our internal material code, once the operator (or a match) resolved it. */
  materialCode?: string | null;
  materialName?: string | null;
  /** The supplier's own code for it, when their paperwork carries one. */
  supplierSku?: string | null;
  /** The supplier's own wording — the only key some suppliers ever give us. */
  supplierDescription?: string | null;
  /** Unit price in SEN, used only when creating a brand-new binding. */
  unitPriceSen?: number | null;
  /**
   * False when the internal code came from the scanner's weakest tier — text
   * matched against the whole catalogue, with no PO line and no history with
   * this supplier to corroborate it.
   *
   * Such a line may fill the field, because the operator sees it and can
   * correct it. It may NOT teach a binding: a binding resolves silently on
   * every future document and is no longer flagged as a guess, so learning a
   * wrong one converts a visible, correctable mistake into an invisible,
   * permanent one. Defaults to true — anything a human picked, a PO line
   * confirmed, or this supplier has delivered before is fair to learn.
   */
  learnable?: boolean;
}

export interface LearnResult {
  created: number;
  enriched: number;
  skipped: number;
}

interface BindingRow {
  id: string;
  supplierSku?: string | null;
  supplier_sku?: string | null;
  supplierDescription?: string | null;
  supplier_description?: string | null;
}

/**
 * Record supplier → material pairings the document just proved.
 *
 * Returns counts for logging; callers ignore them. Never throws.
 */
export async function learnSupplierBindings(
  db: DbLike,
  supplierId: string,
  lines: LearnableLine[],
  genId: () => string,
): Promise<LearnResult> {
  const out: LearnResult = { created: 0, enriched: 0, skipped: 0 };
  if (!supplierId || lines.length === 0) return out;

  // One row per material — a document may bill the same code twice.
  const byCode = new Map<string, LearnableLine>();
  for (const l of lines) {
    const code = (l.materialCode ?? "").trim();
    const sku = (l.supplierSku ?? "").trim();
    const desc = (l.supplierDescription ?? "").trim();
    // Teaching needs BOTH halves: what we call it, and what they call it.
    if (!code || (!sku && !desc)) {
      out.skipped++;
      continue;
    }
    // An uncorroborated match may fill a field but may not become a binding.
    if (l.learnable === false) {
      out.skipped++;
      continue;
    }
    if (!byCode.has(code.toUpperCase())) byCode.set(code.toUpperCase(), l);
  }
  if (byCode.size === 0) return out;

  for (const [, line] of byCode) {
    const code = (line.materialCode ?? "").trim();
    const sku = (line.supplierSku ?? "").trim();
    const desc = (line.supplierDescription ?? "").trim();
    try {
      // The code must name a material that actually exists and is active.
      //
      // A binding whose materialCode matches nothing is worse than no binding:
      // it disappears from every candidate set AND from the Internal Code
      // dropdown, while the Supplier SKU dropdown keeps listing it — so the
      // operator sees the code in one place and cannot use it in the other,
      // with nothing explaining why. Prod had 7 such rows from hand entry
      // (truncated codes, code/description swapped, a product code used as a
      // material). Without this check, learning would quietly copy each one
      // onto every future document that carried it.
      const known = await db
        .prepare(
          "SELECT item_code FROM raw_materials WHERE UPPER(REPLACE(REPLACE(item_code,' ',''),'-','')) = UPPER(REPLACE(REPLACE(?,' ',''),'-','')) AND is_active LIMIT 1",
        )
        .bind(code)
        .first<{ item_code?: string }>();
      if (!known) {
        out.skipped++;
        continue;
      }

      const existing = await db
        .prepare(
          "SELECT * FROM supplier_material_bindings WHERE supplierId = ? AND UPPER(materialCode) = UPPER(?) LIMIT 1",
        )
        .bind(supplierId, code)
        .first<BindingRow>();

      if (existing) {
        // Fill in a missing lookup key WITHOUT touching commercial terms.
        const haveSku = ((existing.supplierSku ?? existing.supplier_sku) ?? "").trim();
        const haveDesc =
          ((existing.supplierDescription ?? existing.supplier_description) ?? "").trim();
        const nextSku = haveSku || sku;
        const nextDesc = haveDesc || desc;
        if (nextSku !== haveSku || nextDesc !== haveDesc) {
          await db
            .prepare(
              "UPDATE supplier_material_bindings SET supplierSku = ?, supplierDescription = ? WHERE id = ?",
            )
            .bind(nextSku, nextDesc, existing.id)
            .run();
          out.enriched++;
        } else {
          out.skipped++;
        }
        continue;
      }

      await db
        .prepare(
          `INSERT INTO supplier_material_bindings
             (id, supplierId, materialCode, materialName, supplierSku, supplierDescription,
              unitPrice, currency, leadTimeDays, paymentTerms, moq, isMainSupplier)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'MYR', 7, 'NET30', 1, 0)`,
        )
        .bind(
          genId(),
          supplierId,
          code,
          (line.materialName ?? code).trim() || code,
          sku,
          desc,
          Math.max(0, Math.round(Number(line.unitPriceSen) || 0)),
        )
        .run();
      out.created++;
    } catch {
      // A binding that fails to save costs one future auto-match. A document
      // that fails to save costs the operator their work — so never let the
      // former become the latter.
      out.skipped++;
    }
  }
  return out;
}
