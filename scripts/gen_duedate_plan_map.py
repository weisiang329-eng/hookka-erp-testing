# =============================================================================
# DUE-DATE PLAN MAP generator (read-only).
# Imports the existing scheduler modules (same pattern as en_build_by_so_master)
# and emits a compact JSON map: per SO -> the FINISH day of each production stage.
# This map is loaded into the browser and joined to the live ERP job cards to set
# each WAITING card's dueDate = its stage's scheduled finish day for that SO.
#
# Stage -> dept code mapping used by the browser join:
#   FAB_CUT    -> fabcut
#   FAB_SEW    -> fabsew
#   WOOD_CUT   -> woodcut
#   FRAMING    -> framing
#   WEBBING    -> framing   (webbing rides framing, same day)
#   FOAM       -> foam if card is SOFA, else framing (bedframe HB-foam rides framing)
#   UPHOLSTERY -> upholstery
#   PACKING    -> packing
# =============================================================================
import os, io, contextlib, importlib.util, json
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fname))
    mod = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        spec.loader.exec_module(mod)
    return mod


fr = _load("fr_plan", "build_framing_daily_xlsx.py")
sw = _load("sw_plan", "build_sewing_daily_xlsx.py")
wd = fr.wood
ct = sw.cut

# ---- per-SO LAST scheduled day per stage (identical logic to by-so master) ----
po_so = {r.get("po"): r.get("soNo") for r in ct.src}
cut_date = {}
for lane, gs in ct.lane_groups.items():
    for g in gs:
        gday = g["days"][-1][0] if g.get("days") else g.get("end")
        for it in g["items"]:
            so = po_so.get(it.get("po"))
            if not so:
                continue
            if so not in cut_date or gday > cut_date[so]:
                cut_date[so] = gday

sew_date = {}
for lane in sw.LANE_ORDER:
    for c in sw.results[lane]:
        so = c.get("soNo")
        if not so:
            continue
        if so not in sew_date or c["day"] > sew_date[so]:
            sew_date[so] = c["day"]

wood_date = {}
for lane, us in wd.lane_units.items():
    for u in us:
        so = u["so"]
        if so not in wood_date or u["day"] > wood_date[so]:
            wood_date[so] = u["day"]

fram_date = {}
for u in fr.units:
    so = u["so"]
    if so not in fram_date or u["day"] > fram_date[so]:
        fram_date[so] = u["day"]

foam_date = {}
for u in fr.foam_units:
    so = u["so"]
    if so not in foam_date or u["foam_day"] > foam_date[so]:
        foam_date[so] = u["foam_day"]

uph_date = {}
for u in fr.uph_units:
    so = u["so"]
    if so not in uph_date or u["uph_day"] > uph_date[so]:
        uph_date[so] = u["uph_day"]

pack_date = {}
for u in fr.pack_units:
    so = u["so"]
    if so not in pack_date or u["pack_day"] > pack_date[so]:
        pack_date[so] = u["pack_day"]


def iso(d):
    return d.isoformat() if d else None


all_so = (set(cut_date) | set(sew_date) | set(wood_date) | set(fram_date)
          | set(foam_date) | set(uph_date) | set(pack_date))
all_so = {s for s in all_so if s}

plan = {}
for so in all_so:
    plan[so] = {
        "fabcut": iso(cut_date.get(so)),
        "fabsew": iso(sew_date.get(so)),
        "woodcut": iso(wood_date.get(so)),
        "framing": iso(fram_date.get(so)),
        "foam": iso(foam_date.get(so)),
        "upholstery": iso(uph_date.get(so)),
        "packing": iso(pack_date.get(so)),
    }

# ---- orphans: WAITING cards exist in a dept but no scheduled date came out ----
full = json.load(open(os.path.join(HERE, "sched_dept_full.json"), encoding="utf-8"))
cat = defaultdict(set)
waiting_by_dept = defaultdict(lambda: defaultdict(int))
for dept, rows in full.items():
    for r in rows:
        so = r.get("coSOId")
        if not so:
            continue
        if r.get("cat"):
            cat[so].add(r["cat"])
        if r.get("cardStatus") == "WAITING" and r.get("orderStatus") not in ("ON_HOLD", "CANCELLED"):
            waiting_by_dept[so][dept] += 1

stage_for_dept = {
    "FAB_CUT": "fabcut", "FAB_SEW": "fabsew", "WOOD_CUT": "woodcut",
    "FRAMING": "framing", "WEBBING": "framing", "FOAM": "foam",
    "UPHOLSTERY": "upholstery", "PACKING": "packing",
}
orphans = []
for so, depts in waiting_by_dept.items():
    for dept, n in depts.items():
        stage = stage_for_dept.get(dept)
        # FOAM bedframe cards ride framing -> use framing date for the orphan check
        if dept == "FOAM" and "SOFA" not in cat.get(so, set()):
            has = plan.get(so, {}).get("framing")
        elif dept == "WEBBING":
            has = plan.get(so, {}).get("framing")
        else:
            has = plan.get(so, {}).get(stage) if stage else None
        if not has:
            orphans.append([so, dept, n])

out = {
    "generated": "2026-06-02",
    "note": "per-SO stage finish dates; browser joins live job cards by (companySOId||companyCOId) + dept",
    "stage_for_dept": stage_for_dept,
    "plan": plan,
    "orphans": orphans,
}
outpath = os.path.join(HERE, "duedate_plan_map.json")
json.dump(out, open(outpath, "w", encoding="utf-8"), ensure_ascii=False, indent=0)

orphan_sos = sorted({o[0] for o in orphans})
print("OK ->", outpath)
print("SOs in plan:", len(plan))
print("orphan (so,dept) pairs:", len(orphans), "across", len(orphan_sos), "SOs")
print("plan_map bytes:", os.path.getsize(outpath))
