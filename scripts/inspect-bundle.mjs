import fs from "fs";
const src = fs.readFileSync("./prod-bundle.js", "utf8");

const tag = String.fromCharCode(96); // backtick
console.log("=== FAB_CUT branches ===");
const m1 = src.match(new RegExp(`.{40}===${tag}FAB_CUT${tag}\\)\\{[^}]+\\}.{40}`, "g"));
m1 && m1.forEach((s) => console.log(s));

console.log("\n=== picker function definition (around code===) ===");
const pickerMatch = src.match(/[a-z]=\([a-z]\)=>\{[^}]+poDeptIndex[^}]+\}/g);
pickerMatch && pickerMatch.forEach((s) => console.log(s.slice(0, 500)));

console.log("\n=== Look for 'sched_FAB_CUT:'+ surrounding ===");
const sched = src.match(/sched_FAB_CUT:.{0,200}/g);
sched && sched.slice(0, 5).forEach((s) => console.log(s));

console.log("\n=== Locate the picker arrow body around 'samePoAnyFc' or fallback comment ===");
const fbody = src.match(/.{80}\.get\(.\)([^,;}]{0,50})/g);
fbody && fbody.slice(0, 5).forEach((s) => console.log(s));

console.log("\n=== Search for the wipKey strict-match line ===");
// Look for `byDept.get(jc.wipKey)`-equivalent in minified
const strict = src.match(/[a-z]\.wipKey[^;]{0,200}/g);
strict && strict.slice(0, 5).forEach((s) => console.log(s));
