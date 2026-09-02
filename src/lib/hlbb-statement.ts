// hlbb-statement — parse a Hong Leong Bank (HLBB) PrimeBiz current-account
// statement PDF into signed statement lines for the bank reconciliation.
//
// Owner 2026-09-01: 「我要做到每个月我upload文件自动对账」. The caller (the
// Cash Book tab) extracts positioned text items with pdf.js and hands them
// here; this module is pure and unit-tested — no pdf.js, no DOM.
//
// Trust model: NEVER import silently-wrong money. The statement itself gives
// us three locks and we use them all:
//   1. every transaction row prints a running Balance — each parsed row must
//      satisfy  previous balance + amount = printed balance;
//   2. the footer prints the Closing Balance — opening + Σrows must equal it;
//   3. the footer prints deposit/withdrawal COUNTS — ours must agree (when
//      the counts can be read; layout noise there is a warning, not a pass).
// Any violated lock puts a human-readable message in `errors`, and the
// import UI refuses the file, pointing at the first broken row.

export type StmtItem = {
  str: string;
  /** left edge, page units */
  x: number;
  /** TOP-down y (caller converts pdf.js's bottom-up coordinate) */
  y: number;
  /** rendered width, page units */
  w: number;
  page: number;
};

export type StmtRow = {
  /** ISO YYYY-MM-DD */
  date: string;
  description: string;
  /** signed sen: + money in (deposit), − money out (withdrawal) */
  amountSen: number;
  /** printed running balance, sen — null when the row printed none */
  balanceSen: number | null;
};

export type ParsedHlbbStatement = {
  rows: StmtRow[];
  openingSen: number;
  closingSen: number;
  totalInSen: number;
  totalOutSen: number;
  countIn: number;
  countOut: number;
  accountNo: string | null;
  /** fatal problems — the import must refuse while any exist */
  errors: string[];
  /** non-fatal oddities worth showing */
  warnings: string[];
};

const MONEY_RE = /^-?\d{1,3}(?:,\d{3})*\.\d{2}$/;
const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

const toSen = (s: string): number => Math.round(parseFloat(s.replace(/,/g, "")) * 100);
const isoOf = (d: string): string | null => {
  const m = DATE_RE.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

type Line = { page: number; y: number; items: StmtItem[]; text: string };

/** Group items into visual lines (same page, y within tolerance), x-sorted. */
export function groupLines(items: StmtItem[], yTol = 2.5): Line[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= yTol) {
      last.items.push(it);
    } else {
      lines.push({ page: it.page, y: it.y, items: [it], text: "" });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  }
  return lines;
}

export function parseHlbbStatement(items: StmtItem[]): ParsedHlbbStatement {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = groupLines(items);

  // Column anchors from the table header ("Deposit / Withdrawal / Balance").
  // Amounts are right-aligned, so we classify by the RIGHT edge of each
  // money item against the nearest header right edge.
  let depositX: number | null = null;
  let withdrawalX: number | null = null;
  let balanceX: number | null = null;
  for (const l of lines) {
    const dep = l.items.find((i) => /^Deposit$/i.test(i.str.trim()));
    const wdr = l.items.find((i) => /^Withdrawal$/i.test(i.str.trim()));
    const bal = l.items.find((i) => /^Balance$/i.test(i.str.trim()));
    if (dep && wdr && bal) {
      depositX = dep.x + dep.w;
      withdrawalX = wdr.x + wdr.w;
      balanceX = bal.x + bal.w;
      break;
    }
  }
  if (depositX === null || withdrawalX === null || balanceX === null) {
    return {
      rows: [], openingSen: 0, closingSen: 0, totalInSen: 0, totalOutSen: 0,
      countIn: 0, countOut: 0, accountNo: null,
      errors: ["Could not find the Deposit / Withdrawal / Balance table header — is this an HLBB statement PDF?"],
      warnings,
    };
  }
  const colOf = (it: StmtItem): "deposit" | "withdrawal" | "balance" => {
    const right = it.x + it.w;
    const d = Math.abs(right - (depositX as number));
    const w = Math.abs(right - (withdrawalX as number));
    const b = Math.abs(right - (balanceX as number));
    return d <= w && d <= b ? "deposit" : w <= b ? "withdrawal" : "balance";
  };

  const accountNo = (() => {
    for (const l of lines) {
      const m = /A\/C No.*?:\s*(\d{6,})/.exec(l.text);
      if (m) return m[1];
    }
    return null;
  })();

  // Walk the statement top to bottom. A line whose FIRST item is a date opens
  // a transaction; following non-date lines extend its description; money
  // items are attributed by column. Footer labels end the transaction region.
  type Txn = { date: string; desc: string[]; inSen: number | null; outSen: number | null; balanceSen: number | null };
  const txns: Txn[] = [];
  let current: Txn | null = null;
  let openingSen: number | null = null;
  let closingSen: number | null = null;
  let footCountOut: number | null = null;
  let footCountIn: number | null = null;
  let footTotalOutSen: number | null = null;
  let footTotalInSen: number | null = null;
  let inFooter = false;

  // First figure per column wins; a duplicate is reported and DISCARDED —
  // overwriting once let a sidebar's rebate figure replace a real deposit.
  const attachMoney = (t: Txn, it: StmtItem) => {
    const col = colOf(it);
    const sen = toSen(it.str);
    if (col === "balance") {
      if (t.balanceSen !== null) { errors.push(`${t.date}: two balance figures on one transaction`); return; }
      t.balanceSen = sen;
    } else if (col === "deposit") {
      if (t.inSen !== null) { errors.push(`${t.date}: two deposit figures on one transaction`); return; }
      t.inSen = sen;
    } else {
      if (t.outSen !== null) { errors.push(`${t.date}: two withdrawal figures on one transaction`); return; }
      t.outSen = sen;
    }
  };

  for (const l of lines) {
    const text = l.text;
    if (/Balance from previous statement/i.test(text)) {
      const money = l.items.filter((i) => MONEY_RE.test(i.str.trim()));
      for (const m of money) {
        if (colOf(m) === "balance") openingSen = toSen(m.str);
        else warnings.push("An amount rode on the opening-balance line — check the first transaction");
      }
      continue;
    }
    // Footer labels can share ONE visual line ("Total Deposits … Closing
    // Balance …"), so every pattern is checked on the same line before
    // moving on — an early `continue` per label lost the closing balance.
    if (/Total Withdrawals|Total Deposits|Closing Balance/i.test(text)) {
      inFooter = true;
      current = null;
      const moneys = l.items.filter((i) => MONEY_RE.test(i.str.trim()));
      const wN = /Total Withdrawals[^:]*:\s*(\d+)\b/.exec(text);
      if (wN) {
        footCountOut = parseInt(wN[1], 10);
        if (moneys.length && !/Closing Balance/i.test(text)) footTotalOutSen = toSen(moneys[0].str);
      }
      const dN = /Total Deposits[^:]*:\s*(\d+)\b/.exec(text);
      if (dN) footCountIn = parseInt(dN[1], 10);
      if (/Closing Balance/i.test(text)) {
        // Closing sits in the Balance column; other figures on the line
        // (e.g. the deposits total) sit further left.
        const bal = moneys.filter((i) => colOf(i) === "balance");
        if (bal.length) closingSen = toSen(bal[bal.length - 1].str);
        if (dN && moneys.length > bal.length) footTotalInSen = toSen(moneys[0].str);
      } else if (dN && moneys.length) {
        footTotalInSen = toSen(moneys[0].str);
      }
      continue;
    }
    // The Rebate Summary sidebar starts after the last transaction; its
    // figures sit in x-ranges that collide with the money columns, so the
    // moment it appears the transaction region is over.
    if (/Rebate Summary|Rebates Brought Forward/i.test(text)) {
      inFooter = true;
      current = null;
      continue;
    }
    if (inFooter) continue;

    const first = l.items[0];
    const dateIso = first ? isoOf(first.str.trim()) : null;
    if (dateIso) {
      current = { date: dateIso, desc: [], inSen: null, outSen: null, balanceSen: null };
      txns.push(current);
      for (const it of l.items.slice(1)) {
        const s = it.str.trim();
        if (MONEY_RE.test(s)) attachMoney(current, it);
        else if (s) current.desc.push(s);
      }
      continue;
    }
    if (!current) continue;
    // Continuation line of the current transaction (skip page furniture).
    if (/Page No|Statement Period|Tempoh Penyataan|Branch|Tel No|A\/C No|Deskripsi Transaksi|Transaction Description|Tarikh|Simpanan|Pengeluaran|Baki|HLB PRIMEBIZ|Protected by PIDM|Dilindungi/i.test(text)) continue;
    for (const it of l.items) {
      const s = it.str.trim();
      // Ignore artifacts printed outside the table (page watermarks etc.).
      if (it.x > (balanceX as number) + 30) continue;
      if (MONEY_RE.test(s)) attachMoney(current, it);
      else if (s && s.length > 1) current.desc.push(s);
    }
  }

  if (openingSen === null) errors.push("Opening balance (Balance from previous statement) not found");
  if (closingSen === null) errors.push("Closing Balance not found in the footer");

  // Assemble rows + run every lock.
  const rows: StmtRow[] = [];
  let running = openingSen ?? 0;
  let totalInSen = 0;
  let totalOutSen = 0;
  let countIn = 0;
  let countOut = 0;
  for (const t of txns) {
    if (t.inSen === null && t.outSen === null) {
      // A dated line with no money at all — HLBB prints none of these in the
      // transaction table; treat as noise but say so.
      warnings.push(`${t.date}: dated line without any amount was skipped (${t.desc.slice(0, 3).join(" · ").slice(0, 60)})`);
      continue;
    }
    if (t.inSen !== null && t.outSen !== null) {
      errors.push(`${t.date}: a single transaction carries both a deposit and a withdrawal — column mapping is off`);
      continue;
    }
    const amountSen = t.inSen !== null ? t.inSen : -(t.outSen as number);
    if (t.inSen !== null) { totalInSen += t.inSen; countIn++; } else { totalOutSen += t.outSen as number; countOut++; }
    const expect = running + amountSen;
    if (t.balanceSen !== null && t.balanceSen !== expect) {
      errors.push(`${t.date} (${t.desc[0] ?? ""}): running balance breaks — expected ${(expect / 100).toFixed(2)}, statement prints ${(t.balanceSen / 100).toFixed(2)}`);
    }
    running = t.balanceSen ?? expect;
    rows.push({ date: t.date, description: t.desc.join(" · "), amountSen, balanceSen: t.balanceSen });
  }

  if (openingSen !== null && closingSen !== null) {
    const computed = openingSen + totalInSen - totalOutSen;
    if (computed !== closingSen) {
      errors.push(`Opening ${(openingSen / 100).toFixed(2)} + deposits ${(totalInSen / 100).toFixed(2)} − withdrawals ${(totalOutSen / 100).toFixed(2)} = ${(computed / 100).toFixed(2)}, but the statement's Closing Balance is ${(closingSen / 100).toFixed(2)} — refusing the import`);
    }
  }
  if (footCountOut !== null && footCountOut !== countOut) {
    warnings.push(`Statement says ${footCountOut} withdrawals, parsed ${countOut}`);
  }
  if (footCountIn !== null && footCountIn !== countIn) {
    warnings.push(`Statement says ${footCountIn} deposits, parsed ${countIn}`);
  }
  if (footTotalOutSen !== null && footTotalOutSen !== totalOutSen) {
    errors.push(`Statement's Total Withdrawals ${(footTotalOutSen / 100).toFixed(2)} ≠ parsed ${(totalOutSen / 100).toFixed(2)}`);
  }
  if (footTotalInSen !== null && footTotalInSen !== totalInSen) {
    errors.push(`Statement's Total Deposits ${(footTotalInSen / 100).toFixed(2)} ≠ parsed ${(totalInSen / 100).toFixed(2)}`);
  }
  if (rows.length === 0) errors.push("No transactions found");

  return {
    rows,
    openingSen: openingSen ?? 0,
    closingSen: closingSen ?? 0,
    totalInSen,
    totalOutSen,
    countIn,
    countOut,
    accountNo,
    errors,
    warnings,
  };
}
