# =============================================================================
# HOOKKA ERP — Multi-Department Forward Capacity Scheduler  (Agent core logic)
# =============================================================================
# WHAT THIS IS
#   A forward, finite-capacity, dependency-aware production scheduler across all
#   8 production departments. Given (a) every active order's current per-dept
#   state and (b) each department's average daily output, it predicts the day
#   each order clears each department and the day it is ready to deliver, then
#   flags which orders will miss the customer deadline.
#
#   This is the reusable rule-set the scheduling Agent runs. The data loader is
#   intentionally separate (load_orders) so the Agent can swap the source
#   (live ERP API, DB, snapshot file) without touching the algorithm.
#
# THE RULES (plain language — this is the logic the owner signed off on)
#   1. Department chain (who feeds whom):
#         FAB_CUT  -> FAB_SEW   --\
#         WOOD_CUT -> FRAMING -> WEBBING --> UPHOLSTERY -> PACKING
#         FOAM     ----------------/
#      An order can only enter a department once EVERY upstream department it
#      needs has finished it.
#   2. Each department has a daily capacity = average real output over the last
#      30 days (working minutes done per active day). We schedule in MINUTES
#      because one merged cut card = many pieces; minutes is the honest measure.
#   3. Forward pass, department by department in chain order. For each dept:
#        - An order is "available" on the day its last upstream dept finished
#          (orders that already cleared the previous process are available now).
#        - Among available orders, work the most urgent deadline first; within
#          the same deadline week, keep the same model together (batch = fewer
#          template/setup changes). This is the "鱼与熊掌" rule from cutting.
#        - Fill each working day up to the dept's capacity (skip Sundays). The
#          day an order's work is fully consumed = its finish day for that dept.
#        - That finish day becomes the order's available day for the NEXT dept.
#   4. PACKING finish = predicted ready-to-deliver day. Compare to Customer DD:
#      later  -> LATE (flag red so the owner can re-prioritise or add capacity).
#
# WHAT IT DOES NOT DO (yet — deliberately, ask before adding)
#   - It does not write anything back to the ERP. Read-only planning output.
#   - It assumes capacity is steady (no per-day headcount/holiday calendar).
#   - It treats a department's daily capacity as one shared pool (no per-worker
#     or per-machine modelling).
# =============================================================================

import json
import os
from datetime import date, timedelta
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "sched_data.json")

# Day the plan starts from (earliest any not-yet-done work can begin).
START = date(2026, 6, 1)

# No-work days: Sundays are always off (handled in code); these are extra
# closures (public holidays / declared days off). 2026-06-01 is off — the
# owner confirmed there is no production today, so the plan's first working
# day is 2026-06-02.
HOLIDAYS = {date(2026, 6, 1)}


def is_offday(d):
    """True if no production runs on this calendar day (Sunday or a holiday)."""
    return d.weekday() == 6 or d in HOLIDAYS

# ---- Department chain ------------------------------------------------------
# Process order == ERP department.sequence. Prereqs = immediate upstream depts.
DEPT_ORDER = ["FAB_CUT", "FAB_SEW", "WOOD_CUT", "FOAM",
              "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"]
PREREQ = {
    "FAB_CUT":    [],
    "FAB_SEW":    ["FAB_CUT"],
    "WOOD_CUT":   [],
    "FOAM":       [],
    "FRAMING":    ["WOOD_CUT"],
    "WEBBING":    ["FRAMING"],
    "UPHOLSTERY": ["FAB_SEW", "FOAM", "WEBBING"],
    "PACKING":    ["UPHOLSTERY"],
}

# ---- Capacity = avg real output / active day, last 30 days (2026-05-03..06-01)
# Pulled live from the ERP (completed/transferred job cards by completedDate).
# minutes/day is the scheduling unit; pieces/day is shown to the owner only.
CAP_MIN_PER_DAY = {
    "FAB_CUT": 2321, "FAB_SEW": 3114, "WOOD_CUT": 1226, "FOAM": 818,
    "FRAMING": 1706, "WEBBING": 960, "UPHOLSTERY": 1622, "PACKING": 1893,
}
CAP_PIECES_PER_DAY = {
    "FAB_CUT": 23.5, "FAB_SEW": 63.0, "WOOD_CUT": 61.2, "FOAM": 32.8,
    "FRAMING": 60.8, "WEBBING": 57.5, "UPHOLSTERY": 58.3, "PACKING": 79.5,
}

WINDOW_DAYS = 7  # deadline bucket for the same-model batching rule

# ---- order["d"][dept] index layout (from the ERP extract) ------------------
# [0]nCards [1]totMin [2]remMin [3]pieces [4]doneFlag [5]prereqAllFlag
# [6]maxCompletedDate [7]earliestDue
I_REM, I_PIECES, I_DONE, I_CDONE = 2, 3, 4, 6


def parse(s):
    try:
        y, m, d = str(s).split("-")
        return date(int(y), int(m), int(d))
    except Exception:
        return None


def next_workday(d):
    while is_offday(d):  # Sunday or holiday
        d += timedelta(days=1)
    return d


def add_workdays_skip_sun(d, n):
    while n > 0:
        d += timedelta(days=1)
        if not is_offday(d):
            n -= 1
    return d


def week_bucket(d):
    """Deadline window index relative to START's Monday. <START -> 0."""
    if d is None:
        return 9999
    this_mon = START - timedelta(days=START.weekday())
    if d < this_mon:
        return 0
    wk_mon = d - timedelta(days=d.weekday())
    return ((wk_mon - this_mon).days // WINDOW_DAYS) + 1


def model_of(pc):
    pc = (pc or "").strip()
    return pc.split("-")[0] if pc else "(none)"


def load_orders(path=DATA):
    blob = json.load(open(path, encoding="utf-8"))
    return blob["orders"]


def schedule(orders, cap=CAP_MIN_PER_DAY, start=START, horizon_days=400):
    """Core algorithm. Returns:
       finish[po][dept] = date the order clears that dept
       start_at[po][dept] = date it enters that dept
       load[dept][isodate] = minutes loaded that day (the daily plan)
       load_models[dept][isodate] = {model: pieces}
    """
    finish = defaultdict(dict)
    start_at = defaultdict(dict)
    load = defaultdict(lambda: defaultdict(float))
    load_models = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))

    by_po = {o["po"]: o for o in orders}

    # urgency key for an order: (deadline week, model, internal DD) so the most
    # urgent week comes first and same-model/same-week orders sit together.
    def urgency(o):
        dl = parse(o.get("hdd") or o.get("cdd"))
        return (week_bucket(dl), model_of(o.get("pc")), o.get("hdd") or o.get("cdd") or "9999-99-99")

    for dept in DEPT_ORDER:
        # available date per order for THIS dept = max(upstream finishes, start)
        avail = {}
        queue = []          # orders needing work here (remMin > 0)
        for po, o in by_po.items():
            cell = o["d"].get(dept)
            if cell is None:
                continue                      # dept not applicable to this order
            # upstream release time
            ups = [finish[po][p] for p in PREREQ[dept]
                   if p in o["d"] and p in finish[po]]
            a = max([start] + ups) if ups else start
            a = next_workday(a)
            avail[po] = a

            if cell[I_DONE] == 1:             # already cleared (historical)
                cd = parse(cell[I_CDONE]) or a
                finish[po][dept] = cd
                start_at[po][dept] = cd
                continue
            if cell[I_REM] <= 0:              # has card but no work -> pass through
                finish[po][dept] = a
                start_at[po][dept] = a
                continue
            queue.append(po)

        # day-by-day finite-capacity fill
        remaining = {po: float(by_po[po]["d"][dept][I_REM]) for po in queue}
        cap_d = cap[dept]
        day = next_workday(start)
        guard = 0
        while remaining and guard < horizon_days:
            guard += 1
            if is_offday(day):
                day += timedelta(days=1)
                continue
            cap_left = cap_d
            ready = sorted([po for po in remaining if avail[po] <= day],
                           key=lambda po: urgency(by_po[po]))
            for po in ready:
                if cap_left <= 0:
                    break
                if dept not in start_at[po]:   # first day this order is worked here
                    start_at[po][dept] = day
                take = min(remaining[po], cap_left)
                remaining[po] -= take
                cap_left -= take
                iso = day.isoformat()
                load[dept][iso] += take
                o = by_po[po]
                # attribute pieces proportionally to minutes worked that day
                tot = by_po[po]["d"][dept][I_REM] or 1
                pcs = by_po[po]["d"][dept][I_PIECES]
                load_models[dept][iso][model_of(o["pc"])] += pcs * (take / tot)
                if remaining[po] <= 1e-9:
                    finish[po][dept] = day
                    del remaining[po]
            day += timedelta(days=1)

    return finish, start_at, load, load_models


def predicted_ready(o, finish):
    """Ready-to-deliver day = the day the LAST-finishing department clears.
    Using max(all depts) — not just PACKING — so that orders with out-of-order
    completion in the ERP (a downstream dept marked done while an upstream dept
    is still pending) correctly report the future date of the unfinished work
    instead of a stale past completion date."""
    po = o["po"]
    fins = [finish[po][d] for d in DEPT_ORDER if d in o["d"] and d in finish[po]]
    return max(fins) if fins else None


if __name__ == "__main__":
    orders = load_orders()
    finish, start_at, load, load_models = schedule(orders)
    late = 0
    for o in orders:
        rd = predicted_ready(o, finish)
        cdd = parse(o.get("cdd"))
        if rd and cdd and rd > cdd:
            late += 1
    print(f"orders={len(orders)}  scheduled  late_vs_customerDD={late}")
    # show packing tail spread
    pk = sorted(load["PACKING"].keys())
    print("PACKING days:", pk[0], "->", pk[-1], f"({len(pk)} days)")
    for dept in DEPT_ORDER:
        days = sorted(load[dept].keys())
        if days:
            print(f"  {dept:<11} {days[0]} -> {days[-1]}  ({len(days)} working days)")
