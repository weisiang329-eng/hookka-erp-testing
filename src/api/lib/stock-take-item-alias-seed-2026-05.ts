// ---------------------------------------------------------------------------
// One-time seed for stock_take_item_alias (owner rule 2026-07-01; design doc
// docs/superpowers/specs/2026-07-01-stock-take-item-alias-import-design.md).
//
// Derived from the owner's STOCK_TAKE_30_05_2026_categorized (1).xlsx, "May26"
// sheet, using the SAME parser (src/lib/stock-take-import.ts detectRawShape /
// normalizeItemKey) the live import path uses, so every key here matches
// EXACTLY what re-importing that same physical file today would produce.
// Category text -> system group confirmed with the owner this session
// (notably: "Others" -> OTHERS, not B.OTHERS; "ACC"/"Acc" merged -> B.ACCE).
// `null` = "ignore this line" (the FG section's "GRAND TOTAL" subtotal row).
//
// Loaded once via POST /api/accounting/stock-take-item-alias-seed (dry-run +
// idempotent — mirrors the PI->GL backfill pattern in purchase-invoices.ts).
// ---------------------------------------------------------------------------
export const STOCK_TAKE_ITEM_ALIAS_SEED_2026_05: [string, string | null][] = [
  ["9mm||5ft x 10\"", "PLYWOOD"], ["9mm||5ft x 8\"", "PLYWOOD"], ["9mm||6ft x 8\"", "PLYWOOD"],
  ["9mm||4ft x 8\"", "PLYWOOD"], ["9mm||6ft x 10\"", "PLYWOOD"], ["9mm||75\" x 10\"", "PLYWOOD"],
  ["9mm||93cm x 8\"", "PLYWOOD"], ["9mm||4ft x 8ft", "PLYWOOD"], ["6mm||4ft x 8ft", "PLYWOOD"],
  ["6mm||12\" x 34\"", "PLYWOOD"], ["6mm||11\" x 6ft", "PLYWOOD"], ["5.5mm||5ft x 1ft", "PLYWOOD"],
  ["5.5mm||6ft x 1ft", "PLYWOOD"], ["5.5mm||1840x950", "PLYWOOD"], ["18mm||29\" x 4ft", "PLYWOOD"],
  ["18mm||16\" x 4ft", "PLYWOOD"], ["18mm||4ft x 8ft", "PLYWOOD"], ["15mm chipboard||4ft x 8ft", "PLYWOOD"],
  ["timber||1x2", "WD STRIP"], ["meranti fg||", "WD STRIP"],
  ["6mm||d12", "B.FILLER"], ["1.5\"||d38", "B.FILLER"], ["1.5\"||d12", "B.FILLER"], ["1\"||d12", "B.FILLER"],
  ["2\"||d12", "B.FILLER"], ["2\"||d27", "B.FILLER"], ["0.5\"||d25", "B.FILLER"], ["1\"||d25", "B.FILLER"],
  ["2\"||d16", "B.FILLER"], ["1\"||d30", "B.FILLER"], ["2\"||d30", "B.FILLER"], ["10mm||d27", "B.FILLER"],
  ["3\"||d30", "B.FILLER"], ["1.5\"||42/50", "B.FILLER"], ["2.5\"||42/50", "B.FILLER"], ["3\"||42/50", "B.FILLER"],
  ["3\"||42/60", "B.FILLER"], ["1/2\" polyester fibre||", "B.FILLER"], ["1\" polyester fibre||", "B.FILLER"],
  ["polyester fibre||", "B.FILLER"],
  ["2\"||d25", "S.FILLER"], ["3\"||d25", "S.FILLER"], ["2\"||d36", "S.FILLER"], ["1.5\"||d30", "S.FILLER"],
  ["3\"||d38", "S.FILLER"], ["2.5\"||d35", "S.FILLER"], ["3\"||d35", "S.FILLER"], ["3\"||42/40", "S.FILLER"],
  ["3\"||36/50", "S.FILLER"], ["1.5\"||36/50", "S.FILLER"], ["3\"||36/60", "S.FILLER"],
  ["pocketed spring 3\"||", "S.FILLER"], ["pocketed spring 4\"||", "S.FILLER"],
  ["glue||", "OTHERS"], ["438k-10box||", "OTHERS"], ["1007f-40box||", "OTHERS"], ["1010f-40box||", "OTHERS"],
  ["1019j-20box||", "OTHERS"], ["425k||", "OTHERS"], ["n50 (ctn)||", "OTHERS"], ["1.2\" screw||", "OTHERS"],
  ["1.5\" screw||", "OTHERS"], ["scrw(m4x50) (8000/box)||", "OTHERS"], ["scrw(m4x38) (15000/box)||", "OTHERS"],
  ["velco 25m/roll (40roll/ctn)||", "OTHERS"], ["cs 9.5(kg)||", "OTHERS"], ["fabric a (28m/roll)||", "OTHERS"],
  ["thread||", "OTHERS"],
  ["pe foam (100m/roll)||", "S.OTHERS"],
  ["1\" leg-2000pcs||", "B.ACCE"], ["2\" leg-300pcs||", "B.ACCE"], ["4\" leg||", "B.ACCE"],
  ["0216 center leg||", "B.ACCE"], ["al036 leg-40pcs||", "B.ACCE"], ["bracket (500/ctn)||", "B.ACCE"],
  ["7\" leg||", "B.ACCE"], ["6\" leg-90pcs||", "B.ACCE"], ["leg -al036||", "B.ACCE"],
  ["sla 95e (100/box)||", "B.ACCE"], ["slc 170a (60/box)||", "B.ACCE"], ["drawer 5\"||", "B.ACCE"],
  ["drawer 7\"||", "B.ACCE"], ["drawer 9\"||", "B.ACCE"], ["drawer slide||", "B.ACCE"],
  ["137 back rest-10pcs||", "S.MECH"], ["139 back rest-10pcs||", "S.MECH"],
  ["350 webbing||", "B.WEBB"], ["470 webbing||", "B.WEBB"], ["98\" fabric net white hole||", "B.WEBB"],
  ["cl-72||", "S.WEBB"], ["zig zag spring (40kg/bag)||", "S.WEBB"], ["zip||", "S.WEBB"],
  ["packing plastic 86\"-55kg||", "PACKING"], ["packing plastic 72\"-55kg||", "PACKING"],
  ["single face||", "PACKING"], ["2 seater plastic bag||", "PACKING"], ["157 corner||", "PACKING"],
  ["opp||", "PACKING"],
  ["lc5 (b) (200m/roll)||", "S-FABRIC"], ["lc5 (w) (200m/roll)||", "S-FABRIC"], ["non woven 250m/roll||", "S-FABRIC"],
  ["pc151-01||", "B.M-FABR"], ["pc151-03||", "B.M-FABR"], ["pc151-05||", "B.M-FABR"], ["pc151-06||", "B.M-FABR"],
  ["pc151-07||", "B.M-FABR"], ["pc151-08||", "B.M-FABR"], ["pc151-09||", "B.M-FABR"], ["pc151-10||", "B.M-FABR"],
  ["pc151-11||", "B.M-FABR"], ["pc151-12||", "B.M-FABR"], ["pc151-13||", "B.M-FABR"], ["pc151-14||", "B.M-FABR"],
  ["pc151-15||", "B.M-FABR"], ["pc151-16||", "B.M-FABR"], ["pc151-17||", "B.M-FABR"], ["pc151-18||", "B.M-FABR"],
  ["ah-1||", "B.M-FABR"],
  ["kn390-1||", "S.M-FABR"], ["kn390-2||", "S.M-FABR"], ["kn390-3||", "S.M-FABR"], ["kn390-13||", "S.M-FABR"],
  ["kn390-14||", "S.M-FABR"], ["kn390-15||", "S.M-FABR"], ["m2402-01||", "S.M-FABR"], ["m2402-04||", "S.M-FABR"],
  ["m2402-05||", "S.M-FABR"], ["m2402-06||", "S.M-FABR"], ["m2402-13||", "S.M-FABR"], ["ninja-01||", "S.M-FABR"],
  ["ninja-02||", "S.M-FABR"], ["ninja-03||", "S.M-FABR"], ["ninja-08||", "S.M-FABR"], ["bo315-10||", "S.M-FABR"],
  ["bo315-32||", "S.M-FABR"], ["bo315-25||", "S.M-FABR"],
  ["2009 fabric||5ft", "WIP"], ["2009 fabric||6ft", "WIP"], ["1003 fabric||5ft", "WIP"], ["1003 fabric||6ft", "WIP"],
  ["1007 fabric||5ft", "WIP"], ["1007 fabric||6ft", "WIP"], ["1007 fabric||3.5ft", "WIP"], ["1005 fabric||5ft", "WIP"],
  ["1005 fabric||6ft", "WIP"], ["1005 fabric||3.5ft", "WIP"], ["2006 fabric||5ft", "WIP"], ["2006 fabric||6ft", "WIP"],
  ["1013 fabric||5ft", "WIP"], ["1013 fabric||6ft", "WIP"], ["1013 fabric||3.5ft", "WIP"], ["1013 fabric||3ft", "WIP"],
  ["2038 fabric||5ft", "WIP"], ["2038 fabric||6ft", "WIP"], ["2003 fabric||6ft", "WIP"], ["1030 fabric||6ft", "WIP"],
  ["2023 fabric||3ft", "WIP"], ["divan fabric||3.5ft", "WIP"], ["divan fabric||6ft", "WIP"],
  ["5531 fabric||2+l", "WIP"], ["5531 fabric||2s", "WIP"], ["5531 fabric||3s", "WIP"], ["5535 fabric||l+2", "WIP"],
  ["5535 fabric||2s", "WIP"], ["5537 fabric||1l", "WIP"], ["2009 wood hb||6ft", "WIP"], ["2009 wood hb||5ft", "WIP"],
  ["1003 wood hb||6ft", "WIP"], ["1003 wood hb||5ft", "WIP"], ["1003 wood hb||3ft", "WIP"],
  ["2006 wood hb||6ft", "WIP"], ["2006 wood hb||5ft", "WIP"], ["1007 wood hb||6ft", "WIP"],
  ["1007 wood hb||5ft", "WIP"], ["1007 wood hb||3.5ft", "WIP"], ["1007 wood hb||3ft", "WIP"],
  ["1013 wood hb||6ft", "WIP"], ["1013 wood hb||5ft", "WIP"], ["1013 wood hb||3.5ft", "WIP"],
  ["1013 wood hb||3ft", "WIP"], ["1005 wood hb||6ft", "WIP"], ["1005 wood hb||5ft", "WIP"],
  ["1005 wood hb||3.5ft", "WIP"], ["5531 wood||2+l", "WIP"], ["5531 wood||2s", "WIP"], ["5531 wood||3s", "WIP"],
  ["5537 wood||1l", "WIP"], ["divan 8\"||6ft", "WIP"], ["divan 10\"||6ft", "WIP"], ["divan 12\"||6ft", "WIP"],
  ["divan 4\"||6ft", "WIP"], ["divan 4\"||5ft", "WIP"], ["divan 4\"||3.5ft", "WIP"], ["divan 4\"||3ft", "WIP"],
  ["divan 8\"||5ft", "WIP"], ["divan 10\"||5ft", "WIP"], ["divan 10\" dw||6ft", "WIP"], ["divan 10\"||3ft", "WIP"],
  ["divan 10\" dw||5ft", "WIP"], ["divan 8\" dw||6ft", "WIP"], ["divan 12\" dw||6ft", "WIP"],
  ["6112 fabric||2s", "WIP"],
  ["hok-1007-cody-(k)||", "FG"], ["hok-1007-cody-(q)||", "FG"], ["hok-1007-cody-(s)||", "FG"],
  ["hok-2006(a)-regal(a)-(k)||", "FG"], ["hok-2006(a)-regal(a)-(ss)||", "FG"], ["hok-2009(a)-trion(a)-(k)||", "FG"],
  ["hok-2009(a)-trion(a)-(q)||", "FG"], ["hok-1003(a)-hilton(a)-(k)||", "FG"], ["hok-1003(a)-hilton(a)-(q)||", "FG"],
  ["hok-1003(a)-hilton(a)-(ss)||", "FG"], ["hok-1005-fenrir-(k)||", "FG"], ["hok-1005-fenrir-(q)||", "FG"],
  ["hok-1005-fenrir-(ss)||", "FG"], ["hok-1013-jager-(k)||", "FG"], ["hok-1013-jager-(q)||", "FG"],
  ["hok-1013-jager-(ss)||", "FG"], ["hok-1021-victoria-(k)||", "FG"], ["hok-1021-victoria-(q)||", "FG"],
  ["hok-divan only (k)||", "FG"], ["hok-divan only (q)||", "FG"], ["5535 2+l||", "FG"],
  // Not a physical stock item -- the FG section's subtotal trailer row. Ignored
  // (item_group null) so it never surfaces as an unmapped "needs mapping" prompt.
  ["grand total||", null],
];
