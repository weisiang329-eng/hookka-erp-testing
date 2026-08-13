> **ARCHIVED / SUPERSEDED — stopped being true 2026-06-03.** This is the 2026-05-31
> blueprint written *before* the scheduler was built. What was actually built on
> 2026-06-03 (`75b64b58`, `69dbbae1`) is a 1:1 TypeScript port of the owner-confirmed
> Python cutter — `src/api/lib/planning-scheduler.ts` + `src/api/lib/planning-capacity.ts`
> — and it contradicts this spec on every load-bearing rule:
>
> | This doc says | The code does (`planning-capacity.ts`, verified 2026-08-13) |
> |---|---|
> | Capacity is **measured** from the last 7–10 working days of completions | Capacity is a **config constant** (`DEFAULT_CAPACITY_CONFIG`), owner-confirmed, overridable at runtime via `kv_config['planning_capacity']` |
> | Teams `SOFA / BEDFRAME / OTHER` | Lanes `BEDFRAME / SOFA / ACCESSORY` (`Lane`, :20) |
> | FAB_CUT cap 款/天: BEDFRAME **6**, SOFA **2** | `laneCap {BEDFRAME 6, SOFA 6, ACCESSORY 8}` + a shared BF/SOFA pool with reserve tiers 7/6/5 by day index + `sofaMin 3` (:189-195) |
> | `setupCap` SOFA 3 / BEDFRAME **5** | `setupCap {BEDFRAME 8, SOFA 3, ACCESSORY 8}` (:196) |
> | Generic "one stage per day, next stage +1 day" | Per-stage capacities and handoffs: sew 1200/2100/240 min-day, wood 20/10 sets-day, framing 1320/480, foam 480, uph 1440/720; handoffs cut→sew +1, sew→wood +2, wood→frame +1, frame→foam +1, →uph +1 (:100-116) |
> | Fabric cutting gated on **models/day** | Since 2026-07-11 (`e018da1b`) fabric cutting is a **CNC minutes** model: bedframe set 8 min, sofa set 20 min, accessory 4 min, fabric change 10 min, 1 machine (:203-210) |
> | No walk-in reserve | `reserveAfterDay 3` / `reservePct 15` — owner 2026-08-04 (`69eed843`) |
>
> Also: STEP 4's `actualMinutes` reasoning is dead — all 4,289 `actualMinutes` values
> are byte-identical copies of `estMinutes` (PERF-BACKLOG, 2026-08-13), and the
> scheduler no longer derives capacity from them at all. The Snapshot reference dates
> (June 2026) are two months in the past. Kept for history only — it records the
> owner's reasoning about *why* cutting is gated on setups; do not treat any number,
> field list or algorithm in it as current.

# Production Planning Logic Specification
# 生产排程逻辑规格书

> 这份文件把整套排程逻辑一步一步写下来，目的是给「Claude managed agent」当蓝图。
> 每一节都先用大白话讲清楚要做什么，再写出精确规则（给写程序的人 / agent 用）。
> Wei Siang 可以一个一个 step 看下去，每一步觉得不对就喊停，我们改这一节就好。

---

## STEP 0 — 这个东西要回答什么问题？ / Goal

**大白话：**
客人问「我的沙发几时做好？」，我们要给一个**真实的、排得出来的日期**，不是拍脑袋。
排的时候要照客人的交期先后来排队，而且每个工站**一天只能做这么多**，不能假装无限产能。
已经 overdue（超过交期）的单，照样要排进去，照客人交期的先后顺序插队。

**精确目标 / Goal:**
For every active sales order (SO), output a **capacity-grounded "ready date"** — the date the LAST production stage of that order is forecast to finish — given:
- limited daily throughput per workstation,
- priority by customer delivery date,
- overdue orders still scheduled (by delivery-date order, not dropped).

**输出一句话：** 每张单一个「预计做好日期」+「比交期早/迟几天」。

---

## STEP 1 — 数据从哪里来？ / Data source

**大白话：**
所有数据从系统里现成的接口 `/api/production-orders` 拿。
不直接碰数据库（数据库锁住了，只能读）。

**精确规则 / Data source:**
- Endpoint: `GET /api/production-orders` (authenticated browser session).
- Returns active orders, each with line items and **job cards**.
- All aggregation is done in code from this payload. **No direct DB access.**

**我们用到的字段 / Fields we read:**

| 字段 (field) | 中文意思 | 用途 |
|---|---|---|
| `soNo` | 销售单号 | 把同一张单的多个 line 卷回去一起算 |
| `itemCategory` | 单的品类 | **分队用**：SOFA / BEDFRAME / 其它(配件) |
| `customerDeliveryDate` | 客人交期 | **排队优先级**（第一顺位） |
| `hookkaExpectedDD` | 我们自己估的交期 | 客人交期没填时的后备 |
| job card `departmentCode` | 工站代号 | 决定这张卡属于哪个工站 |
| job card `sequence` | 工序顺序号 | **决定每张单的工序先后**（不是全厂固定顺序！） |
| job card `status` | 卡状态 | `COMPLETED`/`TRANSFERRED`=已做完（算产能）；`WAITING`=还没做（算 backlog） |
| job card `completedDate` | 完成日期 | 判断是否落在 30 天产能窗口内 |
| job card `actualMinutes` | 「实际」工时 | 算产能 & backlog 的工时（见 STEP 4 的重要说明） |
| job card `estMinutes` | 估算工时 | `actualMinutes` 没有时的后备 |
| job card `wipQty` | 这张卡的件数 | 工时要乘件数（至少算 1 件） |

---

## STEP 2 — 八个工站的生产链 / The production chain

**大白话：**
一张单要经过这几个工站，顺序是：
裁布 → 车缝 → 锯木 → 钉框 → 织带 → 海绵 → 包皮 → 包装。
但**不是每张单都走全部，也不是顺序都一样**（沙发和床架的工序不同）。
所以我们**照每张卡自己带的「工序顺序号 sequence」来排**，不写死一个全厂顺序。

**精确规则 / Chain:**
Canonical department codes (reference order):

| 代号 (departmentCode) | 中文 |
|---|---|
| `FAB_CUT` | 裁布 |
| `FAB_SEW` | 车缝 |
| `WOOD_CUT` | 锯木 |
| `FRAMING` | 钉框 |
| `WEBBING` | 织带 |
| `FOAM` | 海绵 |
| `UPHOLSTERY` | 包皮 |
| `PACKING` | 包装 |

- **Per order, the stage order is derived from the cards' `sequence` values**, NOT from this fixed list.
- A given order only includes the stages it actually has WAITING cards for.

---

## STEP 3 — 分成两支队伍 / Team split (SOFA vs BEDFRAME)

**大白话：**
沙发组和床架组是**两批不同的人、不同的产能**。
所以算产能、排程时，要按「这张单是沙发还是床架」分开算。
判断依据是**单本身的品类 `itemCategory`**，不是卡上的 `wipType`
（因为 `wipType` 只有裁布那张卡填得准，下游的卡大多变成「其它」，会算错）。

**精确规则 / Team:**
```
team(order) = normalize(order.itemCategory)
  → "SOFA"      if category indicates sofa
  → "BEDFRAME"  if category indicates bed/bedframe
  → "OTHER"     otherwise (accessories etc.)
```
- Capacity and backlog are bucketed per **(department × team)** — written as key `"<DEPT>|<TEAM>"`, e.g. `"FOAM|SOFA"`.
- ⚠️ Do NOT split on the card's `wipType` — only `FAB_CUT` cards carry reliable SOFA/BEDFRAME there; everything downstream collapses to OTHER and breaks the split.

---

## STEP 4 — 每个工站一天能做多少？ / Capacity

**大白话：**
我们看**最近的开工天**每个工站真的做完了多少，拿这个当「一天的产能」。
（裁布这一站确认用**最近 7–10 个开工天**——够新、最有代表性，不会被旧数据带歪；已用 05-21→30 窗口核对。）

产能分几种算法：
- **裁布 FAB_CUT（已确认 ✅）**：产能闸门是**一天能切几个「款」**（不是几套、不是几张卡、不是工时）。
  原因：切布是「同款一起切」，每多一个款就多一次划线/setup——真正的瓶颈是款数（setup 数），套数是跟着款走的副产品。
  → **确认产能：床架 6 个款/天、沙发 2 个款/天**（用最近、最有代表性的 05-21→30 窗口核对；取现场判断值、不留安全余量）。
  → 一个款平均带 ~2.2 套，所以约等于 床架 ~13 套、沙发 ~5 套/天——但**闸门看款，不看套**（套不能乱排，要跟着款）。
  → **大单保护（套数多 = 唯一会超过 1 个款位的原因）**：一个款套数特别多时，要拆成多个款来占位
     = `ceil(套数 ÷ 一次能切的上限)`，上限 沙发 3 套、床架 5 套（Wei Siang 现场值）。
     例：床架一个款 30 套 → ceil(30/5)=6 个款的位置（≈ 占一天）。正常小款（1-2 套）= 1 个款的位置。
  → **不按裁布时间加权**（Wei Siang 2026-05-31 确认，推翻早前的想法）：
     ① 同一个款不会今天切、明天又切——一款一天切完；一个款占超过 1 位的**唯一原因是「量太多」**，跟它裁得久不久无关。
     ② 「床架 6 款/天」是从真实开工天量出来的，那些天本来就混着裁得久和裁得快的款，时间差异已经摊进 6 这个平均里；
        再按时间加权 = 同一件事扣两次（double-penalty）。所以裁布时间不进公式。
- **锯木 WOOD_CUT（待确认 ⏳）**：暂时沿用旧的「张数/天」，等走到这一站再用同样方法核对（他们按 K/Q/SS/S 尺寸分批）。
- **其它所有工站（待确认 ⏳）**：暂时算**一天几分钟**（工时总和 ÷ 开工天数），等逐站走到再确认。

**精确规则 / Capacity:**

Window (FAB_CUT confirmed on the most recent ~7–10 working days):
```
holidays = GET /api/kv-config/public_holidays  → { data: ["YYYY-MM-DD", ...] }
isWork(date) = (NOT Sunday) AND (NOT in holidays)        // 星期六算开工天 ✅
TODAY = run date (e.g. 2026-05-31)
window = the most recent ~7–10 working days on/before TODAY that have FAB_CUT completions
       = (validated snapshot) 2026-05-21 → 2026-05-30   (7 working days)
opdays = number of those working days that actually HAVE completions (skip not-yet-logged days)
```
> ⚠️ 必须**踢掉完成日期填到未来**的脏工单（completedDate > TODAY）——之前快照就有 12 张；
>   不踢的话窗口会被拉到 9 月去，产能算全错。
> ⚠️ **星期六算开工天**（数据证实 05-16、05-23 星期六都有切布）。只有星期天 + 公共假期不算。
> ⚠️ **跳过还没记录的开工天**（例：05-30 星期六还没补登）——别把 0 当产能，否则平均被拉低。
> 公共假期清单存在 `kv_config['public_holidays']`，由 Employee 模块维护（同一份也用在往后排程的日历）。
> 窗口取「最近 7–10 个开工天」是 Wei Siang 确认的（要看近况，不要用太旧的数据带歪）。

Measurement type per department:
```
MODELS_CUT = { FAB_CUT }    // measured in MODELS/day (款/天) — confirmed ✅
CARDS_CUT  = { WOOD_CUT }   // measured in cards/day — TBD ⏳ (revisit at that station)
// everything else            measured in minutes/day — TBD ⏳
```

For each job card with `status ∈ {COMPLETED, TRANSFERRED}` AND `completedDate` inside the window:
```
key = departmentCode + "|" + team(order)
if departmentCode ∈ MODELS_CUT:
    modelsByDay[completedDate][key].add(order.productCode)   // DISTINCT models that day (同款只算一次)
    setsByDay[completedDate][key]  += max(1, wipQty)         // info only → derive sets/model
else if departmentCode ∈ CARDS_CUT:
    cardCount[key] += 1                                      // count cards
else:
    minSum[key]   += (actualMinutes ?? estMinutes ?? 0) * max(1, wipQty)   // sum minutes
```

Daily capacity:
```
cap[key] = average over working days of |distinct models that day|   if FAB_CUT   (MODELS/day)
cap[key] = cardCount[key]/ opdays      if WOOD_CUT       (cards per day, TBD)
cap[key] = minSum[key]   / opdays      otherwise         (minutes per day, TBD)
```

**FAB_CUT confirmed numbers (validated window 05-21 → 05-30, 7 working days):**

| key | cap (款/天 models/day) | ~sets/day | 一个款几套 |
|---|---|---|---|
| `FAB_CUT\|SOFA` | **2** | ~5 | 2.4 |
| `FAB_CUT\|BEDFRAME` | **6** | ~13 | 2.2 |

> 闸门看**款/天**，不看套（Wei Siang 确认：床架 6 款＝他现场 5-6 的上限；沙发 2 款）。套数是跟着款走的副产品。
> 记录平均（05-21→30）：床架 7 款 / 15.4 套、沙发 2 款 / 4.7 套；床架锁 **6**（取现场值，略保守于记录的 7）。
> **一个款占用的位置 / model-slot formula**（只看套数，不看裁布时间）：
> ```
> slots(model) = ceil(modelSets / setupCap)   // setupCap SOFA 3 / BEDFRAME 5; 正常小款 = 1 slot
> ```
> - `modelSets` = 该款 WAITING 卡的 `Σ max(1, wipQty)`。
> - 床架一个款 30 套 → ceil(30/5)=6 slots（≈ 占一整天）。
> - **不按裁布时间加权**（Wei Siang 2026-05-31）：同款不会今天切明天又切，一款一天切完；
>   超过 1 位的唯一原因是「量太多」。而且「6 款/天」是从混合长短款的真实开工天量出来的，
>   时间差异已摊进平均，再加权会重复扣。
> 用现场判断值、不留安全余量（Wei Siang 确认）。

**⚠️ 重要说明 — `actualMinutes` 其实是「标准工时」，不是真的码表时间：**
`import-completion.ts` 在卡完成时做的是
`actualMinutes = productionTimeMinutes || estMinutes`（用计划工时当实际工时）。
所以 `actualMinutes` 是标准/计划时间，裁的工站偏高。
**但这不影响预测的对错**：因为算「产能（已完成产出）」和算「backlog（待做工时）」用的是**同一把尺**，
偏高的部分在分子分母同时出现、互相抵消，预测自洽、有效。

---

## STEP 5 — 每张单还剩多少没做？ / Build each order's remaining stages

**大白话：**
对每一张「还有没做完的卡」的单，把它**还没做的卡**按工站归类，
每个工站算出「还要做多少」，再按工序顺序排好。

**精确规则 / Stage building:**
For each order that has ≥1 `WAITING` card:
```
group its WAITING cards by departmentCode → each group becomes a "stage":
  stage.key  = departmentCode + "|" + team(order)
  stage.work = (departmentCode === FAB_CUT)
                 ? Σ over distinct models of ceil(modelSets / setupCap)   // FAB_CUT: in MODEL-SLOTS (款) ✅
                   //   group WAITING cards by productCode; modelSets = Σ max(1,wipQty) of that model;
                   //   setupCap = SOFA 3 / BEDFRAME 5;  正常小款 = 1 slot
                 : (departmentCode === WOOD_CUT)
                   ? count of WAITING cards in this dept          // WOOD_CUT: in cards (TBD)
                   : Σ over cards of estMinutes * max(1, wipQty)  // others: in minutes (TBD)
  stage.cap  = cap[stage.key]   (from STEP 4; may be 0 → see STEP 8 stalled)
sort stages by min(sequence) of cards in that group   // 用工序顺序号排先后
```
Order priority key:
```
dd(order) = customerDeliveryDate ?? hookkaExpectedDD ?? "9999-12-31"
```

---

## STEP 6 — 一天一天地排 / The day-by-day simulation

**大白话：**
我们从**明天**开始，一天一天往后排：
1. 先把所有单按客人交期**从早到晚排队**（早的先做）。
2. 每个工站**每天有一桶产能**（STEP 4 算的），今天用完了就等明天。
3. 每张单**一天最多往前推一个工站**（这个工站做完了，下一个工站要**隔一天**才接手）。
4. 一个工站的活如果一天做不完，就跨好几天慢慢做。
5. 一直排到所有单都做完为止。

**精确规则 / Simulation (integer day-index):**
```
priority = orders sorted ascending by dd(order)   // overdue 也照 dd 排，不丢掉
each order has: ptr=0 (current stage index), availDay (earliest working-day index it can be worked),
                finishDay (set when last stage done)

for d = 0,1,2,... over the working-day calendar (STEP 7), until no unfinished orders:
    budget = fresh copy of daily capacity per key   // 每个工站今天一桶产能
    for each unfinished order in priority order:
        if order.availDay > d: continue              // 还没轮到它今天能做
        stage = order.stages[order.ptr]
        if stage.cap <= 0: continue                  // 没产能 → 排不动（STEP 8 stalled）
        if budget[stage.key] <= 0: continue          // 这工站今天产能用光了
        take = min(stage.work, budget[stage.key])
        stage.work  -= take
        budget[stage.key] -= take
        if stage.work <= 0:                          // 这个工站做完了
            order.ptr += 1
            if order.ptr >= order.stages.length:
                order.finishDay = d                  // 最后一个工站 → 这张单做好了
            else:
                order.availDay = d + 1               // 下一工站隔一天接手
```
- **One stage advance per order per working day** (即使产能有剩，也不让一张单同一天连跳两站)。
- **Next-day handoff** (`availDay = d+1`) — 对应 Wei Siang 讲的「隔一天」。
- A stage with `work > daily cap` naturally spans multiple days.

---

## STEP 7 — 工作日历 / Working-day calendar

**大白话：**
排程只数**开工天**：跳过星期天，也跳过公共假期，其它照算。
公共假期清单从 Employee 模块拿（`GET /api/kv-config/public_holidays`），跟算产能用的是同一份清单。
日期要用**本地日期**来转字符串，不能用 UTC，不然会少一天（我们在 UTC+8）。

**精确规则 / Calendar:**
```
holidays = Set from GET /api/kv-config/public_holidays   // 跟 STEP 4 同一份
fmt(date) = local YYYY-MM-DD using getFullYear()/getMonth()/getDate()
            // 千万不要用 toISOString().slice(0,10) — UTC+8 会倒退一天
isWorkingDay(date) = (date.getDay() !== 0) && !holidays.has(fmt(date))   // 跳星期天 + 跳假期
calendar[] = working days starting tomorrow, up to ~800 entries
day index d  ↔  calendar[d]   // 模拟用整数 index，最后才换成日期字符串
```
> ⚠️ 历史 bug：之前用了会变的 Date 对象 + `toISOString()`，结果每张单都「今天就好了」/ 日期跑到上个月。
> 修法：全程用**整数日序号**算，**最后**才把 `finishDay` 换成 `calendar[finishDay]` 的本地日期字符串。

---

## STEP 8 — 输出什么 / Outputs & SO rollup

**大白话：**
一张销售单可能有好几条 line（好几个工序链），整张单的「做好日期」是**最慢那条**的日期。
然后跟客人交期比一比，算「早几天 / 迟几天」。
配件类（OTHER）因为几乎没产能记录，排不动 → 标成 **stalled**，单独处理，不混进沙发/床架的预测。

**精确规则 / SO-level rollup:**
```
group finished lines by soNo:
  ready  = max(finishDate) over the SO's lines     // 最慢的一条决定整张单
  dd     = min(dd) over the SO's lines              // 最早的交期当整张单交期
  stalled = true if any line never finished (cap 0)
  late   = ready - dd  (in days; 正数=迟, 负数=早)
```

Output columns (per SO): `soNo, team, dd, ready, late, stalled`.

**配件 / Accessories (OTHER):** 实际产能 ≈ 0 → 无法预测 → 列为 stalled，请 Wei Siang 单独决定怎么处理。

---

## STEP 9 — 已知假设 & 坑 / Assumptions & gotchas

1. **公共假期已扣** — 算产能(`opdays`)和往后排程的日历，都跳星期天 + 跳公共假期。假期清单从 Employee 模块 `GET /api/kv-config/public_holidays` 拿（同一份）。
2. **`actualMinutes` 是标准工时不是真码表时间** — 裁的工站偏高，但分子分母同尺抵消，预测自洽（见 STEP 4）。
3. **裁布 FAB_CUT 用「款数/天」**（床架 6、沙发 2）— 切布是同款一起切，闸门是款数(setup 数)不是套数。一个款平均带 ~2.2 套；**一个款占超过 1 位的唯一原因是「量太多」** → 拆成多个款占位 `ceil(套 ÷ 上限)`，上限沙发 3、床架 5。**不按裁布时间加权**（同款一天切完、不会跨天；6 款/天的平均已含长短款的时间差）。锯木 WOOD_CUT 暂用「张数/天」(待该站确认)。
4. **分队用 `itemCategory` 不是卡的 `wipType`** — wipType 只有裁布卡准。
5. **工序顺序照卡的 `sequence`** — 不写死全厂顺序，沙发/床架不一样。
6. **隔一天接手** — 一张单一天最多推一个工站，下一站 d+1 才开始。
7. **日期用本地格式** — 别用 `toISOString()`，UTC+8 会倒退一天。
8. **窗口取最近 7–10 个开工天**（FAB_CUT 已确认；已用 05-21→30 核对）— 数掉星期天 + 公共假期；**星期六算开工天**；并**踢掉完成日期在未来的脏工单**（快照有 12 张）。
9. **一次跑一张快照** — 数据是当下的活动单；客人加单/改交期后要重跑。

---

## Snapshot reference (当时跑出来的结果，供核对)

> 这是写规格当天用**旧的 30 天/张数产能**跑出的结果，给 Wei Siang 对照「逻辑跑出来合不合理」。
> ⚠️ FAB_CUT 产能后来改成「款数/天」(床架 6、沙发 2 个款；05-21→30 窗口核对；大单按 ceil(套/上限) 拆款)，下次重跑全程模拟时这些日期会变。
- 183 张活动单：58 SOFA、118 BEDFRAME、7 配件(OTHER)。
- 8 张 stalled（全是配件，没产能）。
- 最早做好：2026-06-01。
- 床架全部清完：约 2026-06-22。
- 沙发全部清完：约 2026-06-30（≈ 22 个开工天，跟静态瓶颈图对得上）。

---

## 给 agent 的实作顺序 (build order)

1. 拉 `/api/production-orders`，整理成 orders + job cards。
2. 算产能 `cap[dept|team]`（STEP 4）。
3. 建工作日历（STEP 7）。
4. 每张单建剩余工序 stages（STEP 5）。
5. 按 dd 排队，一天一天模拟（STEP 6）。
6. 卷回 SO，算 ready / late / stalled（STEP 8）。
7. 输出表（每张单一个做好日期）。
