// One-off codemod: shrink stat-card dashboards on every module/submodule.
// Pattern recognised as a stat card:
//   <CardContent className="p-4 ...">
//   <p className="text-sm text-[#6B7280]">LABEL</p>
//   <p className="text-2xl font-bold...">VALUE</p>
// After: p-2.5 / text-xs / text-xl and gap-3 grids.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.resolve(__dirname, "../src/pages");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

const files = walk(PAGES);
let changed = 0;

for (const f of files) {
  let src = fs.readFileSync(f, "utf8");
  const before = src;

  // 1. Shrink CardContent padding in stat-card-style cards.
  src = src.replace(
    /CardContent className="p-4 flex items-center justify-between"/g,
    'CardContent className="p-2.5 flex items-center justify-between"',
  );
  // Inline one-line stat card variant:
  src = src.replace(
    /<Card><CardContent className="p-4">(<p className="text-sm text-\[#6B7280\]">[^<]+<\/p><p className="text-2xl font-bold)/g,
    '<Card><CardContent className="p-2.5">$1',
  );

  // 2. Shrink the big number in stat cards: text-2xl font-bold -> text-xl font-bold.
  //    Only within stat card lines (safer than blanket): match the 'p className="text-2xl font-bold'
  //    that is on a line *after* a stat-card label. Use a simple line-wise pass.
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A stat card value line is typically preceded within ~4 lines by a label <p className="text-sm text-[#6B7280]">
    if (/text-2xl font-bold/.test(lines[i])) {
      for (let j = Math.max(0, i - 4); j < i; j++) {
        if (/<p className="text-sm text-\[#6B7280\]">/.test(lines[j])) {
          lines[i] = lines[i].replace(/text-2xl font-bold/, "text-xl font-bold");
          break;
        }
      }
    }
  }
  src = lines.join("\n");

  // 3. Shrink the label text from text-sm -> text-xs in stat cards.
  //    Label pattern is distinctive: `<p className="text-sm text-[#6B7280]">LABEL</p>`
  src = src.replace(
    /<p className="text-sm text-\[#6B7280\]">([^<]+)<\/p>/g,
    '<p className="text-xs text-[#6B7280]">$1</p>',
  );

  // 4. Shrink workflow / status pipeline cards. These use the plain
  //    `<CardContent className="p-4">` wrapping a row of status pills.
  //    We detect the pipeline by presence of `text-2xl font-bold mb-1` —
  //    that's the pill number on top of a stage label.
  src = src.replace(
    /<CardContent className="p-4">(\s*<div[^>]+gap-3">[\s\S]*?text-2xl font-bold mb-1)/g,
    '<CardContent className="p-2.5">$1',
  );
  src = src.replace(
    /text-2xl font-bold mb-1/g,
    "text-lg font-bold mb-0.5",
  );
  src = src.replace(
    /Badge[^>]*className="text-base px-3 py-1"/g,
    (m) => m.replace('text-base px-3 py-1', 'text-xs px-2 py-0.5'),
  );
  // The stage label under the pill.
  src = src.replace(
    /className=\{`text-sm mt-1 \$\{/g,
    "className={`text-[11px] mt-0.5 ${",
  );

  // 5. Shrink page title + subtitle in module headers so the data gets
  //    more vertical space. Pattern: `<h1 className="text-2xl font-bold ...">`
  src = src.replace(
    /<h1 className="text-2xl font-bold/g,
    '<h1 className="text-xl font-bold',
  );
  // Page subtitle right after the h1.
  src = src.replace(
    /<p className="text-sm text-\[#6B7280\] mt-1">/g,
    '<p className="text-xs text-[#6B7280] mt-0.5">',
  );

  if (src !== before) {
    fs.writeFileSync(f, src);
    changed++;
    console.log(`  ${path.relative(process.cwd(), f)}`);
  }
}

console.log(`\nChanged ${changed} of ${files.length} .tsx files.`);
