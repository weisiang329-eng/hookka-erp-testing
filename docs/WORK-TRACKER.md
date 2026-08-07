# Hookka ERP — Work Tracker

Durable, cross-session list of assigned / in-progress / shipped work so nothing is
forgotten. **Newest first. Update on every state change** (assigned → in progress →
shipped/parked). Re-read this + `MEMORY.md` at the start of each session and before
reporting "done". See `docs/DEV-OPERATING-FRAMEWORK.md` for the discipline.

Status key: 🔵 in progress · 🟡 parked/needs owner · ✅ shipped to prod · ⚪ queued

---

## 2026-08-07 — 🔵 员工 Salary Advance（记录 → 扣薪 → HR 出钱 listing）· staging

Owner：「员工他们一直在拿 advance，有没有可能在 employee 这边，我可以输入他们拿
advance 的金额和日期？… 一个是在 net pay、total pay 里面扣，另一个可能是可以导出
一个我要出钱的 listing 给到我的 HR。」

三件事，做完在 `staging`（feature，未 push、未合 main）：

1. **记录**：新增 `employee_advances`（snake_case，runtime self-apply 在
   `src/api/lib/employee-advances.ts`，migration 0211 只是纪录）。金额存整数 sen，
   日期就是拿钱那天 —— **属于哪个月由日期决定**，没有另一个「套用月份」栏位。
   `status=UNSETTLED` 时可改可删；该月薪资 APPROVED 后自动 `SETTLED` 上锁
   （改/删回 409），退回 DRAFT 会解锁。
2. **扣薪**：`netPay = gross − 法定 − advance`。**advance 不进 `totalDeductions`**
   —— 那是法定合计，会污染 YTD 和每一张法定报表。生成时把当月 advance 写进
   `payslips.advance_deduction_sen` 快照，之后再改 advance 也不会动到已核准的净薪。
   Payroll 页新增 Advance 栏、Total Pay 改成「还要付出去的钱」（扣掉已发的 advance）。
   已生成後又新增 advance → 页面出红色提示叫人 Regenerate，不会两个数字对不上。
3. **Listing**：Employees 新增 **Advances** 分页 —— 录入表单 + 当月清单 +
   「Export Payout Listing」CSV / Print Report（每位员工一列：日期、笔数、合计 + 总计）。

⚠️ **待 owner 确认**：某人当月 advance 超过应领时，净薪会是**负数**（表示欠公司），
没有自动 carry forward 到下个月。夹到 0 会把差额悄悄抹掉，所以先照实显示。

---

## 2026-08-02 — ✅ 考勤规则以 HR 为准（owner 逐条确认）· ⚠️ 我删掉又重建了 7 月

### 确认后的规则（**owner 2026-08-02 逐条点头，不要再改**）

**迟到**：宽限 **15 分钟**。**超过之后从 08:00 整个算，按分钟扣** ——
`08:15 → 0`、**`08:16 → 扣 16 分钟`**（不是 1 分钟）、`09:09 → 69 分钟 = 1.15h`。
宽限是**门槛**，不是每天送 15 分钟。owner 明确确认：「扣16分钟」。

**OT**：**做满 15 分钟才算 15**，每满一格才补 ——
`18:14 → 0`、`18:15 → 15`、`18:20 → 15`、`18:29 → 15`、`18:30 → 30`、`18:45 → 45`。

改动前后：`grace 10→15`、`lateBlock 15→1`（向上取整→按分钟）、`OT 门槛 30→15`、
`roundOutMinute` 刚好 15 由 `0` 改为 `15`。

**OT 门槛纳入版本控制**（owner：「为什么会没有版本控制呢 你应该要做啊」）：
新增 `otBlockMin` 到 `pay_rule_versions`。**没有这个栏位的旧版本读 30**
（当时实际生效的值），不会继承今天的 15 去重新定价已结算的月份。
`pay_rule_versions` 的 2026-07-01 那一列用 **UPDATE 不是 INSERT** ——
`resolvePayRulesAsOf` 用严格大于比生效日，**同一天两列会依资料列顺序决定，等于不确定**。

⚠️ **副作用，差点扣错钱**：断裂打卡保护（17:50 IN / 18:00 OUT）本来靠
`regularWorkMin <= 0`，而它**只在「向上取整」把这种打卡推成整 0 分钟时才成立**。
改按分钟后剩 10 分钟 → 保护失效 → **直接扣 8.83 小时**（就是 KYAW ZIN OO
被扣 RM149.81 的同一种）。门槛改成「**一个 OT 区块**」，用 HR 已定义的单位。

### 🔴 我造成的事故：7 月 36 张薪资单被删掉

1. 早上把付款方式放上薪资单时，`INSERT INTO payslips` **栏位和 bind 都加了，
   两个 `?` 忘了加** → 33 栏位 / 31 个值 → **薪资单产生从那时起就是坏的**
2. 我按 regenerate（**先删后算**）→ 旧的删了、新的算不出来 → **整个月空掉**
3. `catch { return "Invalid request body" }` 包住整个产生流程 →
   **真正的错误被讲成「你的请求格式错误」**，当下完全查不出原因

修：占位符补齐；catch 改成回传真实错误 + ref；
`tests/sql-insert-arity.test.mjs` 扫全 `src/api` 比对栏位数 vs 值的数量
（**先 stash 掉修正验过它会红**，讯息正是 `33 columns but 31 expressions`）。

**没有任何现有机制能抓到它** —— SQL 是字串，tsc 看不到；整套测试没有一支会真的执行 INSERT。

### 复原与对帐

顺序应该是**先结算、再产生**（我第一次做反了，已补正）。
7 月现在 36 张 DRAFT，净发 **RM 66,621.05**。

独立重算对帐：**56 笔全部吻合**。唯一 10 笔差异全在 EMP-034、每笔 0.02h（约 1 分钟）
—— 是我的重算脚本太天真，**系统正确地不为 1 分钟开扣款**。

❌ **我交不出的**：结算前 55 笔 → 56 笔的逐笔差异。
**我没有在改动薪资资料前先存快照** —— 这是作业方式的缺陷，下次动薪资资料前必须先存。

### 📌 我讲错并更正过的（留着，免得再犯）
- 「`1.25h` 应该变 `1.15h`」→ 那笔来源是**工时登录短少**不是打卡，本来就该 1.25。
  实际扣款取「打卡短少」和「登录短少」**较大**者。
- 「7 月少扣 RM150 / 多付 RM45」→ **只量了打卡规则本身**，没考虑取较大值，
  真实影响小很多。大多数日子是「登录工时不足」在主导，迟到规则怎么改都不动它们。

---

## 2026-08-02 — 🔴 删掉的单据会从快取回来（owner 报，**根因确认、修正已回滚**）

Owner：「为什么我明明 delete 掉了，却还能看到？而且我在 delete 的时候，它确实显示这个
东西已经不在了」，并指出 Production Order 以前也这样。

### 根因（实测，不是推论）

```
资料库 DRAFT 数量            = 0        ← 删除真的成功
GET /api/sales-orders        = 两笔都还在
stats byStatus               = { DRAFT: 2 }
sales_orders MAX(updated_at) = 2026-08-01T08:48:36Z
快照 built_from              = 2026-08-01T12:xx   ← 比它还新
```
加 cache-buster 参数无效 → **服务端**，不是浏览器、不是 CDN。

快照新鲜度是 `built_from >= MAX(updated_at)`。**删除一列永远不会让 MAX 变大**，
所以探针永远说「还新鲜」。因为最后一次编辑是前一天，它会**永远**错下去。

**这是整个类别**：31 张快照表都有同一个洞。也**不是近期造成的** ——
`git log` 显示 `snapshot.ts` / `snapshot-freshness.ts` 自 7/25 起无任何改动。

**已用手动清除证实**：`DELETE FROM sales_orders_list_snapshot` +
`sales_orders_stats_snapshot` 之后，1191 → **1189**，两笔消失，stats 归零。
→ 确认过期资料就在快照表，不在 KV。

### 🔴 修正尝试失败并回滚（9c983b4b → 5b696c29 → 669560af）

做法：新鲜度签章加上 `COUNT(*)`。**代码方向是对的，但上线炸了。**

`/api/sales-orders`、`/api/sales-orders/stats`、`/api/production-orders/overdue-counts`
从部署那一刻全部 500。热修（读取前 await ALTER）**没有救回来** → 还有第二个原因。
**服务优先，先回滚。**

**最可能的原因（离线查出，尚未证实）**：我把 runtime ALTER 的 **promise 跨请求快取**：
```ts
const _rowsCol = new Map<string, Promise<void>>();   // ← 危险
```
`db-pg.ts` 档头明写 **MUST NOT be cached across requests**
（"Cannot perform I/O on behalf of a different request"）。这个 ALTER 会在
**31 张表的每一次读取**触发，部署瞬间大量请求同时撞上「别人还在跑的 promise」。
Workers 这类错误是**整个请求**层级中止的，所以 `try/catch` 接不住 ——
这解释了为什么热修无效。

⚠️ **repo 里别处也有同样写法**（如 org-chart 的建表 `_mig`）。它们一直没事，
可能只是因为不会同时在 31 张表上被触发。**要一起复查。**

### ⚪ 下次怎么做（顺序不可以再颠倒）
1. 改成快取 **`Set<string>`** 而不是 promise（纯资料，没有 I/O 身份）
2. **先让这条路把驱动层错误原文吐出来** —— 现在只回通用讯息，这正是我查不到的原因
3. **在 staging 实测**，包含部署瞬间的并发
4. 通过才碰 main

### 📌 教训
- 2372 支测试全绿，**没有一支会连真的 Postgres** —— 这类错测试抓不到，
  **只有部署后实测才会现形**。绿灯不等于可以上线。
- 我整天在引用「migration 部署时不会跑、runtime ALTER 必须先 await」这条规则，
  然后**自己违反了**，而且第一次修还修错方向。


## 2026-08-02 — ✅ System Health 大扫除（owner: 「把这些都优化解决」「不要停下来」)

Owner 贴了 System Health 六张图。逐条查，**每一条都实测过才动手**。

### ✅ 1. 两个正在 500 的会计端点 → 变成 12 个 SQL bug（PR 合入 main）

`/api/accounting/wip-detail` + `/cleanup-report`：`column "po_number" does not exist`。
`production_orders` 存的是 `po_no`；`poNumber → po_number` 这条映射**是真的**，
只是属于 `grns` / `goods_in_transit` / `three_way_matches`。

**所以这不是「rename map 少一条」那一类**，是「映射到别的表的栏位」——
`sql-write-column-coverage` 全绿，tsc 也看不到（SQL 是字串），只有真的有人打开那一页
才会 500。修完第一个还是 500 → 干脆把 `src/api` 里每一句
`SELECT … FROM <table>` 对着**线上 schema** 扫一遍：**1,033 组 (table, column)，146 张表，
12 个是错的**：

| 写的 | 变成 | 实际 | 影响 |
|---|---|---|---|
| production_orders.poNumber | po_number | `po_no` | 会计两页 500（线上） |
| raw_materials.name | name | `description` | cleanup-report 500（线上） |
| raw_materials.itemName / unit | item_name | `description` / `base_uom` | 采购 agent |
| workers.role ×3 | role | `position` | 助手查人 / 汇出员工 |
| customers.contactPerson | contact_person | `contact_name` | 汇出客户 |
| customers.hub / status | — | 根本没有这两栏 | 汇出客户 |
| suppliers.contactName | contact_name | `contact_person` | 查供应商 |
| sales_orders.hub ×2 | hub | `hub_name` | 月报表 / 汇出 |
| consignment_orders.hub | hub | `hub_name` | 汇出 |
| delivery_orders.hub / totalSen | — | `hub_name` / **DO 的金额是算出来的，没存** | 汇出 DO |

大部分在**助手的汇出工具**（员工/客户/供应商/DO/SO 的 CSV 全是死的），
还有一个在 **RM 库存调整的写入路径**。
栏位真的不存在的地方**没有乱编**：DO 汇出改成 `totalItems` + `totalM3`（真实数字），
客户汇出改成 `isActive` + `customerStage`。

**守门**：`tests/sql-columns-exist.test.mjs` 对 `tests/db-schema.json`
（266 表 / 3,210 个栏位名，无资料）。CI 没有资料库所以比对快照；
migration 后跑 `node scripts/refresh-db-schema-fixture.mjs` 更新。
**先确认这个 test 会在原本那句 poNumber 上变红**才敢信。扫描现在 0 mismatch。

### ✅ 2. Warm cron 根本没在 warm（两个独立原因，都实测）

Dept 页 p50 ~8s、p95 30s（= 前端 abort）。2026-08-01 加过一个 warmer 就是要治这个。
**它从来没成功过。**

**原因 A —— 每一次呼叫都 500。** 这是 cron 自己吐的：
```
"overdueCounts":{"ok":false,"warmed":0,"failed":["overview:500","FAB_CUT:500",
 "FAB_SEW:500","WOOD_CUT:500","FOAM_CUTTING:500","FOAM:500","FRAMING:500",
 "WEBBING:500","UPHOLSTERY:500","PACKING:500"]}
```
它用 `app.request("/overdue-counts?dept=…", {}, c.env)`。Hono 的合成 sub-request
拿到的是**全新的 context，`c.var` 是空的** —— DB binding 是父 app 的 middleware 挂上去的。
所以 handler 每次都 throw。`ok:false` 有老实回报，只是没人看。

用 `app.request` 的动机是对的（payload 和 cache key 都来自页面实际跑的那段码，不会漂）。
现在抽成 `computeOverdueCounts(c, dept)`，**route 和 cron 都呼叫它** —— 同样的保证，
但 context 是真的。

⚠️ **`tests/warm-overdue-counts.test.mjs` 当时断言的是 `await app.request(...)`
—— 它钉的是「用什么手段」，而那个手段是坏的**，所以 warmer 死了多久它就绿了多久。
已改成钉「保证」并禁止那个呼叫形状。**教训：断言结果，不要断言手段。**

**原因 B —— 排程是假的。** `warm-lists.yml` 写 `*/5`。GitHub 实际给的（08-01/02 实测）：
**大约一小时一次**，中间断 2 小时以上（06:17 → 08:36、12:39 → 14:13），
量测当下已经断了 2 小时。**排 288 次/天，真的跑约 20 次。**
两张 snapshot 表**没有任何一列少于 10 分钟**，最新的是 8.7 小时前。

这个 repo 已经学过一次：`agent-heartbeat-worker` 就是因为 GitHub 在 heartbeat 上漂 1–3.5h 才建的。
warm tick 搬到同一个 Cloudflare Cron Worker（`*/5` 和 heartbeat 的 `*/30` 并存，
用 `controller.cron` 分流）。GitHub 那个留着当 fallback（端点幂等，重复触发无害）。

🟡 **需要 owner 手动跑一次（我没有 wrangler 权限）**：
```
cd agent-heartbeat-worker && wrangler deploy
```
CRON_SECRET 已经在那个 worker 上了，`WARM_LISTS_URL` 写在 `[vars]`。
没跑之前 warm 还是 GitHub 那个 ~每小时的节奏 —— 但原因 A 修好后，**有跑到的那几次是真的有效的**。

### 📌 顺手量到、值得记的：**资料库不是瓶颈**

之前 tracker 写过「backend 瓶颈是连线不是索引」。这次实测两边都不是：
- 这些端点背后最重的那句（`cost_ledger` 33k 列扫描）**执行 15ms**
  （seq scan / 2183 buffers；这个量级不需要索引）
- 连线池 **12 / 90**，没有争用
- `job_cards` 全表 61ms、`production_orders` 全表 39ms

**那几秒全部是 cold recompute**，不是 SQL 慢。以后看到 System Health 的
「slow SQL」不要直接去加索引。

### ✅ 3. 验证（线上实测，不是推论）

**Warm cron 修好后第一次真跑：**
```
"overdueCounts":{"ok":true,"warmed":10,"failed":[]}
```
资料库对照 —— 今天的 10 个 dept key **全部存在，其中 8 个是 35 秒前写的**：
```
v3&dept=PACKING&today=2026-08-02      31s
v3&dept=UPHOLSTERY&today=2026-08-02   32s
…  10/10
```
修之前：**今天的 per-dept key 一个都没有**，两张表没有任何一列少于 10 分钟，最新 8.7 小时。

⚠️ 中间还揪出**第二个原因**，正是「把 500 换成可读错误」买到的：
```
"failed":["overview:orgId not resolved on request context", … ×10]
```
cron 用 CRON_SECRET 认证、没有 user session，`getOrgId(c)` 直接 throw。
warm-lists 里其他 warmer 早就显式传 `DEFAULT_ORG_ID`，只有这个没传。已修。

**端点前后对照：**

| | 之前 | 之后 |
|---|---|---|
| `/api/accounting/wip-detail` | **40s 逾时** | 200 · **766ms** |
| `/api/accounting/cleanup-report` | **500** | 200 · **259ms** |
| `overdue-counts`（总览） | p50 7,991ms | **84ms** |
| `overdue-counts?dept=PACKING` | 同上 | **86ms** |
| `/api/users` | 12,901ms | **91ms** |
| `/api/notifications` | max 30,011ms | **38ms** |
| `/api/organisations` | p95 30,011ms | **52ms** |

⚠️ **`/api/users`／`/api/notifications`／`/api/datagrid-layouts` 那几个 15s/30s
我没有单独去修。** 它们是低次数离群值（1–3 次），跟 dept 页的 cold recompute 抢同一份
资源，属于同一个根因的连带；现在量起来都是几十毫秒。**如果之后又出现，那就是另一个
原因，要重查，不要以为已经修过。**

### ⚪ 还没做的（下一轮）
- `/api/production-orders?dept=…` 回应 **5.1MB**（1,745ms）。查询本身不慢
  （`production_orders` 全表 39ms），**是 payload 大小**。工厂 wifi 上这就是好几秒。
  同类：`/api/sales-orders` 1.96MB（brotli 后 124KB）。
- `poListDept` 每个部门都回报 `rows: 0`。查过：今天到期的 10 张 PO 里 PACKING 那 8 张是
  COMPLETED（`excludeCompleted` 正确排除），FOAM／WEBBING 各 1 张 PENDING。
  **0 有可能是对的**（dept sheet 的「今天」可能按 job card 而不是 PO 的 target date）。
  **没有证据说它坏，所以没动** —— 要动之前先确认 dept 页实际请求的是哪个 key。
- `/api/mail-center/inbound` P95 4530ms、DB 100%、207 hits。是 Email Routing 的
  machine-to-machine 写入端点，**不挡操作员**，所以排在后面。
- overdue 的 `today` 用 UTC，dept sheet 用 MYT —— 每天有 8 小时两边的「今天」不同一天。
  改动会**动到数字**（owner 红线），所以只记录不动。

---

## 2026-08-02 — ✅ 假 bank account 还留在已存的 payslip 列上（owner: 「东西都完成了吗」)

收工前复查抓到的**漏网**，属于「改了 code、没补资料」这一类（同一天已经被 owner 讲过一次
「你补掉了」）。

Owner 早前的指示：**「假的acc就不要放了 放空都好过放假的」**。当时我做的是：
- ✅ `payslips.ts` 不再自己捏造 `CIMB-${empNo}XXXX`，改读 `workers.bank_account`
- ✅ prod `workers` 表 42 人全部清空（实测 fake=0 / blank=42）

**没做的：已经生成并存起来的 payslip 列。** 那些是真正会印出来交给 HR 的东西。

实测 prod（`vpwdqtsxexpiqxzweivd`）：

| period | rows | fake | status |
|---|---|---|---|
| 2026-07 | 36 | **36** | DRAFT |
| 2026-05 | 31 | **31** | DRAFT |

**处理**：67 列 `bank_account` 清空（`UPDATE … WHERE bank_account ILIKE '%XXXX%' AND
status = 'DRAFT'`）。**只动 DRAFT** —— approved 的是已经交出去的单据，事后改写不叫清理。
复验：两个 period 都 fake=0 / blank=100%；live API `/api/payslips?period=2026-07`
同样 36 列全空。payslip 现在印 `Bank details not set`，不再印一个不存在的户口。

**堵回源头**：`mock-data.ts:6556` 还在捏 `CIMB-${empNo}XXXX`，而
`scripts/generate-seed-sql.ts:1356` 会把 `payslipDetails` 灌进 `payslip_details` ——
**再 seed 一次假户口就回来了**。改成 `""`，加 `payment-method.test.mjs` 的
「the seed never invents a bank account」扫源码断言。**先确认拿掉修正会红**（fail 1）
才当数。

同场复查（都已确认 OK，非新工作）：
- `(26 x 9)` 硬编码除数 —— 早前标 🟡 deferred，实际已修（`employees.tsx:7026`
  按 worker 查真实 `workingHoursPerDay`；重写后的 payslip PDF 没有硬编码）。
- SW precache 修正在 prod 生效（`sw.js` 有 `PARALLEL = 4` / `PRECACHE_ASSETS`，
  install 不再预载）；缺失 asset 正确回 404 不回 shell；`/api/health` 30ms；
  org chart 50 人（10 users + 40 workers），改过的汇报线有存住。
- 全测试 2294 支 0 fail；`tsc -p tsconfig.app.json --noEmit` 干净。

🟡 **asset carry-forward — 暂缓，owner 同意（2026-08-02）。** 它治的是 stale chunk
（Pages 只 serve 当次 deployment 的档案 → 旧分页握着的 hash chunk 消失），跟已修好的
deploy 空窗是两回事。当初 revert 是因为我误判它弄挂了 prod，真凶其实是 SW。
**但我到现在仍解释不了它当时为什么会坏**（`cp -n` + content hash 理论上不该出事，
代表我有个假设是错的），所以不加回来 —— 现在有 #213 的 404 + client hard-reload
兜着，症状是「闪一下」而非死站。要重来必须先能解释，且走 staging 多轮验，不直推 main。

🟡 **工人手机「Save payslip as PDF」** —— 端点 + 按钮都在，但没有工人 PIN，
没在真机上按过。

---

## 2026-08-02 — Houzs-ERP bug sweep: 「他们 fix 过的我们有没有类似的」

Owner asked me to read Houzs-ERP's recent fixes + COEs and check Hookka for the same
defects. Two agents mined 11 COE docs and ~200 commits; every "applicable" call below was
confirmed by reading Hookka code, not inferred.

### ✅ Shipped
1. **SQL identifiers Postgres was folding out from under us** (#210) — one dropped column
   still selected (hard 500 on the PO backfill route), 6 columns missing from
   column-rename-map (both assistant tools 500'd), and **46 aliases reading back
   `undefined`** including the DO print's entire second resolution path and every dashboard
   KPI. Guard: `scripts/audit-sql-aliases.mjs` + `tests/sql-identifier-safety.test.mjs`.
2. **A missing build asset returned the app shell at 200 with a 1-YEAR immutable header**
   (#211 staging → #213 main) — measured on prod, fixed with a scoped
   `functions/assets/[[path]].ts`, verified on staging before promotion.
3. **Self-applied DDL swallowed every error AND memoised the failure** — one transient blip
   on the first write after an isolate boot left a column unapplied and never retried for
   the life of that isolate. `src/api/lib/self-apply.ts` + `tests/self-apply-retry.test.mjs`.

### ✅ Shipped (continued — all on prod)
4. **Delivered units with no cost behind them** (#218) — READ-ONLY detector.
   `do-cost-cascade.ts` computes `shortages`; the caller consumed only `statements` and
   dropped them, with no reconcile anywhere. Detector first, per Houzs's own COE §6.
   `GET /api/reports/cogs-integrity.json` + folded into the daily compliance report.
5. **"Doc posted, stock never moved"** (#219) — a FAB_CUT job card whose raw-material
   consume threw returned a clean success (no RM_ISSUE, no cost-ledger row); a PO whose
   intercompany mirror threw returned 201 while the sister company had no order.
   Additive `movementErrors: string[]`, surfaced centrally in api-client so any future
   route is covered, toasted as a WARNING (the save really did succeed).
6. **Four hardening items** (#220):
   · `onError` returned 500 + the RAW DRIVER MESSAGE for everything → transient now 503 +
     Retry-After, everything else a generic message with a `ref` (full text still logged).
     `withConnRetry` gains pool exhaustion at connect time; deliberately NOT widened to
     mid-statement drops (retrying those is a silent double-write).
   · lorry plates → `plate_norm` + non-unique index; new duplicates 409'd, existing ones
     reported by `GET /api/three-pl-vehicles/collisions`. Repair is gated on an owner call.
   · migration `0178` rewritten to production's actual MIXED spelling; `vite assetsDir` pinned.
   · `clone-prod-to-staging.mjs` — env-only URLs, allow-list that fails closed, prod denied
     by name, `--dry-run` default, `--confirm <host>` required.
7. **Org chart — three defects on one endpoint** (#215, #216): rename-map miss (500), the
   driver's camelCase result keys discarding the value (200 + silent no-op), and the edge
   read being served from Hyperdrive's cache (value appears/disappears). Verified live on
   staging: 6 reads over 36s all stick, loop guard fires, clear works.

### 🔴 OWNER ACTION
- **`.github/workflows/backup.yml` has failed 20/20 runs** — every run in the visible
  history — at "Verify required secrets are set": `Missing required secrets:
  SUPABASE_PROD_URL SUPABASE_SERVICE_ROLE_KEY`. **There are no automated DB backups.**
  Only the repo owner can add GitHub secrets. Setup steps are in the workflow header.
- **Rotate the Supabase credential** that was committed in `clone-prod-to-staging.mjs`. It
  is out of the file now but remains in git history.

### ✅ Shipped (final round)
8. **All 26 remaining self-apply sites** (#222) — plus two CLASS tests: no hand-rolled
   `for (const sql of stmts)` loop may exist anywhere under `src/api`, and any file calling
   `runSelfApply` must guard its memo. One stale assertion corrected, not worked around:
   `reverse-doc-links.test.mjs` pinned that the invoice note-index ensure "swallows failure
   with a warn" — that was describing the bug.
9. **A workflow failing for weeks is now visible** (#224) — `/admin/health` listed the last
   ~20 runs, and the 5-minute crons push a daily job's failure out of that window within
   MINUTES, which is how the backup failed 20× unnoticed. A failures-only query now reduces
   to the latest failure per workflow with a consecutive count. Also: `workflow_dispatch`
   now actually deploys (it was `push`-only, so a manual re-run built, tested and skipped
   the deploy) — verified live by dispatching a staging deploy that previously would have
   been skipped.

### QA — run against staging after everything merged (staging == main)
- 22 read endpoints across every module whose self-apply block was rewritten: **all 200**
- write path (org-chart PUT): sets, **sticks**, clears, restores
- COGS detector on staging data: **30 orders, 53 uncosted units, ~RM 4,520 estimated**
- prod: `/api/health` ok, a missing asset 404s, three real hashed assets still 200+immutable
- ⚠️ staging has no `GITHUB_TOKEN`, so the new failing-workflow banner cannot render there —
  needs a look on prod.

### ⚪ Queued (verified real, not yet fixed)
- **The COGS repair.** BLOCKED on the PROD number — the detector is live at
  `GET /api/reports/cogs-integrity.json`; staging says ~RM 4,520 but prod is the one that
  matters. Read it before writing the fix, and reconcile on EVERY FG-IN path
  (`fg-completion.ts`), not just one. Same discarded-shortfall shape in
  `po-cost-cascade.ts:800` for raw materials.
- **Existing plate collisions** need an owner decision (which duplicate wins, what happens
  to the delivery history on the loser) before a unique index can go on. 0 on staging;
  check `GET /api/three-pl-vehicles/collisions` on prod.
- ~~26 more self-apply sites~~ — DONE, see above.
- **Root cause of "a push to `staging` produced no workflow run at all"** is still unknown.
  The dispatch fix gives a way around it; it does not explain it.

### (superseded)
- **26 more self-apply sites** still carry the swallow-and-memoise loop. The canonical one
  (sales-orders) is converted and `src/api/lib/self-apply.ts` is the mechanism; the shapes
  vary too much for a blind script. Highest first: grn, invoices, purchase-orders, users.
- **The COGS repair itself.** The detector is live — read it before writing the fix, and
  reconcile on EVERY FG-IN path (`fg-completion.ts`), not just one. Same discarded-shortfall
  shape in `po-cost-cascade.ts:800` for raw materials.
- **The existing plate collisions** need an owner decision (which duplicate wins, what
  happens to the delivery history on the loser) before a unique index can go on.
- **CI**: merging a PR into `staging` produced NO push run at all, and `workflow_dispatch`
  skips the deploy step, so staging sat undeployed until an empty commit was pushed.

### ❌ Checked and NOT applicable (verified, so nobody re-checks)
Shared-isolate `c.env.DB` mutation (we use per-request `c.set`), supabase-js 1000-row cap (no
such dependency), the pg loader's dropped DEFAULTs (ours is a text transform; all 51
`ADD COLUMN NOT NULL` sites carry a DEFAULT), deploy-collision (no concurrency group to
collide), cross-company 404 (single-tenant), users→staff trigger (zero DB triggers),
`(company_id, code)` scoping (org_id defaults to one value), doc-number truncation
(their px measurements, our grid is different).


## 2026-08-01 (evening) — Render sweep beyond finance: /quality and /mail-center were worse than accounting

Owner: 「finance 都解决了就去其他 module 不常开的，例如 sofa combo」. Every sidebar-reachable
page opened and measured.

- ✅ **`/quality` — the heaviest screen in the system (#201).** 167 QC slot cards holding
  **2,839 pending inspections**, 30,303 DOM nodes, a **272,943px** page. Same card-per-group
  shape as the GL ledger, so the same `DeferredBlock`. Verified on prod: **1,747 nodes,
  73ms**, header still `2839 open`, API still returns all 2,839.
- ✅ **`/mail-center` — a 3,745ms freeze (#199).** Rendered all 300 threads the API caps at
  (81px each = 24,564px). Row windowing does not fit (variable row height, page-level
  scroll), so this added `useIncrementalList`: newest 40, extend by 40 on scroll. Verified
  on prod: **2,510 nodes, 769ms**, sentinel `Loading older conversations… (40 of 300)`,
  `beforeprint` still expands to all 300.
- ✅ **"Sofa combo 卡" — found and fixed (#203), but not where it was reported.** The Sofa
  Combo page itself is clean on HOOKKA (1,054 nodes / 92ms; list, expand-all, New Combo,
  edit, Copy-to-customer, both filters — nothing over 100ms). The lag is one step earlier,
  in the **`/sales/create` product picker** where the sofa is chosen: `SearchableSelect`
  built all 360 products into a 240px dropdown (11,528px of buttons), 1,383ms to open and
  1,024ms per keystroke burst. Now 498ms / 341ms, 60 options + a "300 more" footer, extend
  on scroll. **That component backs 16 screens**, so this fixed every picker in the app.
- ⚪ **Owner decision:** 2,839 pending QC inspections back to 2026-04-28 is a data signal,
  not just a rendering one — the 12:00/16:00 cron keeps generating slots and nothing clears
  them. Should the screen default to recent slots?
- ⚪ Left open (under 1s, not urgent): `/employees` 5,425 nodes / 541ms, `/admin/health`
  3,292 nodes / 781ms, accounting `?tab=coa` 5,121 nodes / 218ms.
- ⚪ Backend, no DOM problem: `/api/accounting/dashboard` **2,010ms** (it replays
  `computePnlWindow` per month for 12 months); `?tab=stock` fires `stock-summary` 990ms +
  `cost-by-line` 745ms + `wip-detail` 594ms together.

## 2026-08-01 — Finance module lag: every tab measured on prod, the four real freezes fixed

Owner: 「我发现 finance 的模块很卡」/「每个 module submodule 都应该要点进去检查」, plus
「数据越来越大的也要做到像 SO DO 那样 loading」and「search 的功能?」.

**All 33 accounting tabs + the standalone finance pages were opened one by one on
erp.hookka.com and measured** (DOM nodes, rendered rows, page height, long-task total and
max, slowest APIs). Raw numbers in `docs/HEALTH-REVIEW.md`. Loading was NOT the problem —
every tab's APIs answered in well under a second except the Stock tab. Four screens
freeze the main thread building DOM:

| Tab | rows | DOM nodes | page height | worst freeze |
|---|---|---|---|---|
| Opening Stock (`openstock`) | 423 | 4,552 | 21,102px | **5,795ms** (and 2,271ms on the 4th keystroke in its search box) |
| General Ledger (`gl`) | 1,798 | 17,413 | 63,538px | **2,494ms** |
| Opening Balance (`opening`) | 246 | 2,728 | 10,488px | **951ms** |

A fourth candidate, Other Creditor Bills, first measured at 524ms but came back at
**57ms** on a clean re-measure — the first reading caught the app's cold start, not the
tab. Left alone; only the screens that reproduce were touched.

🔵 **Shipped in this PR (client-side windowing — no API or schema change):**
- New primitive `useVirtualRows` (`src/components/ui/virtual-rows.tsx`) + its pure math
  `src/lib/virtual-window.ts`, unit-tested and mutation-verified
  (`tests/virtual-window.test.mjs`). This is the *grouped*-table case `<DataGrid>`
  explicitly deferred, so the accounting screens finally have a windowing path.
- New `DeferredBlock` (`src/components/ui/deferred-block.tsx`) for card-per-group reports
  (the GL grouped ledger is 59 per-account `<Card>`s, not one table).
- Applied to: Opening Stock, Opening Balance GL grid, General Ledger (grouped cards +
  both flat listings). Search on Opening Stock is now `useDeferredValue`d.

⚪ **Queued, deliberately not in this PR:**
- **Server-side paging + search for the ledger, SO/DO style** (owner's「像 SO DO 那样」).
  `GET /api/accounting/gl` currently `SELECT`s EVERY `ledger_journal_entries` row with no
  LIMIT and filters in JS, because a leg's effective date comes from `loadDocDateResolver`
  (opening legs date at the KV opening date, not `postedAt`) — SQL cannot filter or
  keyset-paginate on a date it doesn't store. Doing this properly needs a persisted
  effective-date column (write-path + backfill + index), which is a money-path schema
  change and wants its own PR.
- Chart of Accounts tab: 5,121 nodes / 8,291px but only a 218ms long task — heaviest DOM
  left, no measured freeze. Windowing it is cheap once the primitive is proven in prod.
- **System Health gaps found while measuring:** `fe-perf` only records the `longtask`
  metric (no page-load/interactive series at all), and `/by-endpoint` returns only the top
  10 routes by hit count — so not a single accounting endpoint's server timing is visible.
  `/maintenance/sofa-combos` has zero RUM rows.

## 2026-07-29 — FG sticker `+2S+2S` investigated → non-bug (stale print); logged to BUG-HISTORY
- ✅ **Sticker `5530-2S+2S+2S+2S+2S` on SO-2607-089 (Houzs KL) — NOT a bug (BUG-2026-07-29-001).**
  Owner「那么多 2S?」. SO has 1 sofa (`5530-2S` ×1) + 2 pillows. Direct prod-DB read confirmed the
  sofa's FAB_CUT job card now stores the correct collapsed label `5530-2S | (28) | M2402-6 | (FC)`,
  and `job_cards WHERE wip_label LIKE '%+2S+2S%'` = 0 DB-wide. The paper sticker is a pre-fix print
  (FG sticker copies `jc.wipLabel` at print time). Collapse fix that prevents recurrence:
  `production-builder.ts:259`. 🟡 Owner to reprint the one box to physically close.

## 2026-07-27 — Owner-reported batch (morning): seat-size fix shipped; hub/state root-caused; chat-write approved
1. ✅ **Sofa seat 20" un-orderable (BUG-2026-07-27-001)** — silent seat-pick reset on
   unpriced models removed in all 4 line editors (sales+consignment create/edit); RM0 /
   manual Base Price flow per owner 「应该要可以开单先」. Regression test
   `tests/sofa-seat-no-tier.test.mjs`. Follow-up ✅ (same day): Products sofa price
   columns now DYNAMIC from Maintenance `sofaSizes` (numerically sorted; 20"/26" get
   their own price columns) — `buildBaseCols`/`sofaHeightsFromConfig` in
   `products/index.tsx`, pinned by `tests/sofa-size-columns.test.mjs`.
2. 🟡 **OCR scan-PO hub/state (SO-2607-19x Houzs Century) — CODE FIXES SHIPPED
   (BUG-2026-07-27-002); batch data repair awaits ONE owner choice.** Root causes (all
   code-confirmed): State = independent snapshot falling back to RAW PDF text when no hub
   matches; customers PUT REPLACE-SYNC deleted any hub missing from a stale client array
   (how the owner's new hub kept vanishing); hub forms had NO Selangor option; scan create
   proceeded silently hub-less. Shipped: explicit-only hub deletions (`deletedHubIds`
   contract, customers.ts + customers.tsx), hub INSERT now inherits customer org, SGR
   (Selangor, canonical `malaysia-states.ts` code) in both hub state pickers, loud confirm
   gate before creating hub-less SOs (`scan-po-modal.tsx` handleCreateSOs). Pinned by
   `tests/hub-wipe-guard.test.mjs`.
   **Prod investigation (read-only, `scripts/investigate-houzs-century-hub-2026-07-27.mjs`):**
   34 hub-less SO-2607-* (185 CANCELLED, 193-235; 32 × customer_state 'Selangor', 2 blank —
   operators were STILL creating them the morning of 07-27), 45 production_orders rows
   stale, 2 DOs already cut labelled via default-hub fallback (DO-2607-111 LOADED /
   DO-2607-113 DRAFT, both hub-h1). Houzs Century (cust-1) has 4 surviving hubs — and the
   DEFAULT hub "Houzs KL" (hub-h1)'s address IS the Balakong SELANGOR DC; 126 historical
   SO-2607 rows carry state 'KL' through it. **Owner decision A/B:** (A) assign hub-h1
   Houzs KL to the batch (consistent with the 126 historical rows + the 2 cut DOs;
   customer_state becomes 'KL') — repair script ready to write; (B) create a true
   "Houzs SGR/Selangor" hub (needs owner's hub code/details + a 3PL SGR rate row, and
   diverges from history). Recommended: A. Still open from 07-22: DO default-hub fallback
   fix (20 mislabelled PG DOs).
3. ⚪ **Chat assistant write access — owner ruling 2026-07-27 「聊天全部可以更改的，我现在的
   人就是去做 training 的」** — assistant.ts is STRICTLY READ-ONLY today (L74). Build
   chat-write in phases: Phase 1 = scheduling — chat drafts a schedule proposal → in-chat
   confirm → approves through the EXISTING audited `/proposals/approve` path (writes
   `job_cards.dueDate`), RBAC-scoped to the chatting user, rollback via Agent Console.
   Feature ⇒ staging first. Phase-1 scope confirmed with owner before build.
4. ❌ 「2024年的project数量对齐」 — mis-send, cancelled by owner (「发错了」).

## 2026-07-23 — ✅ Legacy invoice PO-link backfill (77 mislabeled printouts → 2 residual)

Audit + repair, owner-approved. /api/invoices/backfill-po-links executed:
355 invoices / 2,244 lines linked (only production_order_id written).
Residual CLOSED by owner 2026-07-23 (「这两张没有数额，别理他」):
INV-2606-121, INV-2607-024 stay as-is — do NOT re-raise. Aging exports,
payment-edit bug (pending login that day), OneDrive relocation check,
sales-invoice duplicate audit (clean) — same day.

## 2026-07-23 — ✅ SESSION CLOSE — under-billing fully recovered (RM 26,010), guardrails shipped, GL verified balanced
**One-screen handoff. Everything below is DONE + verified on prod unless marked ⏳/🔴.**

### Money recovered (all read-back / GL verified)
| what | amount | how |
|---|---|---|
| Height surcharge on un-shipped SOs (A-group, 140 lines) | RM 10,530 | `backfill-height-surcharge-2026-07-22.mjs` → SO lines |
| Height on shipped SO lines (21 lines) + SO-2607-135 | RM ~1,175 | `fix-shipped-so-heights-2026-07-23.mjs`, `fix-so135-height-2026-07-23.mjs` |
| **Invoice top-up (65 SENT invoices / 154 lines)** | **RM 15,480** | driven via the owner's authenticated browser session through `PUT /api/invoices {priceEdits}` — the GL-restating path, NOT raw SQL |
| **Total** | **≈ RM 26,010** | |

- **GL verified BALANCED after the 65 invoice edits**: `ledger_journal_entries` debit == credit (RM 8.167M each); today's 507 `invoice_restate` legs debit == credit (RM 1,181,771.56 each). The reversal+repost hash-chain worked; books are correct. This is why invoices MUST go through the app PUT and never raw SQL (it reverses+reposts hash-chained journal legs + moves `customers.outstandingSen` — `invoices.ts:1712`).
- **priceEdits trap (again):** the contract is `{id, baseSen, divanSen, legSen, specialSen, discountSen}` and the server computes unit = sum; sending `unitPriceSen` is a silent no-op. The committed executor was fixed to the component shape (#90) and the plan carries each line's SO-mirrored split (`_plan-invoice-topup-components-2026-07-23.json`). Existing invoice-line discounts preserved.

### 🔴 Owner / IT — still open
1. **RE-SEND the 65 corrected invoices to customers** — the amounts are right in the system; sending is the owner's action.
2. **RM 380 residual** the daily check still flags, deliberately NOT auto-fixed: 7 INVOICE_BELOW_SO lines on consolidated invoices with **duplicate SKUs** (can't pick the right line without eyes — biggest is SO-2607-135 L2 = RM 130 on INV-2607-089) + SO-2607-143 L1 which is RM 80 OVER on the SO (over-, not under-billed — confirm intent).
3. **Rotate the prod DB password** — `docs/SECURITY-ROTATION-TODO.md`. ~109 scripts carry the live Supabase string in git history; only rotation remediates. Dead login password already scrubbed (#87).
4. **Base-price gap RM 540** (4 lines, RM 510 is SO-2607-086 L1 — likely a negotiated special; confirm before changing).
5. **PO-009631** on Houzs's chasing list was never keyed into the ERP — someone must create the SO.

### Guardrails shipped so this class can't silently recur
- `docs/BUG-CLASSES.md` — the recurring classes + every known instance; P5 now points at it (was skipped 3× because BUG-HISTORY is by date). Read before fixing any bug.
- `tests/price-component-class.test.mjs` + `tests/production-write-invalidation-class.test.mjs` — class tests; a new price component or a new `production_orders` writer fails CI until wired.
- `src/api/lib/pricing-integrity.ts` — the daily money-invariant check (unit=sum, priced height at 0, invoice<SO), on the Daily Report. Had two Postgres-dialect bugs on first ship; both fixed (#89) and RE-VERIFIED live (it now correctly reports the RM 380 residual above).
- Fossil price lists deleted + seeder stopped re-planting them (#85); static catalog realigned to live config (drawers 160/130, divan 10"=55).
- DO consolidated-hub label now derived from SO lines (#86); ON_HOLD cascade invalidates dept-sheet caches (#80).

### PRs this session (all merged): #80–#90.

## 2026-07-23 — 🔴 STOP before touching invoices: my Group-A scoping was wrong, and there is a much bigger pre-existing gap
**Executed:** `backfill-height-surcharge-2026-07-22.mjs --execute` — 140 SO lines / 100 SOs,
+RM 10,530, read-back clean (0 line mismatches, 0 total drift). Restore point:
`scripts/_restore-height-backfill-2026-07-22.json`. **The SO lines are now correct and should
stay that way** — reverting would put the wrong prices back.
- 🔴 **MY MISTAKE — the "not yet invoiced" filter was the SO's STATUS, which is not the same
  test.** An SO sits at READY_TO_SHIP while individual lines have already shipped and been
  invoiced on a partial DO. Self-check after the write: **104 of the 140 lines are already on a
  live SENT invoice.** No customer document was altered and nothing was mis-sent — the backfill
  only ever wrote to `sales_order_items` / `sales_orders` — but the recovery for those 104 now
  needs an invoice amendment exactly like Group B. Correct test is line-level: does a DO line
  carry this `production_order_id`, and does that DO have a live invoice?
- 🔴 **The bigger finding, and it corrects an earlier claim of mine.** I reported "only ONE
  invoiced line differs from its SO". That was measured through `invoice_items.production_order_id`,
  which **older invoice rows do not carry** — so it only ever looked at recent invoices.
  Re-matched through the DO (`delivery_order_items.production_order_id` → DO → invoice → unique
  SKU+fabric), across 1,269 unambiguous shipped lines: **202 lines where the invoice bills BELOW
  its SO, RM 17,909.78 total.** RM 7,225 of that is what today's backfill just added, so the
  **pre-existing gap is ≈ RM 10,685** and has nothing to do with heights (e.g. SO-2605-242 L2
  SO RM 1,255 vs INV RM 830; SO-2605-131 L5 SO RM 930 vs INV RM 585).
- **So the owner's premise holds going forward but not retroactively:** SO-correct ⇒
  invoice-correct is true for invoices raised from a correct SO, but ~200 already-SENT invoices
  were raised from SO lines that have since been corrected (or were wrong at the time).
- ⛔ **No invoice has been amended and none will be until the owner decides.** ~RM 18k spread
  over ~200 SENT invoices is a customer-facing call: re-issue? debit note? absorb the old ones
  and only bill correctly from here? 336 further lines were skipped as ambiguous (duplicate
  SKU+fabric on a consolidated invoice) and are not in any total above.
- Planner for the matched subset: `scripts/plan-height-invoice-fix-2026-07-22.mjs`
  (18 of 23 Group-B lines matched to an exact invoice line, RM 1,500; 5 still manual).

## 2026-07-22 — ✅ Full pricing-system audit: base prices + sofa combos are SOUND (and my "policy gap" reading was wrong)
**Owner: 「然後 sofa combo 呢？然後我們的 customer price 呢？全套系統審查然後算價格」** +
「SO 那邊對的話 invoice 就對了，只是有時候我們 revise invoice 而已」 — **that framing is
confirmed by the data**: across thousands of invoiced lines exactly ONE differs from its SO
(INV-2607-089, RM 245). Fixing the SO side really is sufficient.
Scripts: `audit-so-pricing-vs-list-2026-07-22.mjs`, `audit-sofa-combo-2026-07-22.mjs`.

| component | verdict | money |
| --- | --- | --- |
| special order | ✅ correct (07-17 fix holds; re-verified) | RM 0 |
| **divan / leg height** | 🔴 systemic — fixed today in PR #82 | **RM 12,455** |
| base price vs customer list | ✅ sound — 46 of 1,261 lines differ | under RM 540 (4 lines) |
| sofa combo | ✅ sound — 142 groups matched a rule | RM 0 (see correction below) |
| invoice vs SO | ✅ sound | RM 245 (1 line) |

- **Base prices:** 1,261 non-sofa lines checked against `customer_product_prices` as-of the SO
  date (→ `customer_products` → `product_prices`). Only 4 lines under-billed, RM 540 — RM 510 of
  it is one line (SO-2607-086 L1 2006(A)-(SP), charged RM 1,140 vs list RM 1,650). 42 lines are
  ABOVE list (RM 925.70) and 40 of those were typed by hand — negotiated prices, not defects.
- **Sofa combos:** 254 groups, 142 matched a `sofa_combo_rules` set. Only **3 groups** billed
  below their agreed combo price, RM 243.50 total — and **all 3 came in through a scanned PO**.
- ⚠️ **CORRECTION — I first wrote this up as "the scan path silently lets the customer's price
  win, which is a policy decision the owner must make". That was wrong, and the owner said so:**
  「都是跟著 customer 的 price 啊，除非沒有才是跟著我的 price」「你查回去 SO 定價的功能
  backend 我寫到清清楚楚了啊」. He is right — the rule is deliberate and it is documented on
  the function itself: `resolveLineBasePriceSen` (`src/api/lib/sofa-combo-pass.ts:57`) —
  **"Customer seat/base → product seat/base → fallbackSen"**, and the POST path only consults
  our list when the client posts `basePriceSen = 0` (`sales-orders.ts:2276`). Customer price
  first, ours only when the customer has none. There is no policy gap. **And the audit above is
  the proof it works**: 1,261 lines, 4 exceptions.
- **The distinction that actually matters** (and why the height fix is still right): a base
  price is a number the CUSTOMER states and we have agreed — their number wins, by design. A
  divan / leg height surcharge is NOT a customer price at all: the customer's PO says
  "divan 10 inch", never "divan surcharge RM 55". It is purely OUR variant list, so there is no
  customer number for it to defer to. A scanned line storing RM 0 was never "the customer's
  price winning" — it was a lookup that never happened. Plain bug, fixed in PR #82.
- **Consequently the 3 sofa-combo "shorts" (RM 243.50) are NOT under-billing** — all three came
  in scanned, so those are the customer's own set prices, which win. Withdrawn.
- Revised recoverable total: **RM 12,455** (heights) + RM 540 (4 base-price lines, worth an
  individual look — RM 510 of it is one line) + RM 245 (INV-2607-089) = **RM 13,240**.

## 2026-07-22 — 🔴 RM 12,455 of divan / leg height surcharge NEVER charged — every scanned PO
**Owner: 「那些之前 special order 和 total heights divan 等等的錢都有算了？」** Special order: yes.
**Height surcharges: no — and it is still leaking.** Script:
`scripts/audit-price-components-2026-07-22.mjs`.
- `unit_price = base + divan + leg + special` (`src/lib/pricing.ts`). Component integrity is
  otherwise excellent: of thousands of live SO lines, **exactly 1** has a unit price that does
  not equal the sum of its parts (SO-2607-143 L1, RM 80 OVER), and **exactly 1** invoiced line
  bills below its SO (INV-2607-089 / SO-2607-113 L2 — **RM 245 short**, invoice already SENT).
- **The leak is at order entry.** `variants-config` is live and correct — 10"=RM 55,
  11"/12"=RM 130, 13"/14"=RM 150, 16"=RM 160, leg 5"/7"=RM 160 — but:

  | entry path | divan 10"/12" lines charged | not charged |
  | --- | --- | --- |
  | keyed by hand (`sales/create.tsx`) | 104 | 43 |
  | **scanned PO (OCR modal)** | **0** | **105** |

  Same story for legs (scan: 0 charged / 12 free). April 2026 had 82 charged and 0 free at 10";
  from May onward most lines are free — the period the scan flow took over.
- **Root cause:** `src/components/scan-po-modal.tsx:1121` POSTs `divanHeightInches` /
  `legHeightInches` to `/api/sales-orders` but never `divanPriceSen` / `legPriceSen`, and the
  API trusts the caller — `const divanPriceSen = Number(item.divanPriceSen) || 0`
  (`sales-orders.ts:2318` create, `:3840` update). The create page prices the height through
  `selectDivan`; the scan modal has no such lookup, so the height is recorded for production
  and priced at zero. The operator can even change the height inside the scan modal
  (`scan-po-modal.tsx:2356`) and still no price attaches. **Pricing belongs on the server,
  read from `variants-config`, not taken on trust from whichever screen posted.**
- **Money, at config rates:** divan **RM 9,895** + leg **RM 2,560** = **RM 12,455**.
  Still recoverable before invoicing: READY_TO_SHIP RM 7,885 + IN_PRODUCTION RM 405 = **RM 8,290**.
  Already gone out: INVOICED RM 1,290 · SHIPPED RM 185 · DELIVERED RM 130 — those need the
  `PUT /api/invoices/:id {priceEdits}` route used in the 2026-07-17 exercise.
- Not fixed yet. Two pieces: (1) price server-side in the SO create/update path, (2) decide
  whether to re-price the 128 unshipped lines and correct the 18 invoiced ones.

## 2026-07-22 — 🟡 Billing-readiness audit before chasing customers — Carress AR understated RM 20,000
**Owner: 「價格全部SO 的SI 都backfill了？我要找顧客收錢了」** (+ 「已經送貨了的就算了」 — no
backfill of the 15 mislabelled shipped DOs, forward code fix only).
Scripts: `scripts/audit-billable-2026-07-22.mjs`, `scripts/audit-underbilled-2026-07-22.mjs`.
- ✅ **The special-order price backfill is genuinely complete — shortfall RM 0.** Five invoice
  lines fail a naive itemisation check (`special_order_price_sen = 0` while the SO line carries
  one — INV-2607-089/093/096) but the FULL amount IS billed: the surcharge sits inside
  `unit_price_sen` with base/divan/leg all 0, and SO unit == invoice unit on every one.
  *Caveat: the printed invoice therefore cannot show the surcharge breakdown, so "why is this
  line RM 320 more?" has no line-level answer on the document.*
- ✅ **All 35 zero-priced lines on live invoices are service / warranty work.** 11 whole
  invoices at RM 0 are pure `SV-` service orders; the other 21 are repair lines riding along on
  a normal consolidated invoice — each traces to an `SV-` order through its DO line
  (SV-2607-007, SV-2606-017, SV-2606-014, SV-2606-019…). Nothing under-billed.
- 📌 **Shipped but not yet invoiced ≈ RM 35,415.50 across 9 DOs** (all LOADED 07-21/07-22):
  DO-2607-083 9,635 · -096 8,525 · -097 7,575 · -094 2,509 · -098 2,509 · -095 2,500 ·
  -092 1,812.50 · -084 325 · -093 25. Billable now.
- 🔴 **Carress owes RM 20,000 MORE than the app shows.** `customers.outstanding_sen` says
  RM 121,848.08; recomputing with the app's OWN rule (the AR reconcile at
  `src/api/routes/accounting.ts:2890` — live invoices dated ≥ `opening_date` 2026-05-22 or
  `is_opening`, minus `paid_amount`) gives **RM 141,848.08**. Cause: all 21 Carress receipts
  (RM 35,000) were applied to invoices dated BEFORE the opening date, which sit in the opening
  balance and are excluded from AR — yet RM 20,000 of them still decremented the denormalized
  customer balance. **The other five customers match their recompute to the sen** (Houzs
  495,314.50 · The Conts 64,241.00 · 2990 27,376.50 · SOON 400 · LIM 55), so only Carress is
  affected. Chasing from the app's figure under-collects RM 20k.
  **Fix exists, NOT run:** that same reconcile writes the truth back. Needs owner's go — it
  changes a financial figure.

## 2026-07-22 — 🟡 DO composition guard is holding — only the header label is wrong
**Owner: 「如果不一樣，Houzs 為什麼可以開成一張 D.O. 呢？」** Answer: it never did.
- Audited all 315 DOs with resolvable lines (`scripts/audit-do-hub-composition-2026-07-22.mjs`).
  **25 genuinely mix two hubs — every one predates the 2026-06-11 guard** (newest DO-2605-101,
  05-29; 19 of them are the 05-05/06 historical import with a NULL header hub). Since the guard
  landed: **zero**. BUG-2026-06-11-008's fix is doing its job.
- **55 DOs carry a header hub that disagrees with their (single, consistent) line hub; 15 of
  those were created AFTER the guard** — DO-2606-029 → DO-2607-083 (07-18, still LOADED). All
  say "Houzs KL" while every line is PG (11), SRW (2) or SBH (2). Composition is clean; only
  the label is wrong, because `createDeliveryOrderForPOs` resolves
  `hubTarget = body.hubId ?? salesOrderRow?.hubId` and a consolidated multi-SO DO has no single
  `salesOrderId`, so it falls through to the customer's default hub
  (`delivery-orders.ts:3423` → `:3454`). The printed ADDRESS is correct throughout.
- Impact is reporting, not delivery: anything grouping by hub/state (delivery planning, 3PL
  state rates, reports) sees KL.
- **Owner decision: do NOT backfill the shipped ones** — fix the resolution going forward only.
  Not yet built.

## 2026-07-22 — 🟡 ON HOLD looked like it "didn't run" — it did; the dept sheet served a stale SWR snapshot
**Owner: 「账单明明已经 on hold 了,可是却好像没有 on hold 的 back end 跑动」** (SO-2607-120 /
PO-009515 / their SO-012637, 11 rows still plain on the Fab Sew sheet). **Not a hold bug.**
- **The cascade ran correctly.** `sales_orders` ON_HOLD + reason + held_by/held_at stamped
  14:22:26.229Z, and all **6 production orders → ON_HOLD at the identical timestamp**
  (`cascadeSOStatusToPOs`, `src/api/routes/sales-orders.ts:665`). Verified directly on prod.
- **What the operator saw was cache lag.** `production_orders_list_snapshot` for
  `dept=FAB_SEW&excludeCompleted=true&fields=minimal` was `built_at` 06:19:24Z / `built_from`
  06:11:11Z — **~8 h before the hold**. The dept sheet runs `staleWhileRevalidate`
  (`production-orders.ts:5612`), so the first read after the hold returns the pre-hold body and
  only kicks the refresh in the background. Live proof: first `GET /api/production-orders?
  dept=FAB_SEW…` returned `status:"PENDING", holdReason:""`; the next call returned
  `status:"ON_HOLD"` + the reason. `X-Cache: MISS` both times — it is the snapshot layer, not KV.
- **Confirmed fixed-by-refresh in the real UI:** /production/fab-sew search "12637" now renders
  all 11 rows amber with an **ON HOLD** badge + reason.
- **Root cause of the lag:** the SO status-change path never invalidates the production
  snapshot. The hub-change path already does exactly this (`invalidateHubChangeSnapshots`,
  `src/api/lib/snapshot.ts:432`, wired at `sales-orders.ts:5259`) *because the freshness probe
  is known to lie*. **Proposed fix:** call the same wipe after an ON_HOLD / CANCELLED / RESUME
  cascade so the shop floor sees a hold on the first render, not the second. Not yet built.
- Script: `scripts/audit-hold-cache-2026-07-22.mjs` (read-only).

## 2026-07-22 — 🟡 Hub audit vs Houzs "PO chasing list 20260722" — 7 wrong hubs + 20 mislabelled PG DOs
**Ask (owner): 「幫我查看我的顧客 hubs 全部對嗎？有哪些錯的」** — assessment only, nothing changed.
Script: `scripts/audit-hok-hubs-2026-07-22.mjs` (read-only, prod). Join key = their
`Doc No` (PO-0096xx) → `sales_orders.customer_po_id`. 74/74 POs matched; **66 hubs agree**.
- **7 SOs carry the wrong hub** (all stamped `Houzs KL`, customer says otherwise):
  PO-009401→PG, PO-009442→**SRW** (INVOICED), PO-009467→PG, PO-009495→PG (DO-2607-084 LOADED),
  PO-009529→PG, PO-009544→PG (INVOICED), PO-009567→**SRW** (SHIPPED). 30 FG units stamped
  "Houzs KL" follow the SO, so box stickers are wrong too.
- **PO-009631 (their SO-012060, KL) is on their chasing list but not in our ERP** — never keyed in.
- **20 delivery orders labelled "Houzs KL" whose lines are 100 % Houzs PG SOs** (DO-2605-037 →
  DO-2607-083, the last one LOADED 07-21). Address printed is the correct Penang one; only the
  hub label is wrong. **Root cause:** `createDeliveryOrderForPOs`
  (`src/api/routes/delivery-orders.ts:3423`) resolves `hubTarget = body.hubId ?? salesOrderRow?.hubId`,
  and on a consolidated multi-SO DO `salesOrderRow` is NULL → falls through to
  `ORDER BY isDefault DESC LIMIT 1` = Houzs KL (line 3454). Same default-hub class as
  BUG-2026-06-05-003 (FG stickers) and BUG-2026-06-11-009 (service DOs).
- **Hub master data (`delivery_hubs`, 7 rows) — owner confirmed CORRECT, do not "fix":**
  Houzs SRW + SBH really do deliver to the KL Balakong address (consolidated, Houzs ships
  onward themselves), same for `2990 KL`; **LIM + SOON genuinely have no hub** (walk-in
  customers) so their blank Deliver-To is expected, not a bug.
- **The 55 blank-hub DOs are explained, not a live bug:** 51 are the 2026-05-05/06 historical
  import batch (rows came in with `hubId` set but `hubName` + `deliveryAddress` NULL — the
  importer never populated the snapshot; all DELIVERED long ago). DO-2606-004 + DO-2606-030 are
  the BUG-2026-06-11-008 blank-address quirk, fixed 06-11. DO-2606-086 (SOON) + DO-2607-060
  (LIM) are the no-hub customers above. **Zero blank DOs created since 2026-07-14.**
- **Legacy `customer_hubs` table disagrees with `delivery_hubs`** (different ids, missing 2990/
  LIM/SOON). No page reads it, but `src/lib/api/resources/customers.ts` exposes
  create/update/delete against the GET-only route — dead code pointing at stale data.
- ✅ **DONE 2026-07-22 — the 3 unshipped SOs corrected to Houzs PG on prod** via the UI's
  Change Delivery Hub modal (owner's own logged-in Chrome; the committed script credentials all
  401 now — password was rotated, stale creds in the old one-shot `scripts/*.mjs` should be
  stripped). SO-2607-010 (PO-009401), SO-2607-087 (PO-009467), SO-2607-108 (PO-009529).
  **Verified on prod** with `scripts/verify-houzs-hubs-2026-07-22.mjs`: all three
  `hubName=Houzs PG`, `customerState=PG`, and `production_orders.customer_state` cascaded to PG.
  `fg_units.customer_hub` still stores "Houzs KL" on the 8 units — cosmetic only, the sticker
  reads the live `COALESCE(so.hubName, co.hubName) AS resolvedHub` join
  (`src/api/routes/fg-units.ts:550`, the BUG-2026-06-05-003 fix); `POST /api/fg-units/backfill-hub`
  can restamp if a stored value is ever wanted.
- **4 left alone — already shipped, guard refuses (owner's rule):** SO-2607-074 (PO-009495,
  DO-2607-084 LOADED + DO-2607-058 INVOICED), SO-2607-040 (PO-009442, SRW), SO-2607-115
  (PO-009544), SO-2607-130 (PO-009567, SRW). These 4 were physically sent to the KL address
  while Houzs's own list says PG/SRW — a commercial question for the owner, not a data fix.
- **Still open:** the DO default-hub fallback fix (line 3423/3454) — 20 mislabelled PG DOs;
  and PO-009631 never keyed into the ERP.

## 2026-07-17 — ✅ RM 750 special-order backfill CLOSED on prod (DO-judgment) — owner re-sends 6 Houzs invoices
**Owner: 「直接上 prod。你重发」 + 2 unshipped lines 「写到 SO 线上」. DONE + reconciled.**
- **6 invoices corrected via `PUT /api/invoices/:id {priceEdits}`** (the tested GL-restate
  path) = **+RM 540**: INV-2606-082 +100, -087 +50, -001 +50, -163 +160, -057 +50, -136 +130.
- **5 SOs re-priced via `POST /backfill-special-order-surcharge {scope:"all", soNos:[5]}`** =
  9 lines / **+RM 750** (includes the 2 never-shipped lines: SO-2605-121 line 02 RM50 +
  SO-2605-275 line 02 Left Drawer RM160 — SO-only, the forward-fix bills them on any future
  invoice).
- **Line targeting = DO position-match:** invoice items are 1:1 with their DO's items in the
  same order, and each DO item carries `productionOrderId = pord-<soId>-<lineNo>`. Matched the
  exact invoice_item by DO position + verified SKU — robust against the duplicate SKUs in the
  consolidated invoices (INV-082 had 2008(A)-(K) ×3). All 7 verified before writing.
- **priceEdits TRAP handled:** these invoice lines had base/divan/leg = 0 with the whole price
  lumped in unitPriceSen. `priceEdits` REPLACES unit = base+divan+leg+special, so sending
  special alone would have ZEROED the price. Set base = current unit, special = surcharge →
  unit = old + surcharge (the phase-2 pattern).
- 🔴 **MY BUG, CAUGHT BY READ-BACK — logged as the lesson:** I priced the drawer lines from the
  STATIC `bedframeSpecialOrders` config (Right 15000, Front 12000) but the backend executor
  uses the LIVE `specials` config (Right **16000**, Front **13000**, Left **16000**). The SO
  came out RM30 above my invoice total; the reconciliation read caught it. Topped up
  INV-2606-163 (+RM10) and INV-2606-136 (+RM10). **RULE: price special orders from the SAME
  source the backend does (loadSpecialsConfig / kv_config `specials`), never the static
  catalog** — memory already warned "Left/Right Drawer 16000 vs static 15000; Front 13000 vs
  12000". Now heeded.
- **FINAL RECONCILIATION VERIFIED:** all 7 invoiced lines lockstep (SO special == invoice
  special, every one); `GET /backfill-invoiced-plan` → `invoicesToCorrect:0, needsManual:0`.
  All 6 invoices SENT/unpaid (raising is safe), all customer = Houzs Century (inter-company).
🔴 **OWNER'S STEP:** re-send the 6 corrected invoices to Houzs (INV-2606-082, -087, -001, -163,
-057, -136). Sending is his action. **The special-order surcharge backfill is now 100% closed**
(uninvoiced 78 SOs + invoiced 10 + these 5 = every under-billed SO priced).

## 2026-07-17 — 🔵 RM 720 (not 750): DO-judgment plan BUILT + read-verified — awaiting owner go on the GL writes (SUPERSEDED — executed above)
**Owner ask: 「用 DO 判断的方法我已經找到,可以做」.** Cracked it: every invoice carries
ONE `deliveryOrderId`, and each DO line carries `productionOrderId` = `pord-<soId>-<lineNo>`.
So the DO deterministically says WHICH invoice a given special SO line shipped on — no
guessing. Resolved all 9 owed lines across the 5 SOs (all customer = **Houzs Century**,
inter-company). All 6 target invoices are **SENT, paidAmount 0, 0 payments** → safe to raise
(no reconciliation break). Prices from live kv_config: Divan Curve 5000, Divan Top Fully
Cover 5000, Right Drawer 15000, Front Drawer 12000, Left Drawer 15000.

**7 lines → a definite issued invoice (RM 520):**
| SO | line | option | RM | → invoice (via its DO) |
|----|------|--------|----|----|
| SO-2605-234 | 01 Divan Curve | 50 | INV-2606-082 (DO-2606-001) |
| SO-2605-234 | 03 Divan Curve | 50 | INV-2606-082 (DO-2606-001) |
| SO-2605-234 | 02 Divan Curve | 50 | INV-2606-087 (DO-2606-007) |
| SO-2605-185 | 02 Divan Top Fully Cover | 50 | INV-2606-001 (DO-2606-002) |
| SO-2606-135 | 01 Right Drawer | 150 | INV-2606-163 (DO-2606-088) |
| SO-2605-121 | 01 Divan Curve (PC151-14) | 50 | INV-2606-057 (DO-2605-053) |
| SO-2605-275 | 01 Front Drawer (PC151-01) | 120 | INV-2606-136 (DO-2606-062) |

Per-invoice delta: 082 +100, 087 +50, 001 +50, 163 +150, 057 +50, 136 +120.
(The planner refused these as "two live invoices"/"no unmatched line" because it matched by
SKU only; the DO line-number + fabric code disambiguate cleanly.)

**2 lines → NEVER delivered, no invoice to correct (RM 200):**
- SO-2605-121 line 02 (1007-(Q) **PC151-16** Divan Curve, RM 50) — line 01 shipped on
  DO-2605-053; line 02 never did. SO is INVOICED (closed).
- SO-2605-275 line 02 (1007-(Q) **PC151-01** Left Drawer, RM 150) — SO is READY_TO_SHIP;
  only line 01 shipped (INV-2606-136). Line 02 not yet delivered.
  These have NO issued invoice. Correct action = price the SO LINE only; the forward-fix
  (production_order_id on invoice_items) makes any FUTURE invoice bill it automatically.

**EXECUTION PATH (per prior phase-2, tested): for each of the 7 lines** → `PUT /api/invoices/
:id {priceEdits}` (the ONLY GL-restating path on a SENT invoice) to add the surcharge to that
specific line, THEN re-price the SO via `POST /backfill-special-order-surcharge {scope:"all",
soNos:[...]}` so SO and invoice stay in lockstep. For the 2 unshipped lines → SO re-price only.
🔴 **AWAITING OWNER GO** — issued inter-company GL, highest-risk area; every prior phase was
rehearsed on staging then prod with per-phase approval, and the write hits the permission
classifier. Read-only investigation is COMPLETE; only the irreversible writes remain.

## 2026-07-17 — 🟢 Heartbeat made reliable: CF Cron Worker DEPLOYED — owner owes 1 secret command
**Owner ask: 「心跳每 1-3.5 小时(GitHub 不跑) 做」.**
Root cause was never the code — it was the DRIVER. GitHub Actions cron drifted
1–3.5h (measured 2026-07-16), starving every agent + delaying the morning brief.
The heartbeat is the universal fallback for the punctual 07:00 report / 07:30
delivery crons, so making it reliable makes the whole agent+report system reliable.

**Built + DEPLOYED a sibling Cloudflare Cron Worker** `agent-heartbeat-worker/`
(CF cron fires on time; Pages can't host a cron trigger — Workers-only, per the
root wrangler.toml note; mirrors `mail-inbound-worker`). Live at
`https://hookka-agent-heartbeat.houzs-erp.workers.dev`, cron `*/30 * * * *`
(tighter than hourly on purpose: prompt fallback + faster backlog drain; the
endpoint self-throttles real agent runs to the 1h min). GitHub yml KEPT as a
belt-and-suspenders fallback (endpoint dedups → double-fire is a no-op).

🔴 **OWNER OWES ONE COMMAND** — the worker is deployed but the beat 401s until the
shared secret is set (I must not handle the secret value). Verified live: hitting
the worker URL returns exactly `CRON_SECRET unset or too short`. From
`agent-heartbeat-worker/`:
```
npx wrangler secret put CRON_SECRET      # paste the SAME value as the ERP's CRON_SECRET
```
If the original value isn't to hand (GitHub/CF secrets can't be read back),
rotate on BOTH sides: `wrangler pages secret put CRON_SECRET` on the ERP Pages
project + the worker + the GitHub repo secret. Full runbook in the worker README.
Verify: `curl https://hookka-agent-heartbeat.houzs-erp.workers.dev/` → `beat ok`.

## 2026-07-17 — ✅ ANN's docks CLEARED on prod (owner approved the write) — RM 291.91
**Owner approved「你批准,我来跑重算」.** Ran the plan below via the system's own
`POST /auto-from-punch` (14 days) + 1 DELETE (07-11, no punch). Read-back confirms ANN
now has **exactly ONE dock left: 06-30 = 0.22h (AUTO)** — her real 13-min shortfall.
**21.48h of wrong docks removed = RM 291.91** (at her 1359 sen/h). That is MORE than the
RM 233.58 the owner remembered, because 233.58 counted only July's 13 rows; it excluded
June's 06-29 (0.5h) and the wrong portion of 06-30 (1.72→0.22). No refund needed — no
payslip was ever generated, so she is simply paid right at the first July run. 06-30 kept
its AUTO tag so a future settle can still manage it. ✅ DONE.

--- original plan (kept for the audit trail) ---
**Owner ask: 「ANN 被多扣的 RM 233.58 要」.**

✅ **Code fixed + on prod** (BUG-2026-07-17-007, commit 80dc540f): the first fix caught
only the live-punch path; the MONTHLY settle still used the global 9h. Both now share
`rulesForWorkerHours`. **Deleting her docks before this would have let the next settle
re-create them silently.**

🔴 **The premise is wrong, and the owner needs to hear it: NOTHING HAS BEEN DOCKED YET.**
`/api/payslips?period=2026-07` → **0 payslips**; 2026-06 → **0 payslips**. No payslip has
ever been generated for either month, so no money has left. The RM 233.58 is a PENDING
deduction sitting in `payroll_hour_deductions` waiting for the first payroll run. Remove
the rows before payroll and she is simply paid right — there is nothing to refund.

**Verified per-day against her real punches (not assumed) — 15 AUTO rows, 0 MANUAL:**
- **2026-07 (13 rows / 19.48h) — ALL WRONG.** Her punches are 08:00–18:00 → 9h regular →
  0 short against her 7.5h day. Note: **0 short against the OLD global 9h too** — so
  these rows are NOT explained by the 7.5-vs-9 bug on today's data. They are STALE:
  written at punch time from an earlier clock-out, and the attendance was later keyed to
  18:00 with nothing recomputing the dock. (Today, 07-17, she punched out 16:31 — that IS
  the shape the 7.5h bug bites, and the fix now returns 0 for it.)
- **2026-06 (2 rows / 2.22h) — MIXED. This is why a blanket delete was wrong:**
  - 06-29 docked 0.5h →真 0 → remove.
  - 06-30 docked 1.72h (08:11–16:32) → **genuinely 0.22h short** → must be CORRECTED to
    0.22, NOT deleted.
**Plan (dry-run built + verified, not executed):** 14 days → `POST /auto-from-punch`
(the system's own guarded self-heal: recomputes with the fixed rules, deletes a 0,
overwrites 0.22, keeps source=AUTO so a future settle can still manage it — a manual
POST would tag it MANUAL and permanently freeze it). 1 day (07-11, no punch record at
all) → plain DELETE: no clock-out = no evidence of shortfall, per the helper's own
guard; an absence is settled by the monthly salary deduction instead.
🔴 **BLOCKED:** the prod write was refused by the permission classifier. Not worked
around. Owner must either approve the write or click Undo on those rows in the Labor
Cost review himself. **No urgency — the docks only bite when payroll is first run.**
Do NOT reach for `POST /settle-period` as a shortcut: it would recompute ALL 42 workers
(30 other AUTO docks) from today's data and could silently ADD docks nobody approved.

## 2026-07-18 — 🟡 ISO 9001 + MFRS gap analyses DELIVERED (owner「跟著 ISO standard」+「accounting 根據 MFRS」)
Owner confirmed **ISO 9001** (quality) and wants **accounting per MFRS**; both asked as a **gap
report first** (not a blind rebuild). Ran 4 parallel read-only Explore agents over the whole
codebase, synthesized two code-grounded documents:
- `docs/ISO-9001-GAP-ANALYSIS.md` — 11 clauses mapped. Strong: 8.5.2 doc-chain traceability, 8.4
  supplier performance/3-way match, 9.1 monitoring. Gaps: QC release gate (8.6), formal NCR (8.7),
  CAPA effectiveness-verification (10.2), document version/approval control (7.5), calibration
  (7.1.5), competence/training (7.2), internal-audit program (9.2), management-review record (9.3),
  risk register (6.1), AVL approval (8.4). Suggested P1: NCR + CAPA closure + doc control + internal
  audit + mgmt review.
- `docs/MFRS-GAP-ANALYSIS.md` — accounting is **strong**: hash-chained double-entry GL, revenue on
  delivery (MFRS 15), FIFO/periodic inventory, all 4 statements, fixed-asset depreciation w/ GL
  posting, SST to real liability accounts, AP realised FX. Gaps: inventory NRV/obsolescence (102),
  receivables ECL (9), income/deferred tax (112), warranty provision (137), payroll GL automation +
  statutory-payable split (119), cash-flow MFRS-107 classification + SOCIE (101), MYR-only AR +
  no FX retranslation (121), no DB-level ledger immutability trigger. Suggested P1 (the ones that
  change reported numbers): NRV, ECL, payroll GL, deposit/contract-liability — **to be scoped WITH
  the accountant** (ERP builds the mechanism, the accountant sets the rates/policy).
**NOTHING built — assessment only.** Owner picks which gaps to build; each is mockup→approve→
staging→prod, and the MFRS P1 items need the accountant's rates before coding.

## 2026-07-18 — ✅ Agent health check + Employee/Service starvation FIXED (owner「確保 agent 有做到」)
**Owner asked to confirm the production + delivery agents are actually working.** They ARE:
production-brief ran 07-17 08:01, production-proposals 07-17 20:20 (cleared 872 due dates),
delivery-run 07-17 09:03. Both healthy.
**But found a real bug: Employee + Service agents ran ONCE all July** (Production 48×,
Delivery 11×, Employee/Service 1× each). Root cause was reach, not the digests (run-now fires
them fine in ~1.3s): the beat is one sequential Worker invocation and the two cheap read-only
digests sat AFTER the backlog drain; while the drain was per-row it killed the Worker before
them nearly every beat. **Fixed (BUG-2026-07-17-011, deployed): reordered the beat to reap →
Employee → Service → drain → generation**, so the cheapest agents run first and nothing
downstream can starve them. Verified the reordered beat fires clean post-deploy.
**Made every agent current tonight** via `POST /api/agents/run-now`: employee + service
(07-18 01:52) and production-learning (07-18 02:02) all ran green. All six agents now healthy.
**Heartbeat cadence traced:** GitHub fires it every 60–205 min (a 205-min hole on 07-17) vs
the intended 20 — the reason `agent-heartbeat-worker/` (reliable CF cron) exists. That worker
is deployed and waiting on the owner's one `wrangler secret put CRON_SECRET`.
✅ **Payslip `(26 x 9)` label lie — DONE + LIVE-verified (BUG-2026-07-17-012).** Owner asked to
finish all pending, so completed it: label now reads each worker's real `(workingDays x
workingHoursPerDay)`. employees.tsx looks hours up from the workers prop (no backend change);
the PDF path reads it off the worker via GET /:id. Verified live: ANN's May payslip now
`2650 / (26 x 7.5) = 13.59` (matches the rate); 9h workers still `(26 x 9)`.

## 2026-07-17 — ✅ Owner final batch COMPLETE (「其他兩個也處理掉」 + earlier asks)
All of the owner's 2026-07-17 batch are now shipped or cleanly handed off:
1. ✅ Brief recipients → you + Violet (sent:2); **owner added Lim 2026-07-18 → now 3**
(list lives in `kv_config['daily_report_recipients']` as a BARE JSON array — this repo is
PUBLIC, so staff emails must never be committed here; edit the DB row, not code).
2. ✅ ANN RM 291.91 cleared on prod
(1 genuine 0.22h kept). 3. ✅ Heartbeat CF Cron Worker deployed (owner owes 1 `wrangler
secret put CRON_SECRET`). 4. ✅ RM 750 special-order backfill closed via DO-judgment
(6 Houzs invoices + 5 SOs, reconciled; owner re-sends). 5. ✅ Sticky tick column
(BUG-008). 6. ✅ Employee Master 「歪了」 (below).
🟡 **Deferred, NOT in the batch (flagged so it's not lost):** the payslip label
`(26 x 9)` is hardcoded in generate-payslip-pdf.ts:178 + employees.tsx:~7561 while the
rate is computed from the worker's real hours (ANN = 2650/(26×7.5) = 13.59). The label
lies for any non-9h worker. Fix needs `workingHoursPerDay` threaded into the payslip
payload + PDF — a small payload change, so spun off as its own task rather than
scope-crept here.

### 2026-07-17 — 🔵 Owner batch (3 asks, screenshots) — Employee Master / payroll
Logged before working (multi-part rule). Owner's words + what each means:
1. ✅ 「歪了」 — Employee Master INLINE EDIT row was misaligned: the resign-date input
   (01/07/2026) and the status dropdown overflowed / clipped out of the 110px Status
   column. FIXED (BUG-2026-07-17-010): widened Status to 150px, both controls
   w-full min-w-0, "Resigned on" label moved to its own line. Deployed to prod.
2. 「確保resign了 就payroll 出去」 — once a worker is RESIGNED they must drop out of
   payroll. Verify (resign-lockout.test.mjs + the payroll active-only filter exist —
   check before assuming it's broken).
3. 🔴 **「我記得ann是工作少1.5小時的」「沒有跟?」 — CONFIRMED REAL, and it costs her money.**
   ANN (EMP-004) has `workingHoursPerDay = 7.5`. The PAY side honours it
   (`hourlyRate = payrollDailyRateSen / worker.workingHoursPerDay` → RM 2650/(26×7.5) =
   RM 13.59/hr, payslips.ts:581 + :921). The DOCK side does NOT: short-hours are measured
   against the GLOBAL constant `HOOKKA_ATTENDANCE.standardWorkMin = 9*60`
   (attendance-rules.ts:45), which is not per-employee. **9 − 7.5 = 1.5 → she is marked
   "1.5h short" EVERY working day** (01,02,03,04,06,07,08,09,10,11,13,15 Jul …) and docked
   −RM 233.58 (13d). Blast radius measured on prod: 42 workers — 38 at 9h (unaffected),
   3 at 0h (test accts), **ANN the only one at 7.5**. Fix = the dock must read the
   employee's own hours, same source the hourly rate already uses.
   Related display bug: "Hourly Rate: RM2650 / **(26 x 9)** = RM13.59" — the `(26 x 9)` is
   HARDCODED in `generate-payslip-pdf.ts:178` + `employees.tsx:7561` while the number shown
   is computed from 7.5 (2650/195 = 13.59, NOT 2650/234 = 11.32). The label lies.

## 2026-07-17 — 🟢 MONEY fix LIVE (RM 8,060) · 🔵 BACKFILL SO+SI = NEXT · 🔴 invoice PO mis-match
**Code fix SHIPPED + LIVE + verified** (merge `efbba63e`): scanned customer POs never charged
the special-order surcharge because the scan clients POST /api/sales-orders directly without
`specialOrderPriceSen` while the typed form always sends it (RM 80 typed vs RM 0 scanned).
Server now derives it ONLY when the field is omitted. Verified live on staging against the
real write path (Divan Full Cover→8000; HB+Divan→10000 combo cap; plain→0); test SO deleted.
**Number corrected to RM 8,060** (the first RM 8,390 mis-counted the HB+Divan combo as RM 130
instead of the RM 100 cap).

🔵 **NEXT — BACKFILL SO + SI. OWNER APPROVED (asked TWICE): 「改罷了 然後我們重新法國」**
(法國=發過) = **re-price the old SOs + invoices; HE re-sends them.** Same route he chose on
the invoice money-path work. **The decision is made — execute, don't re-ask.** Only open
sub-question: PAID / part-paid invoices (raising a total breaks reconciliation) — surface
that list separately instead of assuming.
**START HERE:** (1) re-run the sweep UNBOUNDED (the RM 8,060 came from the first 500 SOs —
the list endpoint caps/paginates, so the real scope may be bigger); (2) dry-run planner →
per-SO list + delta + invoice status; (3) execute via the existing re-price/GL-restate path
(`PUT :id`), never a hand-rolled GL write.
66 SOs / 82 lines / RM 8,060 + their invoices. **Read BUG-2026-07-17-002's backfill block
before doing anything** — it lists the 6 decisions/traps (issued invoices are accounting
records → no silent edits, owner's precedent is re-price + he re-sends; paid invoices break
reconciliation; GL must reuse the existing `PUT :id` GL-void, don't re-implement;
confirmed SOs may cascade; build a DRY-RUN planner first per this repo's own precedent; and
re-run the sweep unbounded — it only read the first 500 SOs).
Deliberately stopped before writing: this touches issued documents + the GL and deserves a
fresh session, not the tail of a long one.

## 2026-07-17 — (superseded header) MONEY: special-order surcharges + invoice PO mis-match
Owner spotted both from ONE invoice (DO-2607-051 / INV-2607-060). Full evidence, ruled-out
causes and fix options in `docs/BUG-HISTORY.md` — **BUG-2026-07-17-002** (money) and
**BUG-2026-07-17-001** (wrong PO refs). Do not re-derive; read those entries first.
- **RM 8,390 under-billed** across **66 SOs / 82 lines** (500 SOs scanned live on prod).
  INV-2607-060 alone = RM 210. Price list + `calculateUnitPrice` are CORRECT — a specific
  WRITE PATH stores the special-order label without its surcharge (`specialOrderPriceSen=0`).
- **Owner ruling: 「先修 然後再 backfill」** — fix the code FIRST, backfill the 66 after.
- 🔵 NEXT (not started): confirm the culprit path — strong lead is the OCR/scan consumer
  (stored text is COMMA-joined like `scan-po.ts:430`, while the form joins with `"; "`;
  scan-po only extracts, so its consumer builds the SO). **Verify before coding** — the
  similar-looking `buildLinesFromCopyDraft` bug is Service-Order-only where RM 0 is correct.
- Fix must be BACKEND-side at write time (FE+BE unified rule) so no client path can skip it;
  dedicated branch + tests (money ⇒ isolated-branch rule). Preserve: SV mode = 0, operator
  price edits not overridden, HB+Divan combined-cover = RM 100.
- Backfill is SEPARATE and needs an owner decision: issued invoices are accounting records —
  no silent edits (credit-note vs re-issue). INV-2607-060: ask whether it's already sent.

## 2026-07-16 — Handoff tasks 1 + 2 (owner, THIS session) — see docs/HANDOFF-2026-07-16.md
1. ❌ **Impersonation ("login as user") — OWNER DECLINED 2026-07-16, do NOT build.**
   Owner ruling: 「這個不需要啊 我去staging用他們的戶口就可以了」 — he reproduces per-user
   views by logging into their accounts on STAGING, so the feature has no owner demand.
   All work reverted (nothing left in the tree). **Do not re-propose** unless he asks.
   Known limit he accepted: a staging account can't reproduce a blank page caused by PROD
   data (a specific order / dept config). If that case ever bites, revisit then — the spec
   + the 5 security invariants stay in docs/HANDOFF-2026-07-16.md.
   Findings worth keeping if it IS ever built (both cost real time to find):
   - auth-middleware's sliding refresh extends ANY session with <24h left back to 7 days →
     a 2h impersonation TTL would be silently promoted to 7d on the FIRST request. Gate it
     on the session's ISSUED length (expiresAt − createdAt), not on a new column.
   - the middleware SELECT runs on EVERY request, so it must never reference a
     not-yet-created column: that 503s the whole API *including* the endpoint whose runtime
     ALTER would create it → total lockout, unrecoverable without DB creds.
2. 🟡 **/invoices jank — PARKED by owner 2026-07-16 (「那就等」), premise DISPROVEN.**
   Owner parked it after being shown the evidence + the honest cost: chasing the remaining
   ~94ms floor means touching the shell EVERY page shares (and likely the monolith-page
   decomposition), which is high-risk for a 0.1–0.3s-per-navigation win — lower value than
   the real pain (duplicate invoices, planning cold starts). **Do NOT restart this on a
   "page feels slow" report alone.** Resume only if the owner asks, or if a page regresses
   badly enough to matter.
   Diagnostic headers REMOVED from BOTH prod (50e0904e) and staging (b0d8f0d1) and verified
   clean — deliberately not left on staging, because staging↔main merge regularly in this
   repo and a `_headers` line would ride into prod unnoticed. To resume: re-add
   `Document-Policy: js-profiling` under `/*` in `public/_headers` (one line) and profile on
   staging — it DOES reproduce once its cache is warm.
   Evidence below stands. Owner said (before parking):
   「先抓火焰图再改,别盲改」 — measured first, and the measurement killed the task.
   Full evidence in docs/HANDOFF-2026-07-16.md (Task 2 block). Short version:
   - **/invoices is one of the CHEAPEST pages (153/193ms)**, not the worst. There is a
     **~94ms floor on EVERY route transition** (/notifications, the lightest page, costs 94ms);
     invoices sits only ~60ms above it. The real hotspots are **/planning (238–384ms)** and
     **/delivery (377ms)**.
   - **"/planning = 0ms" — the handoff's entire proof — was measurement error.** Sidebar links
     don't match on exact text (badge → `Notifications9`), so the click no-ops, nothing
     navigates, and the observer honestly logs 0ms. Reproduced the false zero.
     **RULE: assert `location.pathname` changed before trusting a perf number.**
   - **The block fires BEFORE the data lands** (long task at ~40ms, `/api/invoices*` responds
     at ~560ms) → it CANNOT be per-row work. Grid = 11 DOM rows (paginated, not mounting all);
     all array ops during mount = ~17k elements/~50ms (no O(n²)); 1 offsetWidth read (no layout
     thrash); parsing all 17 localStorage cache entries (1.1MB) = 8.2ms. Every suspect dead.
   - **FLAME CHART CAPTURED (prod, JS Self-Profiling API).** Enabled `Document-Policy:
     js-profiling` on prod just long enough to capture, then REVERTED (4a9c21a4 → 50e0904e,
     verified gone from prod). **Staging keeps the header (51b993e2) — profile there next.**
     Verdict: **the block is React render/commit, not our code** — 17 of 21 JS self-samples
     are inside `react-dom`; invoices/data-grid barely appear. There is no hot function of
     ours to optimise. Sentry is NOT active on prod; the CF beacon never runs during the block.
     GOTCHA: Chrome CLAMPS `sampleInterval` (asked 1ms, got ~17ms median) → each sample ≈17ms;
     21 samples ≈364ms ≈ the measured blocks. Don't read sample count as ms.
   - **⚠️ The "0ms" trap bit me too — same root cause as the handoff's.** Staging looked 0ms on
     byte-identical src (verified zero src diff main↔staging), which looked like a major clue.
     Artifact: staging had never visited /invoices → no SWR cache → nothing to render → 0ms.
     Warm (940 cached rows) staging = **145–284ms = same as prod**. No prod/staging difference.
     **RULE: a 0ms perf reading is a measurement bug until proven otherwise — assert the route
     changed AND that there were rows to render.**
   - **NOT root-caused: the ~94ms floor.** It's React render/commit, app-wide, but the
     profiler's ~17ms resolution can't attribute it to a component. Next: profile on staging
     (header already live) or bisect the shell (Sidebar/Topbar/Breadcrumbs/`<Routes>`) — ~94ms
     of React render for a 1,210-node page is abnormal and the shell is common to every route.
     (`TabbedOutlet` keep-alive is referenced in stale comments but NO LONGER EXISTS — not it.)
   NOTHING SHIPPED to app code — the only prod change was the profiling header, now reverted.

## 2026-07-14 — 🔵 Durable read-perf rollout (ON STAGING, byte-identical gate) — see docs/PERF-DURABLE-ARCHITECTURE.md
Owner-approved rebuild: stop shipping whole-org lists to the client; compute
server-side (shared builder = byte-identical by construction) + snapshot-cache +
serve-stale. Each slice = own commit → staging → LIVE byte-identical verify →
(owner) merge to prod. Canonical + deployed branch = `staging` (this branch,
staging-delivery-ready). NOTE: the older `perf-durable-arch` branch holds the same
work via a messier revert/reapply history and is now BEHIND on code — treat THIS
branch (staging) as source of truth; perf-durable-arch is superseded (kept only for
its doc history, now copied here).

**Slices DONE + LIVE-verified on staging (NOT on prod — await owner merge):**
- ✅ **Sales SO list** — `?fields=minimal&include=` (empty include drops jobCards).
  1.2MB→72kb. Sales total RM 1,155,048.95 + "194 of 200" byte-identical.
- ✅ **Delivery Planning/Ready** — `GET /api/delivery-orders/ready-planning`
  (shared buildReadyPlanning, withSnapshot+SWR, runtime-CREATE snapshot table). FE
  drops the 1.2MB PO pull → ~10 KB. Planning 179/RM136,340.35, Ready 52/RM24,982.22,
  Delivered 265/RM1,004,020.88 byte-identical. (BUG-2026-07-13-001 fixed en route.)
- ✅ **Mobile Home Pending-Delivery** — reuses /ready-planning; dropped its 1.2MB PO pull.
- ✅ **Inventory FG-stock (2026-07-14, THIS session)** — `GET /api/inventory/fg-stock`
  returns DELTAS `{counts, dyn}` via shared `splitFgDeltas` (snapshot-cached
  `inventory_fg_stock_snapshot` + SWR + runtime CREATE). FE keeps its /api/products
  and merges by id via shared `mergeFgDeltas` → dropped THREE fetches
  (production-orders ~1.2MB + delivery-orders + consignment-notes). LIVE-verified:
  page now calls ONLY /api/inventory/fg-stock (0 production-orders/DO/CN calls);
  rendered tallies Total SKUs 272 / Available 52 / Reserved 22 / Bedframe 160 —
  byte-identical (0 per-product diffs in the live compare). Round-trip unit test
  `tests/fg-stock.test.mjs` (7 cases) proves merge(split(derive))≡derive.
  Commit ebc4d1b6. build:strict + full suite green.

- ✅ **Consignment note (2026-07-14, THIS session)** — `GET /api/consignment-notes/ready-planning`
  returns `{planning, ready, poLookups}` via shared `buildCnReadyPlanning` (verbatim from
  note.tsx mapPO + poReadyForConsignment/poInPlanningConsignment gates) + `poLookups`
  (companyCOId/fabricCode/rack for CN-referenced POs, rack via shared
  aggregateRacksFromPackingCards). Snapshot-cached (`consignment_ready_planning_snapshot`,
  cache_key **v2**). FE drops THREE fetches (production-orders ~1.2MB + consignment-orders +
  linked-po-ids) — Planning/Ready rows + the 3 CN-item lookup maps now come from the endpoint.
  Derived tabs carry NO money (CN amounts live on the CN records, untouched). LIVE-verified:
  planning 1 / ready 4 / poLookups 22 byte-identical (0 diffs); page calls ONLY /ready-planning.
  Commits daf711c0 / ab245466 / eadb25c8 / 6909192e.
  GOTCHA (new rule): adding `poLookups` did NOT surface — `withSnapshot` tracks source-table
  mtimes, NOT code, so it served the old v1 blob as "fresh" and the FE lookup columns went
  blank. **A payload-SHAPE change MUST bump the snapshot `cache_key`** (arch-doc rule #3). Fixed 6909192e.
- ✅ **Mobile ProductionScreen (2026-07-14, THIS session, PARTIAL)** — dropped `include=jobCards`
  (board reads only currentDepartment+status, never jobCards) → `?fields=minimal&include=`.
  Byte-identical display, big weak-wifi payload cut. Commit 68e24403. FULL keyset fix (server
  search + per-dept count + infinite scroll) still QUEUED — this is just the safe cut.

- ✅ **Planning (2026-07-14, THIS session)** — the interactive board can't drop the PO
  rows (drag-drop + bulk-patch writes), so two additive levers instead: (1)
  `warmPoListPlanningVariant` warms the previously-unwarmed `excludeCompleted=true`
  snapshot every cron tick → planning serve-stales instantly, no more ~8s cold block
  (measured live on prod: 10MB/8s cold). (2) `include=jobCards-lite` ships only the 12
  job-card fields planning reads (audited: every access is jc.X in a local loop) via
  `slimJobCardsToPlanningLite` (post-pass, no threading; blast radius = the lite request
  only). LIVE-verified on staging: 0 field-diffs across 14,310 JCs, payload 9.92MB→4.99MB
  (50%), warm load ~0.7s; the only PO-set delta is 21 old COMPLETED POs at the 35-day
  rolling-window boundary (NO live/schedulable work dropped — onlyInLite=0). Planning
  page renders, calls jobCards-lite (0 full-jobCards). Commits e670820d / 9b45c37e.

**Reports (2026-07-14, THIS session) — DONE + verified:**
- ✅ **Daily Report (compliance.json ~6s)** — snapshot + serve-stale + warm cron
  (reports_compliance_snapshot, keyed by SGT date; sourceTables = the transactional tables).
  LIVE: 6.8s cold → **0.87s** warm, data intact (4 sections incl. generatedAtIso), byte-identical.
- ✅ **Dashboard brief.json (~4.4s)** — same pattern (reports_brief_snapshot, no-AI/no-write
  variant). AI HTML /brief untouched. warmComplianceReport + warmBriefReport on the cron.
- 🟡 **aging (3s)** — LEFT ALONE: it's a MONEY report (AR/AP) that ALREADY has a cache +
  revision-invalidation (BUG-2026-07-09-002 history). Too sensitive to re-cache under the
  "no past bugs" rule; the 3s is a cold rebuild that the existing rev-bump handles.

**Remaining perf — RISK/REWARD reassessed (2026-07-14):**
- 🟡 **Mobile ProductionScreen — full keyset — NOT WORTH IT (present to owner).** After the
  jobCards drop + Brotli the board is **72KB over the wire** (1.6MB decoded @ 22.5×). The
  keyset would save mainly ~1s of client parse, at the cost of INTRODUCING the dead-data bug
  class (search must reach the whole table). Poor risk/reward — recommend NOT doing it; the
  jobCards drop already solved the payload. Await owner's informed call.
- 🟡 **service-cases (5MB / 19 rows) — CANNOT slim (known trap).** The /m L2 detail
  (m/config/modules.ts) reads responsibleUnit/preventionStatus/affectedProducts/root-cause
  details straight off the list row → slimming blanks the mobile detail. Proper fix = a
  SEPARATE mobile detail endpoint so the list can slim; bigger, deferred. (Snapshot-caching
  it is safe but stores a 5MB JSONB row per refresh — marginal, skipped.)
- ✅ **warehouse wip (2.9MB / 1219 rows) — DONE (2026-07-14, THIS session).** Two safe wins,
  no slim/L2 risk: (1) dropped the dead `grouped` field — a per-rack-name copy of the WHOLE
  `data` array that NO consumer reads (verified desktop warehouse.tsx + /m WarehouseScreen +
  whole src) → ~halves the payload. (2) Map-bucket rack_items by rackLocationId (was
  O(racks×items) via per-rack `items.filter`). Byte-identical rack grid. Commit 387840ad,
  BUG-2026-07-14-005. Procurement PO list already small (89KB); its page also pulls
  /api/inventory as a sibling — that fetch could be slimmed next if the owner wants it.
- ✅ **Snapshot freshness sweep (2026-07-14, THIS session) — dead-data guard.** /review
  correctness pass found inventory /fg-stock tracked delivery_order_items but read the parent
  delivery_orders.status (dispatch flips the parent, not the item) → stale stock after a
  dispatch. Swept the whole ready-planning family: added every status/enrichment table each
  snapshot actually reads to its sourceTables (delivery_orders, sales_orders, sales_order_items,
  consignment_orders, consignment_notes, products). Freshness-only, no cache_key bump. Commit
  ca9789aa, BUG-2026-07-14-004. RULE: sourceTables must cover every JOINed parent's
  status/columns, not just the FROM table.
- ✅ **Site-wide compression ALREADY ON** ("white-pickup" = done) — Cloudflare serves
  Brotli (`content-encoding: br`) at ~20×; the 5MB planning JSON is only ~255KB over the
  wire. So the bottleneck was NEVER the wire — it's server COMPUTE (cold snapshot builds)
  + client PARSE/derive of the decoded JSON. The warm-cron (compute) + payload slims
  (decoded size → parse) target exactly that; no compression work needed.
Method for a derive-and-drop slice: extract shared builder (verbatim from FE) → additive
server endpoint (withSnapshot+SWR+runtime CREATE, **bump cache_key on any shape change**) →
LIVE byte-identical compare (endpoint vs current client compute) → swap FE → re-verify.
Golden rule (owner's #1 fear): search/filter/count/money-total ALWAYS server-side over
the WHOLE dataset; page window is render-only. 11-pt checklist in the arch doc.

## 2026-07-14 — ✅ Edit Customer modal — short-screen "can't save" fix (THIS session)
Owner reported (2nd screenshot): on a short laptop screen the tall single-column
Edit Customer modal overflowed with no way to scroll to Save — users literally couldn't
save. Fix (customers.tsx, commit 2b205a51): landscape 2-column layout (Company | Credit)
+ `max-h-[90vh] flex flex-col` with a scrollable middle + PINNED header/footer, so Save is
always reachable. Pure layout, no data/save-logic change. Sweep of the other ~40 modal
overlays: the vast majority are short confirm/QR/picker dialogs (max-w-sm/md) that can't
overflow — only genuinely tall entity-edit forms share the bug. NONE blanket-fixed (risky,
mostly unnecessary); flag specific tall edit-forms to the owner before reshaping. Add-Customer
is an inline Card (scrolls with the page — not vulnerable).

---

## 2026-07-13 — 🔵 Delivery Return — driver item-flagging + desktop deliver/DR/SV convert
Owner ask (4 parts, feature → staging):
1. **Driver scan** (do-scan.tsx): on "Delivered with issues", show item list → driver
   ticks the specific damaged items (+ problem) → system AUTO-creates a Delivery
   Return for the damaged items, and the remaining good items are all marked delivered
   (good lines invoice normally; DR lines already excluded from invoice via Phase 5
   computeDoInvoiceLines). Backend: public-do-qr `/advance` accepts `damagedItems`,
   creates DR BEFORE the delivered cascade so auto-invoice excludes them.
2. **Desktop DO detail**: support Dispatched → Delivered with the same per-item damaged
   handling (Mark Delivered → optional flag damaged items → auto DR + deliver rest).
   (Post-hoc "Convert to Delivery Return" button already exists for DELIVERED/INVOICED.)
3. **DR → Service Order convert**: DR detail "Repair & re-deliver" should create the SV
   order carrying the DR's damaged item lines — `/sales/create?fromReturn=<drId>` hydrates
   the SV from the DR items + links DR.service_order_id (today it makes a bare case from
   the whole SO, not the specific damaged items).
Shared backend: extract `createDeliveryReturnRecord()` helper (reused by DR POST +
driver advance). **Mockup FIRST (UI rule) → owner OK → build.**

**CORRECTED (2026-07-13, 2nd pass) — PER-LINE returns:** Owner clarified: NOT whole-DO —
partial (e.g. 10 items, only 2 returned). Driver "Delivered with Issue" → tick WHICH lines
are returning → those open a DR, the rest deliver + INVOICE as normal (no invoice hold).
- `public-do-qr /advance`: replaced whole-DO `returnGoods` with per-DO `returnItems` map
  (doId→productionOrderId[]). DR for the ticked subset created BEFORE the delivered cascade
  so computeDoInvoiceLines excludes them; kept lines bill + send the normal notice.
- DO summary payload now carries `items[]` (productionOrderId/code/name/qty) so the phone
  renders the return checklist with no extra fetch.
- `loadDoItemsForReturn(db, doId, onlyProductionOrderIds?)` gained the subset filter.
- `do-scan.tsx`: 2nd button "Delivered with Issue" (amber) opens a return-picker panel →
  tick returned lines → "Deliver — return N items"; success stays green "Delivered". Reverted
  the whole-DO "Returned"/incomplete copy.
- Desktop "Convert to Delivery Return" (DELIVERED/INVOICED, item picker) already covers the
  office route-2 (assume delivered → then DR). build:strict clean; 116 do-qr/delivery tests pass.

--- superseded first pass below (whole-DO, WRONG) ---
Driver side = NO item picker. Clean either/or after dispatch: customer received →
Mark Delivered (normal, invoices); customer did NOT receive → **"Not received —
return goods"** → whole-DO Delivery Return, NO invoice. Built:
- `src/api/lib/delivery-return-create.ts` NEW — shared `createDeliveryReturnRecord()`
  + `loadDoItemsForReturn()` + ensure/nextReturnNo/genId (moved out of the route so
  office + driver write identical DRs).
- `delivery-returns.ts` POST refactored onto the shared helper.
- `public-do-qr.ts` `/advance`: `returnGoods` flag → DO marked DELIVERED +
  deliveryIncomplete (invoice+notice withheld) + auto full-DO DR (best-effort).
- `do-scan.tsx`: 2nd button relabelled "Not received — return goods" (PackageX, red),
  sends `returnGoods`; success screen "Returned"; DoCard/already-done copy updated.
- Desktop #1: `delivery/detail.tsx` — direct "Mark Delivered" from LOADED (parity;
  backend already allows LOADED→DELIVERED).
- Desktop #2: "Convert to Delivery Return" already exists (DELIVERED/INVOICED).
- Desktop #3: DR detail "Repair & re-deliver" now seeds the service case with the
  RETURNED items as affectedProducts → the SV order pre-fills just the damaged lines
  (reuses the existing ?fromCase hydration; no new route).
build:strict clean. Design note (mark-delivered+hold reuses the tested COGS reversal;
DO chip shows "Delivered" though driver saw "Returned" — DR is source of truth).
Owner to test on staging → then prod. Possible follow-up: show a "Return opened" link
on the DO detail so the office finds the auto-DR without going to the DR list.

---

## 2026-07-11 — 🔵 Hookka Report program — BUILT + ON STAGING (verified real data)
Operations Report LIVE on staging (staging.hookka-erp-testing.pages.dev/reports,
default "Operations" tab). Backend collector src/api/lib/operations-report.ts (11
sections, per-section guard → one bad query degrades not 500s, _errors diagnostics)
+ GET /api/reports/operations.json?period=daily|weekly|monthly&date=. Newspaper
frontend src/pages/operations-report.tsx wired into src/pages/reports.tsx. Feature
branch feature/ops-report → merged to staging (NOT main/prod yet — needs owner OK).
VERIFIED live 200 with real numbers: 176 bf + 28 sofa units, 96 overdue, sales
RM128k, 36 workers/11 bonus, RM9.47M stock, RM1.09M AR aging, delivery 42 DOs
(1.4d→0.8d). Fixed en route: delivery `do` reserved-word alias; newProducts
self-applies products.created_at.
**Honest gaps to raise with owner:** (1) on-time 21% is real (dispatch vs internal
hookka_expected_dd) — looks alarming, confirm the target basis; (2) foam/other
material cost = 0 (partial month OR wrong foam itemGroup code — need owner's real
foam category); (3) low-stock = 0 because raw_materials.minStock reorder points are
unset — owner must set them; (4) still UNBUILT sub-metrics: dept-cost analysis
(highest dept + Prod vs Non-prod), RM-category analysis, QC defect %, service open,
supplier on-time rate, price-rise alerts, attendance %, new-product photos.
Prior spec + caveats below.
Owner approved newspaper/broadsheet design (Artifact monthly-gazette-v1) + full content
+ "就这样 proceed". Liked inventory (dead-stock idle days) content specifically. Build =
in-app "Operations Report" page (Daily/Weekly/Monthly tabs), newspaper CSS ported into
app (English UI), reuse EXISTING module calc helpers for口径 consistency, Print→PDF via
existing print engine + unified letterhead. Feature → staging first, then prod on owner OK.
Data-source mapping via 4 read-only agents in progress. Prior spec below.
Owner wants an official daily/weekly/monthly operations report, freshly designed
(claudedesign). Same section set, time-window + emphasis shifts (daily = act-now
queues + per-person efficiency; weekly = trends/SLA/rankings; monthly = totals +
analysis + cumulative). 9 base sections (owner's 5 + my 4 additions):
1 Production (on-time %, overdue, output, production cost) ·
2 Purchasing (PO total, top suppliers, supplier on-time, price-rise alerts) ·
3 Delivery SOP — 3-stage SLA (produce→ship, ship→dispatch, dispatch→deliver) + pain pts ·
4 Employee/QC (attendance, efficiency [daily=per-person, weekly=top/bottom-5, monthly=
   cumulative bonus gate], QC defect %, Service issues) ·
5 Sales (top-seller SKU, sales analysis + insights, one-off specials) ·
6 Inventory (low-stock reorder alerts, FG buffer, stock value, dead stock) — MY ADD ·
7 Finance/AR (aging 30/60/90, billed vs collected) — MY ADD ·
8 Material variance (actual vs BOM standard = waste, fabric cost/meter) — MY ADD ·
9 Supplier performance (on-time rate, price-rise) — MY ADD (folds into Purchasing).
**Monthly-only additions (owner):** People changes (new hires + leavers named lists;
promotions = no system data, skip) · New products showcase (this month's new products,
one representative per category + product photo).
**Weekly-only additions (owner):** Dept cost analysis (highest-cost dept + Production
vs Non-production comparison) · Raw-material analysis (highest-cost/share RM category).
**Dept split (owner confirmed):** Production = the 8 shop-floor depts (Sew/Cut/Uph/
Frame…); Non-production = office/admin/sales/delivery.
Data all from mature modules (reuse existing endpoints). NEXT: monthly mockup → owner
approves layout → build. Not started coding.

---

## 2026-07-11 — ✅ Data-tally fixes P1-P3 (owner "全做" after 4-agent audit) — ALL SHIPPED
P2+P3 shipped in c1cb3bb0 (unify metrics + honest labels + month defaults + OCR
confirm wiring + date clip + div-zero + consolidated-DO + 153/RM0 + same-dept skip).
P1 last item shipped: future-dated PO completedDate → 26 POs re-dated to updated_at
(one-shot POST /api/admin/fix-future-completion-dates, RUN on prod + REMOVED after;
0 future RM_ISSUE rows remain, 148.7m/28m fabric moved back to real months) + a
guard capping job-card completedDate at today. P4 (forward scheduling / bottleneck
lead time / Hookka Report program) still parked — needs owner design.
Branch `data/tally-fixes-0711` (P2+P3), `data/tally-fixes-p1` (P1). Findings in memory
`project_data_accuracy_audit_0711.md`. Scope approved by owner:
**P1 real bugs:** OCR accuracy never populated (confirm step unwired + 'T' vs space
date clip in ocr-accuracy.ts:72); process-skips same-dept false positives
(compliance-report.ts:971-1010, "PACKING ahead of PACKING"); "153 Closed Sales"
mislabeled DELIVERED + RM0 service-order overcount; delivered-cohort drops
consolidated DOs (dashboard-overview.ts:1013-1048); div-by-zero backlog blow-ups
(dashboard-overview.ts:893, planning/index.tsx:991); future-dated fabric RM_ISSUE
rows (2026-09 148.7m BF, 2026-12 28m sofa) — prod data fix, locate + propose first.
**P2 unify:** efficiency → department-performance ratio-of-sums everywhere
(Attendance card fetches dept-perf totals; low-eff threshold 60 shared); backlog
headline = backlogGrandMin basis so dashboard 9.4d == drill == planning 9.1d;
mobile Home Daily-Report chips → read /api/reports/compliance.json (kill client
re-derivations incl. 70-vs-60); workforce excludes TEST everywhere (owner OK'd);
sales month excludes ON_HOLD (align to so-status CONFIRMED set).
**P3 labels/defaults:** Planning "Today's Capacity"→queued-work label, "Used %"→
backlog-pressure; dashboard QUEUE LOAD label, "Below Pace Today"→yesterday,
"153" headline wording; employees ALL tabs default current month (clamp persisted);
remove stale "full data parity" footer + dead planning capacity legend; daily-cap
divisor excludes today (partial day).
**P4 (parked, needs owner design):** forward scheduling wiring, bottleneck-based
lead time, daily/weekly/monthly Hookka Report program.

---

## 2026-07-11 — ⚪ Add FG: bulk auto-generate variants from Model (owner)
Owner wants Inventory → Finished Products → "Add FG" to STOP creating variants one
by one. Flow: he adds Sofa Compartments / Bedframe Sizes in Products → Maintenance,
then on Add FG he enters only Code + Name + Category (+ picks the Model, e.g. 2990).
The system auto-generates ALL variants from the Maintenance config:
  • Bedframe → one FG per Bedframe Size (K/Q/S/SS/SK), auto-filling Base Model /
    Size Code / Size Label.
  • Sofa → one FG per Sofa Compartment (1A(LHF), 1A(RHF), 1B…, 2A…, etc.).
Fabric Usage + Base Price left blank — filled later via Batch Edit (batch-by-batch),
for BOTH sofa and bedframe. Goal: "open all compartments/sizes at once", not one by
one. Feature → staging + mockup first. Config lives at /api/kv-config/variants-config.

---

## 2026-07-10 — 🔵 Mobile Delivery + Warehouse UX batch (owner 7 asks + screenshots)
**STATUS: all 6 built + committed (branch mobile-delivery-warehouse-ux 86130bdf),
build:strict + tests green. NOT yet on prod — awaiting owner's explicit "ship"
(default-Floor changes live inventory behavior; hold per no-merge-without-command).**
Diagnosis correction: the "blank DO detail / no QR / squished" report did NOT
reproduce at 390px — the detail shows Customer/State/Driver/barcode/QR fine; the
real gap was a consolidated (multi-SO) DO's blank HEADER, now backfilled.
Owner reviewed /m Delivery & Warehouse. Captured asks (do not drop any):
1. **Planning & Pending Delivery cards** → richer, like the detailed SO card (screenshot: NICO
   TEST — code+ref on one line, customer, 🏠 hub, Processing→Delivery dates, created, amount).
   Card structure already carries the 5 IDs (code=our SO, Cust PO/Ref/Cust SO metas); gap is
   DATA (reference/customerSO showing "—") + a richer layout.
2. **Delivery search "040"** — searching one status doesn't make clear the same number also lives
   in Dispatched; want it obvious a match spans statuses.
3. **Search delivery by customer SO / Reference** — must actually find the order (data present).
4. **Mobile DO detail** (DO-2607-043) shows BLANK Company SO/Customer/State/Expected DD/Driver/
   Vehicle; **line items** carry NO customer info (Cust PO/SO/Ref, our SOID); layout squished;
   **QR/barcode** on desktop DO — bring parity to /m. (Detail config is complete → root cause is
   payload fields empty OR Draft DO genuinely lacks them — verify live.)
5. **Default packing → "Floor"**: when packing done, by default stock-in to the Floor location;
   operator reassigns to a specific rack later.
6. (Warehouse, carried) search by **Company SOID** — rack item payload lacks companySOId/customerSO.
7. (Delivery, carried) **cross-source unified search** — one query finds an order whether it's still
   a Sales Order (Planning/Pending Delivery) or already a DO (Pending Dispatch/Dispatched/Delivered).

---

## 2026-07-09 — ✅ Aging snapshot invalidation (BUG-2026-07-09-002)

Voiding an advance-only payment writes no probed source table, so the cached
/aging kept phantom advance rows (BIG GREEN −1,560, AUN CHING YAP −3,570)
after the owner voided them. bumpSupplierPaymentsRev() now rides in every
payment mutation batch (create/void/unvoid/knock/un-knock/restate) bumping
kv_config. Verified live: phantoms gone; aging Σ = /ap-control net = GL
400-0000 = 242,798.69. Owner then voided all four GVP payments himself
(reorganising GVP start-to-finish) — PI-2605-011 back to 2,650 outstanding is
EXPECTED; GVP is owner-managed now, hands off.

## 2026-07-09 — ✅ Other-Party Bills editable in place (owner: 「开了无法edit,我要能edit」)

`PUT /other-party-bills/:billNo` (restate: reverse visible GL + repost under
`other_party_bill_restate_rev/post:<stamp>`, collapse; same number; party
fixed; new total ≥ paid via pure `editedBillStatus`). Lifecycle void/delete/
unvoid now pass the whole leg family (`otherPartyBillLegFamily`) so voiding an
edited bill can't leak restate legs. FE: Edit button (ACTIVE rows), edit
banner, locked party, New/Copy/Scan clear the edit state. GET returns
`isOpening` for the prefill. 1461 tests green. Deployed + owner to exercise
the first real edit (his ask) — verify GL via /ap-reconciliation ties after.

## 2026-07-08 — ✅ AP drift −966.60 BROKEN TO THE SEN: /ap-reconciliation endpoint + BUG-003 fix

Owner rule 「做账就是要准」. Shipped `GET /api/accounting/ap-reconciliation`
(read-only; pure `src/lib/ap-recon.ts`, 16 tests asserting Σ item contributions
≡ drift — residual is structurally 0). First prod run itemized −966.60 EXACTLY:
- **GVP −950.00** — HPV-2605-001 (ACTIVE) booked 950 to PI-2605-001 which sits
  in opening_ap_excludes. ✅ RESOLVED 2026-07-09: owner ruled the payment is NOT
  for PI-2605-001 ("还另外一张单" — likely PI-2604-010, also excluded); detached
  back to an unapplied advance via the new `POST /supplier-payments/un-knock`
  (subsidiary-only reverse of knock-off; PI paid re-derived via the truth-guard
  SQL). This matches the old accountant's TB (GVP −950 credit balance).
  **DRIFT NOW 0.00 — control = net = 195,692.69; recon items empty; residual
  0.00 (verified live).**
  ✅ CLOSED 2026-07-09: owner ruled 「不认，继续当预付款，过后我会进回这张单」 —
  the advance state IS the final state; the owner will enter the bill himself
  later and knock the 950 onto it via the normal Knock-off flow. No action.
- **INNOVATEX −418.00** — HPV-2607-009 GL kept DR 836 vs subledger 418.
  ✅ OWNER CONFIRMED 2026-07-09 「我只付RM418罢了」→ the 836 is the system's
  double-record: BOTH the original supplier_payment legs AND the 07-06
  restate_post legs stayed visible (that restate's hide-old-legs step didn't
  bite). Repair = re-run restate with the true 418 (its rev nets out whatever
  is visible — bounded: worst case unchanged, never worse). Was blocked by
  **BUG-2026-07-09-001** (restate rejected fully-paid PIs) — fixed
  (restateHeadroom), deployed, then executed live. Bank 310-0010 was
  overstated by the same 418; heals together.
  ✅ CLOSED 2026-07-09: owner ruled 「不理它」 — PI-2606-001 stays
  CONFIRMED/unpaid 418 in the creditor aging BY OWNER CHOICE. Do not re-raise;
  not a bug.
- **WF LEATHER +401.40** — voided payment's advance row still counted →
  **BUG-2026-07-08-003, FIXED** (lifecycle NOT-EXISTS in
  loadUnappliedSupplierAdvances; heals /aging AP + /ap-control + advance card).
- ±15.06 pi edit-leg pair — folds into base PI after sourceId suffix strip, no
  effect (this was the "strange DR 15.06" clue; 152.40 clue = 401.40 advance
  + prior-snapshot noise, both accounted).
After the fix the card reads **−1,368.00 = GVP −950 + INNOVATEX −418** (both
owner-pending data decisions, permanently itemized by the endpoint). The old
"+16.60 identity" hand-math is obsolete — use the endpoint.

## 2026-07-04 — 🔵 Multi-Company Phase 3: dual-identity + inter-company mirror (worktree branch, NOT pushed)

ADDITIVE-only, opt-in, default OFF. Finance-adjacent — built conservatively;
external customers/suppliers/POs/SOs behave byte-identical.

**Delivered (foundation of inter-company flow):**
- **Dual-identity link** — new snake_case `group_org_code` on BOTH `customers`
  and `suppliers` (default ''). A customer and a supplier that share the same
  code (e.g. 'HOUZS') are the one real group company wearing its two hats
  (AR/customer + AP/supplier stay separate streams). Reuses the existing
  `suppliers.is_group_company`; the mirror decision also name-matches legacy
  rows flagged only via is_group_company. Runtime-ensured, backfilled off.
- **PO→SO mirror** — when a PO's seller is a flagged SISTER group company (not
  HOOKKA) and the global `auto_create_mirror_docs` config is ON, PO create
  auto-raises a mirror SALES ORDER under that sister (`sales_org_code` = sister,
  buyer HOOKKA as customer, PO lines copied 1:1 in sen, status DRAFT — a doc
  record, NO production cascade). Idempotent via `intercompany_mirror_log`
  (UNIQUE source_type+source_id → retry never double-creates). Non-blocking:
  any mirror failure is logged + swallowed so PO create never breaks. External
  POs never reach the DB work (pure decision short-circuits).
- Pure decision logic in `src/lib/intercompany-mirror.ts` (12 unit tests,
  `tests/intercompany-mirror.test.mjs`, wired into `npm test`).
- DO/Invoice customer auto-send: UNTOUCHED (no code near it changed).

**TODO'd (deliberately deferred):** consolidated-P&L intra-group profit
elimination (`TODO(intercompany-pnl-elimination)`); GRN mirror
(`TODO(grn-mirror)` — needs inventory-safe design since GRN posts stock+cost).

**Risk note:** mirror SO customer resolution requires HOOKKA to exist as a
CUSTOMER of the sister in the catalog — if absent the mirror SKIPS (no back-door
customer creation) and releases its log claim so a later retry succeeds.

---

## 2026-07-04 — 🔵 Multi-Company Phase 2: company dimension on SO + PO (worktree branch, NOT pushed)

ADDITIVE-only. Company selector on create + Company column + Company filter on
the Sales Orders and Purchase Orders lists. Existing docs → Hookka; default list
view shows EVERYTHING; filter defaults to ALL companies.

**Findings (verified before coding):**
- PO side largely DONE already: `/procurement/create` full-page form has the
  "Purchase company" dropdown (persists `purchaseOrgCode` via POST); PO list has a
  "Purchase co" column. Only the PO list **company filter** is missing.
- SO side: `sales_orders.orgId` is the TENANT-isolation column and the SO list is
  tenant-scoped (`withOrgScope` → `WHERE orgId=?` bound to users.orgId='hookka').
  Writing a non-hookka `orgId` would HIDE the SO → violates "show everything".
  → Company dimension for SO is a NEW snake_case `sales_org_code` column (mirrors
  PO's `purchase_org_code`), leaving `orgId` untouched.

**Plan:** (1) SO create dropdown → sales_org_code; (2) SO list column + filter;
(3) PO list filter. Runtime ensure + DEFAULT 'HOOKKA' backfill for sales_org_code.

**DONE (worktree, NOT pushed):**
- New pure helper `src/lib/company-dimension.ts` (resolveCompanyCode /
  readCompanyCode / matchesCompanyFilter) + `tests/company-dimension.test.mjs`.
- Backend `sales-orders.ts`: `sales_org_code` runtime ensure + DEFAULT 'HOOKKA'
  backfill; POST INSERT + PUT UPDATE persist it; SalesOrderRow type + rowToSO
  read (dual-keyed). PO backend already accepted purchaseOrgCode — untouched.
- SO create `sales/create.tsx`: "Company" dropdown (defaults HOOKKA), payload +
  localStorage draft. PO create `/procurement/create` already had it.
- SO list `sales/index.tsx`: "Company" column (code→name) + "Company" filter
  (default All Companies). PO list `procurement/index.tsx`: "Company" filter
  added (column already existed).
- `SalesOrder` type in `src/types/index.ts` gained `salesOrgCode?`.
- build:strict clean; company-dimension + so-category + sql-write-column-coverage
  + delivery-refs + sofa-combo tests green.

---

## 2026-07-04 — 🟡 FULL-auto payroll settlement, manual panel REMOVED (staging branch, NOT pushed)

Owner picked (A): FULL auto — auto-dock the shortfall on partial/under-logged
days too, and REMOVE the manual Keep-pay/Deduct review panel entirely. Delta
built on top of the prior-round auto-settle, on the worktree branch (NOT pushed).

**Delta this round:**
1. **Under-logged (To-fill) days now auto-dock.** New pure helper
   `computeUnderLoggedShortfallHours(logged, expected)` (= expected − logged on a
   partial day; 0 logged = absence, left to the salary deduction). Extracted the
   shared guard/apply core `maybeApplyAutoDayDock` (MANUAL never overridden,
   finalised month skipped, full day clears stale AUTO); `maybeApplyAutoPunchDock`
   now delegates to it (byte-identical — all prior tests green).
2. **`POST /settle-period` rewritten** to a unified per-day settle over ALL factory
   workers × working days: dock = max(punch shortfall, under-logged shortfall).
   Returns punch-source vs logged-source counts. `Settle month` button + confirm
   text updated; live punch-out path unchanged.
3. **Manual panel removed.** `WorkerDayDrillIn` is now READ-ONLY (dropped
   onAction/busyKey/workerId, the Action column, Keep-pay/Deduct buttons). Removed
   `handleUnderAction` + `underActionBusy` + the auto-settle-chip code + the
   period-attendance fetch. Panels re-labelled "under-logged (auto-docked)". Undo
   on a stored dock kept (restores pay for a wrong auto-dock).
3b. Historical MANUAL overrides respected (guard) + finalised months never
   re-settled.

**FULL-auto month recompute (June 2026, before=nothing docked → after=full auto):**
- AH SENG perfect → RM0.00 (byte-identical).
- MEI 15m-late (punch) → −RM51.25 (6.5h, already auto last round).
- **ZAW LIN under-logged, NO punch → −RM33.12 (4.2h To-fill) — NEW this round**
  (previously waited for a manual Deduct click).
- KUMAR mixed → −RM29.57 (0.75h punch + 3h To-fill; forgot-punch-out day logged
  full so NOT docked; OT paid).
- Crew Δ −RM113.94; of which **7.2h is NEW To-fill/under-logged auto-dock** (the
  hours the manual panel used to hold — ~RM57 on this crew, in the ballpark of the
  ~RM52.73 To-fill the owner cited).

**Tests:** `tests/settle-period-punch.test.mjs` rewritten (13 cases: To-fill maths,
day-dock core guards, unified mixed month, ZAW-LIN under-log, idempotent,
MANUAL-survives, approved-skip, corrected-clears). Full suite 1387 pass / 0 fail;
strict typecheck clean; eslint 0 errors.

**RISK owner explicitly ACCEPTED (do not re-litigate):** weak wifi → a worker who
worked full but whose punch-out failed AND whose office grid logs fewer hours
will now be auto-docked. His call; the office fixes it by keying the real hours
(clears the dock on next settle) or a MANUAL Keep-pay row.

---

## 2026-07-04 — (superseded) Auto-settle with manual panel kept for no-punch days

Prior round (before owner picked A): punched days auto-settled, no-punch days kept
a manual choice. Superseded by the FULL-auto entry above.

**What already existed (verified):** the shift algorithm + auto short-hour dock
(`maybeApplyAutoPunchDock`, `attendance-deduct.ts`) already runs on EVERY worker
punch-out (`worker.ts:1182`) and office grid save (`employees.tsx`) — ≥9h check,
late-past-grace, OT-from-30-min (owner 2026-07-04 correction confirmed live in
`attendance-rules.ts:130-136`), day-typed 2×/3× multipliers, unified ÷26. So the
per-day auto engine was DONE; the remaining "manual choice" was the Labor Cost
Under-recorded review's Keep-pay / Deduct buttons.

**What I built (auto-settlement, no manual pick for punched days):**
1. `employees.tsx` — the Under-recorded drill-in now loads the period's punches
   (`/api/attendance`) + the AUTO docks; a day with a COMPLETE real punch
   (in + out) is **auto-settled** → the Keep-pay / Deduct buttons are REPLACED by
   a read-only "Auto-docked Xh" / "Auto-settled" chip. Days with NO punch keep
   the manual choice (conservative — never auto-dock a no-evidence day). A
   clock-in-only day (forgot punch-out) stays manual, mirroring the engine guard.
2. New `POST /api/payroll-hour-deductions/settle-period` — batch-replays the
   per-day helper over EVERY punch in a month (idempotent, same guards: no
   clock-out → skip, finalised month → skip, MANUAL never overridden, full day
   clears stale AUTO). Wired a "Settle from punches" button (single-month view)
   that runs it then regenerates payslips once.
3. Tests: `tests/settle-period-punch.test.mjs` (5 cases: mixed month, idempotent,
   MANUAL-preserved, approved-month-skip, corrected-punch-clears). Added to the
   `npm test` list. Full suite 1374 pass / 0 fail; strict typecheck clean.

**Month recompute (June 2026, representative crew, before→after gross):**
- AH SENG perfect full days → **RM0.00 Δ** (byte-identical, no-change worker).
- SITI 18:25-out → **RM0.00 Δ** (OT-30 rule: 0 OT, full day — not a spurious 15m).
- MEI 15m-late daily → −RM51.25 (6.5h × ~RM7.88/h).
- RAJ leaves-30m-early daily → −RM102.50 (13h).
- KUMAR mixed → −RM21.68 (forgot-punch-out day kept full; OT day paid; short docked).
- Crew total RM10,200.72 → RM10,025.29 (Δ −RM175.43).

**Flag for owner:** the no-punch under-recorded day still shows a manual
Keep-pay / Deduct choice (conservative). If owner wants those auto-DEDUCTED too
(treat missing punch as short → dock), that's a one-line policy flip — but it
docks pay on absent-punch evidence, so left as manual pending his call.

---

## 2026-07-04 — 🔵 Owner: mobile parity sweep + FULL brutal technical audit

A. **Mobile parity**: every problem class already solved on desktop must be
   re-checked and solved on mobile (/m + worker portal) too — explicitly:
   mobile loading performance (measured /m home = 4.3MB/20 calls) and scan/OCR
   issues. Method: BUG-HISTORY + this week's fixes → per-fix mobile
   counterpart check → fix list → implement (staging for /m).
B. **Full technical audit** per owner's pasted 15-area prompt (architecture,
   DB, API, perf BE/FE, UX, business logic, AI, security, monitoring, testing,
   devops, scalability, code quality, consistency) — DONE. 12 reviewers (6
   by-domain + 6 by-module/tab), every claim file:line-verified. Report artifact
   published (erp-audit-v1). Overall 66/100 = "solid single-tenant, harden
   before 100 users". FALSE POSITIVES caught: assistant.ts "no auth" (has
   SUPER_ADMIN gate at :532); cost_ledger "out of control" (narrow COUNT-race,
   real but bounded). 5 real bugs found+fixed live this session (delivery
   bulk/POD invoice cache, folder-detail bulk cache, customer sofa-combo cache,
   /m bulk+mail cache, 52 updated_at indexes). Fix queue by tier in the artifact:
   scale-blockers (cascade transactions, N+1 bulk cascade, cost_ledger UNIQUE,
   composite indexes, money idempotency), correctness (SO→INVOICED WHERE guard,
   CN-reversal-ledger VERIFY, AR-aging page-1, warehouse stock-in rollback),
   quality (monolith files, camelCase map, API envelope, error tracking), quick
   wins. Owner picks what to build. VERIFY-BEFORE-FIX applies to every flagged item.

---

## 2026-07-04 — 🔵 Owner multi-ask batch (labor hours + OCR ordering + sweeps)

Logged verbatim so nothing is skipped:
1. **SO + GRN should follow the uploaded documentation's ORDER** — owner
   CLARIFIED 2026-07-04: he means the order of RECORDS from a combined
   multi-PO upload (10 customer POs in one file → the 10 created SOs must be
   numbered/listed 1st→10th like the paper stack), NOT line order within one
   SO (the within-SO category sort is fine / not his complaint — do NOT
   remove it). Batch-pipeline investigation running. SEPARATE keeper from
   the first investigation: desktop GRN create sends poItemIndex from an
   un-sorted array while the backend matches ORDER BY id — same class the
   mobile fix (2cfa3ba7) closed; fix desktop too (correctness, not display).
2. **Invoice-page bug classes → whole-system sweep** ("查看全系統還有哪個這樣"):
   (a) filter dropdowns sending NAME where the API expects an ID
   (b) stale grid selections surviving filter changes (DataGrid fix 99c20d3c
   already app-wide; verify no page keeps its own parallel selection state).
3. **Labor/Payroll go-live decision (owner)**: the manual Keep-pay/Deduct
   backlog panel on Labor Cost vs Revenue is NO LONGER wanted — punch clock is
   live, so the system must auto-settle from real punches per the Payroll
   algorithm (≥9h check, late deduction, OT). No manual choice. NOTE memory:
   auto-deduct was gated on staging verification (can't test pay on prod).
   Investigate current flow → propose exact auto rules → owner confirms → build.
4. **Bug: auto-from-punch hour attribution looks wrong** (owner screenshots,
   entries dated 2026-07-01): AUNG KYAW SOE punch 07:32→18:02 but only 1.33h
   logged (an approved R&D non-production row seems to displace the auto
   rows?); PHYU SIN MOE 0.01h fragment row; ZAW LIN 12:59→18:28 = 0.94+4.31
   (5.3h short — half-day, maybe correct). Also: punch-out 6:28 vs expected
   6:30 — rounding/grace? does OT count from it?
5. **Explain the pay rules in plain language**: when is a day late/short,
   when does OT start, what adds/deducts money — full list for owner. DONE
   2026-07-04 — and owner CORRECTED one rule: **OT only counts from 30
   minutes past 18:00** (code currently pays from >15 min; 18:28 must be 0
   OT, not 15 min). Fix with the ① batch on staging; affects punch autofill,
   labor engine, payslips — verify numbers on staging before prod.
6. Owner "ok" 2026-07-04 → plan approved: ① autofill safety-gate bug (an
   approved non-prod row blocks punch-row generation → AUNG KYAW SOE 1.33h
   day) + fragment rule (fold <0.1h scan-boundary rows into largest bucket)
   + OT-30min correction, all on staging → ② SO/GRN document-order fixes
   (batch investigation pending) → ③ full-auto Keep-pay/Deduct settlement
   (staging month-recalc shown to owner before prod).

Invoice-page 4-fix (BUG-2026-07-03-003) pushed to main 99c20d3c, deploy
in progress; verify live then report.

---

## 2026-07-03 — 🔵 Visibility plan EXECUTING on staging (owner: "上staging就行")

**Phase 1a SHIPPED to staging (commit 64d62058) + verified live on staging:**
KV serve-stale for the non-paginated production list — body stored under stable
key `pos:body:{org}:{qs}` with org version in KV METADATA; version mismatch →
serve previous body instantly (X-Cache: STALE) + single-flighted background
rebuild (buildListPayload(swr:false)) stores fresh body stamped with
post-compute version. Paginated path unchanged (versioned key). Freshness
semantics identical to the 2026-06-06 mark-stale SWR design — only the COST of
the stale serve drops (1.3-5.4s → ~0.1s KV read). Verified on staging (9.8MB
data, same volume as prod): MISS 5.1s cold → HIT ~0.9s → benign write (JC
dueDate set to same value) → next poll STALE 0.87s (was 1.3-5.4s MISS) →
+16s HIT fresh. Convergence ≤2 poll cycles, all reads sub-2s.
**Phase 2 SHIPPED to staging (4392e710):** new src/lib/upload-file.ts (50MB
pre-check, 180s timeout, verify-bytes-servable via Range probe before success
toast) wired into products/documents.tsx + catalog.tsx; files.ts 413 message
humanised; worker punch POST got catch + status check + 60s timeout + new
home.punchFailed i18n (was: failed punch showed NOTHING).
**Phases 3+4 SHIPPED to staging (20ceeb7a):** verify-before-fix killed most
audit claims (invoices-page create, PO/GRN/PI, inventory all already
invalidate fine). Real fixes: ① delivery-page invoice-generate now broadcasts
invoices/SO/DO cache invalidation (was: nothing) ② NEW scan-queue-sweep.yml
cron every 15min (endpoint existed, NOTHING scheduled it) ③ backup retention
prune wired: pruneOldBackups exported + CRON_SECRET-gated
/api/internal/backup-prune + backup.yml step after upload (was: prune code
orphaned behind a never-provisioned Workers Cron Trigger, dumps unbounded).
Pre-auth route allowlist test updated (security-public-endpoints.test.mjs).
NOTE: schedule: workflows only fire from main — sweep/prune go live at merge.
**Remaining:** restore drill (needs owner's Supabase dashboard, PITR confirm);
deeper perf levers (BOM parse cache, fabric precompute, per-dept versions) =
diminishing returns, only if lag persists after Phase 1a.

**2026-07-03 late: all-tab perf sweep on staging (17 pages, live measured).**
Owner upgraded Supabase (plan/compute — helps DB speed + PITR; app-side fixes
still needed). HEAVY tabs (payload/slowest): ① /m mobile home 4.3MB/20 calls
(652KB delivery-orders + eager prefetch of everything — phones on weak wifi!)
② /inventory 4.0MB (inventory/wip 2.9MB + delivery-orders 652KB + products)
③ /delivery 2.4MB (pulls FULL unpaginated sales-orders 1.4MB @ 6.1s + products
277KB) ④ /warehouse 1.7MB (one 1.45MB call @3.8s) ⑤ /procurement 1.3MB
(inventory 895KB on the PO page). HEALTHY: invoices 156KB, customers 14KB,
GRN/PI ~200KB, planning 37KB, reports lazy, consignment 320KB, employees
274KB, sales ~1MB acceptable. Disease = same as production had: pages eagerly
pull FULL sibling-module lists. Cure queue (owner to green-light): slim/paged
variants for delivery→sales-orders, inventory/wip, warehouse list; /m home
lazy per-tile loading. Reuse Phase-1a KV serve-stale pattern where applicable.

**Phase 0 SHIPPED to staging (commit bb104e1f) + verified live on staging URL:**
① archive real-run hard-disabled (POST ?dryRun=false → 410 confirmed; dry-run still
returns counts) ② global search shows "Search failed — connection problem" on network
failure instead of "No results" (verified by fetch-fail simulation; normal search
regression-checked OK). NOTE: lock protects PROD only after staging→main merge (owner
must order the merge explicitly).
**Phase 1 measurement (live prod, read-only):** wire transfer is only 0.5MB (CF
compression) — download is NOT the bottleneck; TTFB = 5.4s on cold snapshot rebuild,
1.3-1.8s snapshot-warm/KV-miss, 0.77s KV HIT. 92% of decompressed 10MB = jobCards
(14,702 JCs / 1,007 POs). fields=minimal already slims non-active-dept JCs in DEPT
mode but OVERVIEW mode (activeDeptCode=null) sends full shape for all 8 depts.
piecePics NOT emitted in minimal (agent claim corrected). → Phase 1 = attack server
compute (5.4s rebuild + per-write version-bump churn) + overview-shape trim as
secondary; NOT pagination (breaks 10 features), NOT transfer size (already 0.5MB).

---

## 2026-07-03 — 🟡 Full-system "visibility" audit DONE → plan proposed, awaiting owner pick

4-agent audit completed (archive reads / uploads / caches / archived-row writes).
**Verdict: NEVER run the archive as-is** — hot-only reads mean archived orders vanish
from search + detail 404 + dashboards/reports/accounting undercount (dashboard-overview,
department-performance, leadtimes, compliance-report, accounting.ts all hot-only;
INNER JOINs in invoices.ts:1306 / planning-schedule.ts:131 DROP rows); writes silently
no-op on archived rows (invoice-from-old-DO can bill RM 0 via computeDoInvoiceLines
fallback, po-cost-cascade.ts:529 skips cost posting, consignment hold 0-row UPDATE,
recomputePoStatusAndProgress no-ops); NO unarchive endpoint. Archive stays dormant/never
run; 45d COLD_DAYS harmless. Speed to be solved by pagination instead (Fix #1).
Other real gaps found (all need verify-before-fix at file:line before touching):
① invoices POST doesn't invalidateCachePrefix("/api/invoices") → cross-tab stale list
② PO/GRN/PI caches not cross-linked ③ inventory list manual-refresh only ④ uploads:
file listed in DB but bytes possibly not yet openable (storage lag) → "uploaded but
can't open"; presigned URL 300s expiry mid-Export-Pack; 413 error prints raw bytes.
Proposed 3-step plan to owner (1 = paginate+server-search Production, 2 = upload
verify-then-confirm + retries + human errors, 3 = cache invalidation patch set).
Stale-chunk white-screen: already well-mitigated (main.tsx preloadError + SW purge).

---

## 2026-07-02 — 🔵 Debtor/Creditor OPENING 工程(年中开账,owner 全程拍板)

- ✅ Supplier Payment 每行加 print(已上线 prod)
- ✅ Debtor 对账定案 v5(货品级三层验证 PO→SO→description):opening 52 张 RM 148,803 + knock 系统发票 RM 7,588 = 旧TB 156,391 分毫不差。工作簿 Downloads/debtor-opening-最终清单-v5.xlsx。**Debtor+sales 等业主最终确认才录(铁律)**
- 🔵 年中开账功能(分支 `claude/midyear-opening`,canary 就绪待业主验):opening 表格收 P&L + 22/05 前 PI 默认当 opening(`opening_ap_excludes` 排除表,原单零改动)
- ✅ Creditor 开工包已交付:Downloads/creditor-opening-开工包.xlsx + creditor-opening-粘贴版.sql(76 张期初 PI RM 118,138.41;排除 8 定案 + GVP×2/CLM×1 待业主决定;Advance GVP 950/CHL 640;开账表格数值页)
- ⏳ 待业主:① canary 验收→合 main ② 建 DELIMIX 供应商 ③ 决定 GVP×2/CLM 排除与否 ④ 按开工包顺序执行
- 铁律:之前录入的不删不改;录入动作全部等业主下令

---

## 2026-07-01 — ✅ Supplier Payment list showed empty despite a real, GL-posted payment (BUG-2026-07-01-003)

Owner recorded HPV-2607-002 (ADD WOORD TRADING, RM 11,476.00) via the normal Record
Payment form — visible in Supplier Statement + Creditor Ledger, but the Supplier
Payment page's own All Payments list + summary cards showed all-zero/empty, even
after a hard refresh. Root cause: `GET /api/supplier-payments` read `row.payment_no`
(snake_case) but the Postgres adapter camelCases every result column regardless of
SQL alias text — same class as BUG-2026-06-30-001. Second, independent bug found
in the same sweep: `purchase_invoices.amount_sen` / `paid_amount_sen` misreads made
PI-targeted allocations (POST /, restate, and today's own Knock-off feature) always
see outstanding=0 — likely why the owner ended up using the Advance field for this
payment instead of paying PI-2606-037 directly. Fixed both (dual-keyed reads,
extracted to tested pure helpers in `src/lib/supplier-payment-alloc.ts`); shipped to
`main`. **Owner follow-up needed:** use the Knock-off feature to re-attribute
HPV-2607-002's advance to PI-2606-037 (GL is correct; only the subsidiary
attribution is off). See `docs/BUG-HISTORY.md` BUG-2026-07-01-003 for full detail.

---

## 2026-06-30 (late) — ⚪ Supplier-PI OCR quality QA (owner batch, after the compression fix)

Owner scanned a real 13-PI bundle (compression fix WORKED — it split + extracted).
Found 7 issues to triage/fix:
1. 🔴 **Price = 0 on some PIs** — NHL invoice (IV-91176) shows 99.40 / total 757.68
   but the PI line came out Unit Price 0 / RM 0.00. Haiku missed the price on a
   faint/messy scan; existing "Fix A" backfills unitPrice from supplier price
   bindings only (no binding → stays 0). ⚠️ check if the ~150-DPI compression
   hurt price legibility (raise quality?). Money path — highest priority.
2. 🟡 **Preview cards NOT in upload/page order** — children named pi-9-10 / pi-28-29
   (split works) but cards aren't sorted by page range → owner tallies manually.
3. **Ensure INVOICE-type docs convert as Purchase Invoice** (vs DO/GRN) — confirm
   docType=INVOICE → PI flow holds.
4. **Dup detection — same PI scanned twice:** only EXACT same file bytes are
   deduped (file-hash). A re-scan/re-photo of the same invoice = different bytes
   → NOT caught. GAP: detect by supplier invoice number.
5. **Different invoice numbers (451 vs 450)** — each doc's invoice no is extracted
   separately (treated as distinct ✓); relates to #4 (dupe-by-number).
6. **Discount:** PI DETAIL supports a DISCOUNT line type (exists), but the scan
   preview doesn't capture the invoice's discount → manual add today. Could
   extract discount in OCR + surface on the preview card.
7. **Sponge density + thickness** (3rd photo) — density (NLY22GH) + thickness
   (25MM) are critical for matching the right Internal Code; ensure OCR extracts
   + uses them.

---

## 2026-06-30 — 🔵 "全部强化掉" — SRE / infra resilience + perf + OCR (owner directive)

Owner authorized hardening the whole reliability layer. Playbook written:
[`docs/INFRA-RESILIENCE-PLAYBOOK.md`](INFRA-RESILIENCE-PLAYBOOK.md) (reusable
across sibling projects). Goals in owner's words: entering the system must not
white-screen / be slow / lag; DB fetch fast; EVERY operation incl. the Workers
mobile (`/worker`, `/m`) must not lag (currently laggy). Plus OCR + research.

**Asks logged (so none drop):**
1. ✅ Pool size 50 (owner set in Supabase). ⏳ Compute → Small blocked by a
   Supabase platform incident (project resizing failing globally). Re-do once
   status.supabase.com clears; verify it lands on prod `vpwdqtsxexpiqxzweivd`.
2. 🔵 **B — DB connection retry + graceful 503 login** (`supabase-compat.ts`,
   `auth.ts`) — written, shipping now.
3. ⬜ **Keep-warm heartbeat** — ping `/api/pg-ping` every 1–5 min (GitHub Action
   or UptimeRobot; Pages can't cron).
4. ⬜ **Don't logout on transient failure** — session-verify returns 503 (not
   401/500) when DB errors; frontend retries once before `clearAuth()`.
5. ⬜ **Monitoring** — set `SENTRY_DSN`; UptimeRobot on `/health`.
6. ⬜ **Perf diagnosis** — white-screen / slow mobile (`/worker`, `/m`) — needs
   real diagnosis, not a blind switch.
7. ⬜ **OCR** — confirm/enhance: upload 100 imgs → auto-split (by SO / by GRN),
   done docs show first + rest "loading", non-blocking (mostly shipped in
   BUG-2026-06-30-003; verify the grouping matches the ask).
8. ⬜ **Research** — what else normal ERPs do for SRE/infra → add to playbook.

---

## 2026-06-29 — ⚪ PARKED for study: Weak-wifi resilience campaign

**Owner (2026-06-29) — factory remote, wifi weak, workers can't punch / can't
login / white-screen. Asked for the "full campaign" root-cause solution. Decided
to STUDY first before building — too big to do reactively.**

**Already shipped this session (preventive):**
- ✅ `SameSite=Strict` → `Lax` on session cookies (`session-cookie.ts`,
  `auth.ts`, `auth-oauth.ts`) — workers opening ERP from WhatsApp/email no
  longer arrive without cookie → silent 401 → /login bounce. Industry-standard
  posture; CSRF defence retained via double-submit `X-CSRF-Token`. Test
  assertions updated in `tests/session-cookie-remember-me.test.mjs` (NOT yet
  pushed — owner rejected; pending owner OK).
- ✅ SPA `<script>`-tag asset-404 recovery (`main.tsx` + earlier
  `vite:preloadError`) — catches stale chunk after deploy → SW purge + reload
  (was only catching dynamic `import()` failures before).
- ✅ Sticker `legsPair` overflow on DIVAN piece (root cause was unrelated to
  wifi but surfaced same week).

**Studied solution menu (DO NOT START — needs owner go-ahead per item):**

Level 1 — Network infrastructure (most effective, $-cheap, OWNER ACTION):
- Mesh wifi APs in factory (1 per dept ≈ RM 300-800 each, total ~RM 1.5-3k)
- 4G/5G failover router (~RM 400) — auto-switch when wifi dies
- Cat6 to fixed punch stations / total office PC

Level 2 — Software (engineering work, large):
- **A. Offline-first punch + sync** — IndexedDB queue, UUID idempotency, GPS+selfie
  captured locally + uploaded on reconnect. 99%+ achievable, NOT 100% (browser
  cache-clear + reinstall lose unsynced events). 2-3 hours code, 1-2 weeks
  pilot before full rollout.
- **B. Pre-cache login page + app shell** — login renders even with wifi flicker
  on first hit. ~1 hour.
- **C. Don't kick out on transient 401** — retry once with fresh cookie before
  redirecting to /login. ~45 min.

Level 3 — Architecture (medium):
- Split shop-floor view (offline-first) from office view (online-required)
- Local edge server per dept (Raspberry Pi-style) caching + buffering

Level 4 — Hardware (long-term):
- Dedicated factory tablets at punch stations (more stable than worker
  phones) — runs same /worker PWA but fixed location + reliable power + 4G

**Specifically called out risks for A (offline punch):**
- Worker clears browser cache → unsynced punches LOST
- Clock manipulation (server must record device-time + sync-time)
- Late-arriving sync hitting closed payroll day → cron re-run needed
- Selfie + GPS upload retry logic if first attempt fails
- Server dedup on (workerId, ts, action) via UUID per event

**Owner's gating decision:** "放进 pending tasks 先, 大工程, 我们需要先 study."
Plan: revisit AFTER Level 1 network improvements are done, see if pain
remaining justifies Level 2 work.

---

## 2026-06-26 (late) — CURRENT STATE (tidy summary; detailed logs below)

**✅ LIVE on prod + staging:** PIC flicker fix · mint+jc sticker · packing-list per-piece racks · Standard Times (#B) · announcement collapse · 2-PIC everywhere · DO-email PDF · schedule Barcode→QR · **PIC2 save fix** (Hyperdrive read-after-write false mismatch).

**🟡 ON STAGING — awaiting owner verify → then promote to prod:**
- Real-logo PWA icons · Auto-sent mail full-detail view (was a modal)
- **Announcement photos/PDF now render** — worker-token file proxy `/api/worker/ann-files/:id/download` (root cause: `/api/files` is cookie-gated, 401s on the phone)
- Media lightbox (square tiles + fullscreen swipe) · Past-announcements moved to Me tab (below Standard Times) · Clock-in full-width (no box-in-box) · single-dept label
- **Announcement targeting** — All / specific departments / specific people, multi-select (default All)
- **Web Push** — announcement→push (respects targeting) + 8:00/18:00 clock reminders. ⚠️ needs VAPID secrets set to work
- **#C Time-adjustment** — non-prod hours + NEW extra-production-time claim; efficiency = (WIP std min + approved extra min) ÷ ((prod clock-hrs − approved non-prod) × 60); no-claim workers byte-identical. ⚠️ owner verify the efficiency math
- Earlier staging batch: #3 mail-list UI · #5+/r/ per-piece QR/rack · #D media columns · #E archive · multi-dept · staging trim

**⚙️ DEPLOY STEPS before Web Push works:** set Worker secrets `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `PUSH_CRON_SECRET` (+ `VAPID_PUBLIC_KEY` matching the committed fallback) on prod AND staging; add `PUSH_CRON_SECRET` as a GitHub repo secret for the clock-reminder workflow.

**🔍 Investigated, NOT bugs:** Eff-allowance @86% = per-worker "Eff. Threshold %" set ≤86 (data edit, not code) · Fab Cut "10 min" = BOM `dept_working_times` data (fix in WIP Times maint); WIP-time edits aren't audited so there's no record of who changed it (could add `emitAudit`).

---

## 2026-06-26 — Coding-base kickoff → staging deploy + test (owner rapid-fire)

**Branch: `feat/packing-mint-jc` → pushed to `staging` (NOT main/prod). Owner ruling: route this whole batch to staging, verify, then decide prod promotion.**

**✅ Shipped to staging:**
- **TASK 1 — packing mint poNo-drift fallback** (`production-orders.ts` POST `/packing-rack-tokens`): mirror worker.ts scan-lookup recovery (trim/CI poNo → `fg_units.poId`, live-PO only). + **TASK 2 — FG-PACKING sticker carries `&jc=`** (mint returns `cardIds`; `packingStickerUrl` appends jc; `parseStickerData` reads jc; worker `handleDecoded` resolves jc first). +6 source-assert tests. BUG-2026-06-26-001. ⚠️ Owner later said **packing scan no longer needs internal/external split** — but KEEP the public `/p/` + `/r/` codes (warehouse rack stock-in uses them); the mint/jc work is additive/harmless, left in place.
- **PIC cell flicker fix** (BUG-2026-06-26-002): the live overlay + baserows read `pic1Name`; the `?fresh=1` read-back + list snapshot return `pic1Id` but not always the joined name → cell blanked → flicker. Fix: overlay derives name from `pic1Id` via the `workers` roster when `pic{1,2}Name` empty (`deptRows` overlay, `production/index.tsx`). **All production departments** (one shared row model / PIC renderer). Completion date never flickered (stored field).
- **Packing List per-piece STACKED rack layout** (owner-approved mockup): rack column shows `HB: Rack 19` / `Divan: Rack 19, 20` (labelled, compact, newline-stacked); `generatePackingListPdf` takes optional `DOPrintExtras`; new `fmtRackStacked` reuses `formatRacksCompact`; col 30→34mm; falls back to flat rackingNumber; call site fetches `/print-extras`.
- **Staging DB refresh** (sync-staging.yml) + **staging trim**: deleted the 347 pre-2026-05-01 sales-order chains (619 POs, 9434 job cards, 923 fg_units, 151 invoices, 91 fully-owned DOs, etc.) via new `trim-staging.yml` (staging-scoped GH workflow, single transaction, FK-ordered, divide-by-zero guard, ANALYZE). 564 SOs kept, **0 orphans**. Undo = re-run sync. `trim-staging.yml` lives on `main` (inert tool — report default, execute needs `confirm=TRIM`); can be removed.

**🟡 In progress / queued (this session):**
- **② Unify the two rack UIs** (owner approved direction): make `warehouse.tsx` rack-contents card + `rack-scan.tsx` public `/r/` stock-in page share ONE rack card (same olive header + same item row: product code → customer·PO → SO; public adds trash + Stock In). Mockup approved 2026-06-26. NOT built yet.
- **③ Barcode scan feedback** — owner: QR scan turns blue (hit) but Barcode shows no blue/red; the gun/phone capture is also less sensitive. Add the same colour feedback to the barcode path. NEED to pinpoint the exact scan screen (worker-portal result card vs `/r/` rack scan). NOT built.

**⚪ Owner live-verify (staging) — no code unless a check fails:**
- Completed-row vanish (TASK 3) — owner tests one-by-one / batch / status-cell completion, names the path that drops a row → wire into `forceShowCompletedIds`.
- Doc-date basis · opening_date floor · PARTIAL_PAID (paste `Hookka迁移11` + test partial supplier payment) · QR canonical domain · customer-email drain. (All backend-shipped earlier.)

**Owner notes this session:** staging slowness = Tokyo region + small tier, NOT data volume (prod has same data, fast) — trim won't fix speed (owner trimmed anyway for shorter lists). Login bounce on staging = use incognito + prod creds (DB cloned from prod).

### Owner "把 pending 全部做掉" — parallel-agent build batch (late 2026-06-26) — SHIPPED to staging
Built via parallel worktree subagents, each reviewed + cherry-picked onto `staging` (typecheck app+base clean, tests pass). **STAGING-ONLY — owner must verify before prod:**
- **#3** Auto-sent mail view restyled to match the normal mail list (OutboxPanel rows/header).
- **#B-2** Standard Times multi-department selector (worker with >1 dept picks which dept's WIP times; backend `?dept=` validated vs the worker's set).
- **#E** Worker portal "Past announcements" archive — expired/hidden notices re-readable (collapsible).
- **#5 + /r/** Per-PIECE packing QR/rack: `piece_pics.racking_number` (mig 0192 + runtime self-apply), `/p/<token>?p=N`, per-piece `applyPackingRack`, `packingPieceIdentity` carries pieceNo, AND the `/r/` "scan items into rack" stock-in is per-piece — fixes "2nd DIVAN piece already in this rack". Additive (single-piece/old stickers byte-identical).
- **#D** Announcements carry image/video/PDF (mig 0193 `announcements.attachments` + runtime self-apply; reuses `/api/files`; worker renders inline).
- **PWA phase-1** installable worker portal (manifest + safe SW [network-first nav, never caches /api, version-keyed, prod-only] + Android/iOS install prompt + already-installed detection + geolocation re-ask suppression). build:strict passes. **SW is the riskiest — verify the app still loads.**
- **#C** Non-production hours APPLY (worker) + APPROVE (admin Working Hours) — new `worker_nonprod_requests` (mig 0110 + runtime self-apply); approve writes a non-prod `working_hour_entry` via the EXISTING path → efficiency denominator already excludes non-prod (departments.isProduction) → efficiency rises, NO pay-formula change.

**Investigated, NOT bugs (no code):**
- **Efficiency allowance @86%** → BY DESIGN: per-worker "Eff. Allowance (RM)" + "Eff. Threshold %" columns; that worker's threshold is set ≤86. Fix = data edit (raise threshold). Label is just misleading. (docs/investigations/2026-06-26-efficiency-allowance-86pct.md)
- **Fab Cut "suddenly 10 min"** → BOM-config data (the bedframe products' Fab Cut minutes in dept_working_times = 10), not a code regression; fix in WIP Times maintenance.

**STILL PENDING (the one big piece not built):** PWA **phase 2/3 = Web Push notifications** (announcement→push + 8:00/18:00 clock reminders) — needs VAPID + subscription storage + send + cron. Phase-1 install is the prerequisite (done); iOS push needs the PWA installed (16.4+).

### Owner spec batch (late 2026-06-26) — design/propose, then build (logged so none drop)
- **#A Department scan restriction — ❌ DROPPED by owner (2026-06-26).** Owner decided NOT to build the restriction/popup. Simpler model kept: the department is inferred from WHO scans (their own section), exactly like the shared Sew/Uph sticker (women's section → FAB_SEW, men's → UPHOLSTERY). No blocking, no "wrong dept" popup. Don't re-propose. ~~(proposed): worker may only scan stickers of their CURRENT dept (= latest dept-scan today, else punch dept); cross-dept scan → blocked popup "you are in <DEPT>". Choke point = `GET /scan-lookup` (skip shared Sew/Uph `wk=`/`c=` stickers, already self-route by section) + backend guard on scan-complete / scan-complete-dept. NO current enforcement exists. Full flow map done (clock→dept_scan_events→buckets→working_hour_entries via dept-scan-split.ts/punch-autofill.ts). Mockup popup → build after owner confirms current-dept rule + edge cases.
- **#B Show Production WIP Time to workers by their dept** (mockup requested): WIP time IS per-dept (BOM Time per WIP×dept; `dept_working_times`; FAB_CUT card mins = Σ BOM dept slots). Workers "totally don't know" the standard minutes → disputes. Worker Portal needs a read-only "your dept's standard times" view (their dept ONLY, from `workers.departmentCode`). Mockup the Worker-Portal placement.
- **#C Non-Production hours apply + approve flow** (design): depts have a Prod/Non-prod flag (Warehouse/Repair/Maint/Shortfall/R&D = Non-prod; Packing/Fab/etc = Prod). Worker who did non-prod work but missed the scan applies "Xh in <non-prod dept> today" → approval (prefer the approve action in the Working Hours screen). On approve: 9h all-prod → e.g. 7h prod + 2h non-prod, so efficiency = output/prod-hours (7/7 = 100%). Design where it lives.
- **#D Announcements rich media**: support image / video / PDF upload (tutorials, SOP PDFs, feature guides) — currently text-only. Reuse `/api/files`?
- **#E Announcement UX in Worker Portal**: (1) collapse/expand each announcement (tap to fold/unfold even after "got it" — long ones eat space); (2) expired announcements currently VANISH from the worker portal — owner wants past ones still READABLE (archive). Clarify Hide (manual) vs Expired (auto past hide-date) vs Delete. Worker portal (worker/index.tsx) home shows only Live, non-hidden.

## 2026-06-25

### QR/Barcode · Rack · Packing · Warehouse · Payroll — rapid-QA batch (owner rapid-fire)
**✅ SHIPPED to prod + staging:**
- **Identity trio** (Customer · Customer PO · Our SO) on rack scan / rack warehouse grid / rack popup / stock-out / Packing List / DO PDF
- Rack display **dedup** (Assign-Rack SO/PO + grid "SO SO") + mobile rack **contents list**
- **Unified `/p/<token>` packing-rack scan fix** — archive-aware `resolveCard` + `pickPackingCard` tiers + token-mint hardening (BUG-2026-06-25-003..006)
- Schedule **"Barcode" column: QR → 1D Code 128** (barcode-gun reads it)
- Packing List **per-piece rack label** (HB / Divan can be on different racks)
- **Warehouse search** — partial match (Our SO / customer PO / customer / product)
- Rack card **de-cram** (cleaner per-item layout)
- **DO dispatch → auto stock-out** (whole DO's items leave their racks) — delivery-orders.ts `stampedOnDispatch`
- **Payroll TOTAL row alignment** (was missing the Allowance cell)
- Barcode + QR **render-resolution bump** (clarity)
- **Manual Rack dropdown now saves** — `patchRack` was the only mutating call missing the CSRF token → 403 → silent rollback (`f9f05433`)
- **Staging code + DB sync** (FF + sync-staging.yml)

**✅ SHIPPED (cont.) to prod + staging:**
- **Sticker show/print slowness** — preview paints instantly (fallback URL) then upgrades to /p/ in the background; mint endpoint batched (serial per-piece loop → 2 queries + parallel mint). `bcb000d4` (BUG-2026-06-25-008a)
- **Manual rack assignment → warehouse occupancy** (owner B) — `applyPackingRack` now mirrors a `rack_items` row (set/move/clear + `rack_locations` status); office dropdown / `/p/` / worker scan all now show in the Warehouse grid; NEW shared `packingPieceIdentity` locks the identity vs the `/r/` scan. `3ec97e43` + CI wiring `4604c1a0` (BUG-2026-06-25-007)
- **CSRF audit = FALSE POSITIVES** (closed, NOT a bug) — `api-client.ts` globally monkey-patches `window.fetch` to auto-inject the token; the 40 "missing-CSRF" hits are non-bugs; the earlier `patchRack` CSRF "fix" (`f9f05433`) was a no-op. Don't re-chase. (BUG-2026-06-25-008b)

**✅ QR canonical domain (2026-06-26)** — prod's legacy `hookka-erp-testing.pages.dev` now renders as `erp.hookka.com` on EVERY QR / printed link / invite (new `src/lib/app-origin.ts` `canonicalizeOrigin`/`appOrigin`, applied to rackScanUrl / generateStickerData family / packingStickerUrl / dept-QR cards / invite link / DO+PL `qrScanUrl`); staging / preview / localhost keep their own origin so their QRs still resolve against their own DB. Scanning stays path-based so old pages.dev stickers still work. `fb31ab80`, +6 tests (owner "比较好看").

**✅ CoE docs + CLAUDE.md refreshed** (2026-06-26) for this session — CODEBASE-MAP (warehouse rack→occupancy, `packingPieceIdentity`, FG-sticker batch), HOOKKA-GOTCHAS (+CSRF global interceptor, QR-follows-origin + canonicalization, rack-occupancy identity, codes-always-scannable), CLAUDE.md (CSRF-is-automatic + QR-origin non-negotiables).

**❌ Code 3-day lifecycle rule — DECLINED by owner (2026-06-26).** Owner chose **(A) always-scannable, NO time limit** after learning the old "expiry" was structural resolution failures, not a timer. NOT building a time-based expiry; the structural fixes (archive-aware resolve + pickPackingCard + token re-read) already shipped are the whole ask. See [[project_qr_no_3day_expiry]].

**🟡 PENDING / owner action:**
- **#1 external-phone scan opens Worker Portal not /p/** — owner reprint a sticker on staging + scan: old sticker = reprint; still wrong = mint bug (I dig)
- **#3 completed-piece "Complete" button** — CONFIRMED **NORMAL** (2-PIC sign-off), no change
- **Packing List stacked per-piece layout** mockup — awaiting owner OK
- **Verify on staging**: pick Rack 9 on the packing sheet → confirm it shows under Rack 9 in Warehouse; sticker preview/print is fast now

### 🔵 Owner "继续财务" → document-date reporting basis (was entry-date / postedAt)
Owner: "一切跟单据日期，不是开单日期 — 7月开6月的东西算6月." Root: the immutable ledger stores only `postedAt` (entry time) and ALL GL reports bucket/floor by it; a June invoice entered in July landed in July. Owner saw it as Monthly P&L Sales (634k, by postedAt) ≠ Command Center invoices (312k, by invoiceDate) — confirmed not my floor (pre-existing accrual-vs-issue gap). Owner approved a read-time **document-date resolver** (no DB change, postedAt fallback). Design/plan: `财务模块-单据日期口径-设计.md`/`-实施计划.md`.
- **Good news**: subledger reports (AR/AP control, statements, debtor/creditor-ledger, aging) were ALREADY document-date (read invoiceDate/date directly) — only the GL-based reports used postedAt.
- Pure `src/lib/doc-date.ts` (`stripLegSuffix` drops _void/_bounce/_reversal/_settle/_restate_rev|post:stamp → base family; `DOC_DATE_FAMILIES` maps 12 families → table/no/date cols, snake_case) + 8 tests. `loadDocDateResolver(db)` (accounting.ts) loads each family's (id, human-no → own date) ONCE, dual-keyed (sourceId is sometimes UUID, sometimes the doc number), try/catch per family, `docDate(sourceType,sourceId,postedAt)`: opening→opening_date, mapped family→doc date, period-end bookkeeping→parsed from sourceId (`parseSourceIdDate`: depreciation `dep-YYYY-MM`→month-end, closing_stock `cs-YYYY-MM`→month-end, year_close `fyclose-YYYY-MM-DD`→that date), else→**postedAt fallback (= legacy, safe)**. contra is always same-day (`today`) → postedAt is already its doc date (kept). (Follow-up 1 `f7c49d8a`: period-end parser. Follow-up 2: per owner "银行转账也需要根据文件日期" — fund_transfer (pure-ledger, no date stored day-precise) now records its date in a new `fund_transfers` table (no→date, runtime self-apply + migration 0190 / Hookka迁移12); resolver family fund_transfer→fund_transfers; the /fund-transfers list also shows the doc date. Existing transfers (no row) fall back to postedAt.)
- Wired 13 GL read paths to docDate (bucket + floor): trial-balance, gl all+one, gl-report, pl, cashflow, bank-reco+automatch, glWindowSigned (P&L windows), cost-expense-classes, computeUnclosedAsOf, ar/ap-control GL sums. Added `sourceId` to the queries that lacked it.
- **Perf**: `computePnlWindow`→`glWindowSigned` is called per-month (pl-monthly/trend); threaded a `DocDateCtx` so the resolver loads ONCE per request, not ~12 tables × N months. typecheck+eslint+1189 tests green.
- ⚠️ Backend-only (no frontend chunk change) → owner verifies live: a backdated invoice (doc date earlier than entry) should land in its DOCUMENT month on P&L/GL.

### 🔵 Owner "继续财务" → opening_date hard floor (pre-opening data not extracted) — ALL financial reports
Owner set opening_date=2026-05-22 but the GL ledger still showed pre-opening (2026-05-18) invoices — opening_date was only used to DATE opening legs, never as a floor. Owner chose "排除 + 之后重录真实期初" + "直接全做" (floor every financial report, not just AR/AP). Pure helper `src/lib/opening-floor.ts` (`legBeforeOpening` GL / `rowBeforeOpening` subledger; opening SEEDS exempt — GL opening_balance legs + invoices/PIs `is_opening=1` — so opening balances are never lost) + 11 tests. Floored (17 read paths in accounting.ts): trial-balance, gl (all+one), gl-report, pl (P&L+BS), cashflow-statement, bank-reco + automatch, computePnlWindow (pl-statement/trend/monthly), cost-expense-classes, **computeUnclosedAsOf** (BS retained earnings — would've inflated), ar-control (GL sum + invoices), ap-control (GL sum + PIs), customer/supplier-statement, debtor/creditor-ledger, aging (snapshot — added kv_config to sourceTables so it rebuilds on opening_date save), other-party-aging. Floor preserves double-entry balance (whole events skipped, both legs). NOT floored (by design): manufacturing cost/stock reports (own `material_opening_date` cutover), fixed-asset register (master data), document-list registers (fund-transfers/PV/OR — operational, not balances). ⚠️ Expected effect until owner enters real opening balances: AR/AP/P&L/BS ≈ near-zero (post-05-22 activity only). typecheck+eslint clean.

### ✅ Owner "继续财务" → "收尾小项" — task-chip cleanup batch (AP / supplier-discount) — SHIPPED (main `78f47bb2`; prod chunk `accounting-Bzp1Jg9y.js`→`accounting-D2ouG57q.js`)
🟡 **Pending owner**: run `Hookka迁移11-粘贴到SQL-Editor.sql` (permissive PARTIAL_PAID/CANCELLED constraint, names + registers it — runtime self-apply already relaxes it) + live-test one partial supplier payment / discount-allocation (status → PARTIAL_PAID, no 500). Owner confirmed the Supplier-counter card stays removed ("就先这样"). See BUG-2026-06-25-001.
Owner picked the no-data cleanup bucket. Investigated all chips against real code (did NOT trust notes blindly — one was a false alarm, one a confirmed prod bug):
- 🔴 **CONFIRMED PROD BUG — `purchase_invoices.status` CHECK rejects `PARTIAL_PAID`.** `0057_purchase_invoices.sql:30` = `CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PAID'))` — no PARTIAL_PAID. Supplier-discount alloc (accounting.ts:2001) + supplier partial-payment both write `status='PARTIAL_PAID'` → constraint violation → POST fails in prod. Second independent reason partial payments are silently broken (migration-7 missing column is the first). FIX: (a) runtime relax in `ensurePartialPaymentColumns` (`DROP CONSTRAINT IF EXISTS purchase_invoices_status_check`); (b) extract that helper to shared lib + call from `supplier-payments.ts` routes (closes the existing "supplier-payments should call ensure" chip); (c) migration 0186 + paste `Hookka迁移11` (DO-block: drop status CHECK, add permissive named `purchase_invoices_status_chk`).
- 🔵 **CREDIT_NOTE marker defensive filter** — markers = `supplier_payments` rows (amountSen=0, method='CREDIT_NOTE', no GL leg). Add `AND COALESCE(method,'')<>'CREDIT_NOTE'` to: supplier-statement (accounting.ts:2331) + creditor-ledger (2466) [hide 0-amount noise rows], and supplier-payments void/restate reads+delete [defense-in-depth; no number collision today].
- 🔵 **Remove dead AP "Supplier running counter" card** (accounting/index.tsx:3184-3190) — `suppliers.outstandingSen` never maintained → always red drift; the real reconciliation is card #2 (Creditor control vs booked-unpaid PI, drift=0). Keep symmetric AR Customer-counter card (that one IS maintained).
- ✅ **FALSE ALARM — journal-hash.ts:113 ledger UNIQUE constraint comment is CORRECT.** Prior note said it "lies"; actually `0117_ledger_idempotency.sql` really creates `UNIQUE(org_id,source_type,source_id,leg_no)`. The mislead: stale `delivery-snapshot.ts:6` comment cites a non-existent `0117_delivery_snapshots.sql` (real file = `0124_delivery_snapshots.sql`). No change to journal-hash; fix the stale delivery-snapshot comment.
- ⚪ **Voucher-print "loose ends"** — no TODO/FIXME in print-voucher.ts; nothing concrete found. Report back for specifics.

### ✅ Owner "全部做完" — Production/Dispatch/Worker-UX backlog closed out
Scoped all 6 open items (read-only multi-agent investigation). Result: most were already shipped after the 06-23 tracker entry; built the genuine gaps.
- ✅ **#1A Overview search by Customer PO** — `customerPOId` is in the search haystack (production/index.tsx:2659) + 98% populated live → already works. Complaint predated the haystack line.
- ✅ **#1B Overdue chip clears filters** — handler at :1376-1378 already clears q/state/customer/cat + clearAllOverviewFilters() (06-23 fix). Done.
- ✅ **#2 Pending-Dispatch QR-scan popup** — `do-scan.tsx`: product code already the primary line (prior commits); added shared **Customer PO** in the per-DO header (shown once when all lines agree, `hideCustomerPO` flag avoids per-row dup). Cherry-picked `571e3806`→main, shipped.
- ✅ **#3 Print uses SAVED layout + Org Default** — print preset wired (`printPresetLabel`); DataGrid auto-wires onSaveAsOrgDefault/onResetToOrgDefault when gridId present (data-grid.tsx:2846-7); ③ made them backend-shared. Done.
- ✅ **#4 Barcode** — already migrated 1D→compact ~12mm QR, column already "Barcode". The "thick/long/hard-to-scan" complaint was the OLD 1D code. Done (shrinking further would hurt scannability).
- ✅ **#5 Sticker component-type label** — `generate-sticker-pdf.ts`: new `componentTypeLabel(wipType)` (HB/Divan/Base/Cushion/Armrest/Headrest; blank for FG/merged) on landscape bottom-right + portrait right column. `wipType` already on the sticker model (no loader change). Cherry-picked `2c3804fd`→main, shipped.
- ✅ **#6 Catalog family tile** — already implemented (products/catalog.tsx: family grouping, one-tile-per-family, variant drill-down, family-keyed photos). My 14-photo seed lit the tiles up.

### ✅ Archive includeArchive UNION 500 — FIXED (BUG-2026-06-24-009b)
Self-healing `src/api/lib/archive-union.ts` (introspect + ALTER archive to column parity + explicit quoted ordered column list, replacing the fragile SELECT * UNION) + org_id backfill so pre-multi-tenant archive rows pass the org filter. includeArchive=true now 200 (was 500). NOTE: production_orders_archive is effectively empty — the 1665 purged pre-Apr docs live in `zz_purge_backup_*`, so model "559" is NOT in this archive; awaiting owner on WHERE they saw "559".

### ✅ ③ Org-shared DataGrid layouts · ④ Production-time resync · catalog photo seed · customer-email drain — all shipped + verified earlier this session (see BUG-HISTORY FEATURE-003/004/005, BUG-006/009b).

## 2026-06-23

### ✅ Post-work bug review + fixes (owner: "check for any bugs")
Two adversarial review agents over today's diff. **Money paths CLEAN** (PI posting, supplier discount, ap-control, void — all balanced/idempotent/atomic, drift=0). **UI: no crashes/corruption.** Fixed: (1) voided PV/OR/JV now print with a **VOID** stamp (control hazard); (2) orphaned DRAFT supplier-discount hidden from history (failed-save dead-end); (3) **`BUG-2026-06-23-008`** — editing an APPROVED **foreign** PI's lines corrupted its home amount (pre-existing, currency-blind edit path) → now blocked 409 "cancel & re-raise". Noted-not-fixed (pre-existing/product-call): AP "supplier counter" drift metric is unmaintained (GL-vs-subledger reconciliation is the correct one & is 0); popup-blocked print silent; repo-wide "Loading…" hang on API error; ledger unique-constraint + CREDIT_NOTE marker hardening (task chips).

### ✅ Printable vouchers — PV / OR / JV (→ main, feature)
Owner: "can the Payment Voucher etc. print out?" — they couldn't (no print on PV/OR/JV). Added a **Print** button per row on Expense Payment (PV), Official Receipt (OR), and Journal Voucher (JV) → opens a one-page A4 voucher via the browser-print pattern (`window.open`+`print`, like `printStmt`). Letterhead from `COMPANY.HOOKKA` ("Hookka Industries", per owner). Shared renderer `src/lib/print-voucher.ts` (`printVoucher`/`buildVoucherHtml`, HTML-escaped, pure builder) + pure `src/lib/amount-in-words.ts` (`amountInWords`, Malaysian "Ringgit … And Sen … Only", 9 tests). Layout: letterhead · title · No/Date · party · account lines (PV/OR amount; JV debit/credit + Σ) · total · amount-in-words (PV/OR) · remarks · signatures (Prepared/Approved/Received etc.). **No backend change** — list endpoints already return each doc's lines. tsc + eslint clean; 1168 tests. Subagent-built, reviewed (amount-in-words spot-checked, mappers verified vs edit view).

### ✅ Supplier Discount (purchase-CN upgrade) · #6 (→ main, feature)
Owner #6: "supplier gives me a discount, I need somewhere to input it" — can apply to one / many / no specific unpaid PI. The old standalone purchase-CN form (buried in Creditor Aging, jargon-named) is upgraded into a dedicated **Supplier Discount** tab (sidebar, Debtor/Creditor): select supplier → auto-list unpaid PIs → net+SST+reason → optionally tick/allocate per PI → Save (create→post) → history + Void. Design/plan: `财务模块-供应商折扣-设计.md`/`-实施计划.md`.
- **Task 1** pure `src/lib/discount-alloc.ts computeDiscountAlloc` (validate 0/1/many allocations, ≤ each PI outstanding, Σ ≤ total) + 10 tests (`f10a078f`).
- **Task 2** backend (`6b8b1d54`): PUT post takes `allocations[]` → reduces each PI `paid_amount_sen` + a `supplier_payments` `method=CREDIT_NOTE` marker (no bank/GL leg — the CN's DR400/CR-purchase already moved the GL); new `/:id/void` reverses GL (mirror legs) + allocations + supplier counter. No migration (reuses tables).
- **Task 3** frontend `SupplierDiscountTab` + sidebar + removed old form (`25030277`, subagent-built, reviewed).
- **Task 4** adversarial money-review → **GL/subledger/void all correct, atomic, idempotent, server-validated**. Fixed one real defect: `/ap-control` double-counted an allocated discount (`49fa5228`) — piOutstandingSen now net (amount−paid, incl PARTIAL_PAID), pcnPostedSen nets only the unallocated remainder → drift stays 0 (also fixes pre-existing partial-payment coarseness). Payment-history list excludes the markers.
- **Follow-ups (non-blocking, task chip):** defensive `method<>'CREDIT_NOTE'` on supplier-payment lifecycle queries; filter zero-amount markers from supplier-statement/creditor-ledger displays; confirm prod `purchase_invoices` status CHECK allows PARTIAL_PAID (stale migration file vs prod; existing supplier-payment flow already writes it).
- tsc + eslint clean; 1156/1157 tests.

### ✅ Audit Log — search box + "who" (actor name) · #10 (→ main)
Owner #10. (1) The **By** column now shows the actor's **name**, not a raw user id: `/audit-log` (`accounting.ts`) resolves the distinct `actorUserId`s → `users.displayName` (one `IN (...)` lookup) and returns `actorName` per row. (2) New **search box** on `AuditLogTab` — client-side filter over the ≤1000 loaded rows (reference / party / who / type / state). `AuditRow` gains `actorName?`; dynamic empty-state message. tsc clean, eslint clean, 1136/1137 tests. Read-only, low-risk → main.

### ✅ Sales-invoice "create-as-SENT doesn't post" — VERIFIED NO BUG (no change)
Checked all 4 invoice-create paths: `invoices.ts:1116` (manual from-DO) + `consignment-notes.ts:1213` (CN→invoice) create **DRAFT** (post on the PUT DRAFT→SENT transition); `delivery-orders.ts:908` (auto-on-delivery) + `:2142` (re-issue) create **SENT** and post in the SAME batch via `buildInvoiceLedgerLegs(..., itemsOverride)`. **No path creates SENT without posting** — unlike PI (whose POST accepted `body.status=APPROVED`, set by the import). The memory's "invoice is symmetric" assumption was wrong; corrected. Nothing to fix.

### ✅ PI created-as-APPROVED now posts to GL (bug fix → main) · `BUG-2026-06-23-007`
Root cause: `purchase-invoices.ts` only posted GL legs on a PUT status *transition* to APPROVED; the POST handler never posted. So a PI born APPROVED (bulk import / any create-as-APPROVED) fed Creditor Aging but not the ledger → 400-0000 drifted below aging (prod: 56 APPROVED PIs RM 75,340 in aging, 1 in GL). Fix: new pure `src/lib/pi-posting.ts buildPiApprovalLegs()` (DR buckets · CR 400-0000, balances) + 6 unit tests; POST posts on create-as-APPROVED (idempotent via `ledgerHasSource`, same atomic batch); PUT refactored onto the same helper (byte-identical, no drift). Opening PIs (`/opening-balance/ap`, isOpening) unaffected; history not retroactively posted (→ owner reconciliation). Backend-only; no operational module touched. build:strict clean, 1080/1081 tests, adversarial money-review SAFE (7/7). **NEXT: symmetric sales-invoice (DRAFT→SENT) fix.** Owner acceptance: create APPROVED PI → check Trial Balance / AP control.

### Mega-message backlog (owner, late 2026-06-23) — Production / Dispatch / Worker UX
- ✅ **Apply Completion single-row revert** — owner: "一个个按本来就没事,别动它". Reverted the forceShow change on the per-row completion + Status-cell paths; restored exact prior behaviour; kept ONLY the batch multi-select fix (BUG-2026-06-23-004). tsc 0 → main (741f5fa0).
- ✅ **Customer email — live prod check** — read 199 DOs on prod: **0 have any deliveredEmailAt/dispatchEmailAt** → customer-notify NEVER actually fired (dispatch OR invoice). Validates the backend-choke-point fix (already merged). No outbox GET endpoint exists. Historical 199 NOT auto-resent. Awaiting owner: do ONE real dispatch/invoice (I watch the stamp live) OR use the resend button (building).
- 🔵 **Production Overview — search by Customer PO returns nothing** (dept tabs DO find it) + **overdue chip should CLEAR search/customer/category and show full N** (owner: clicking red should pop the N, not make me clear the search first). Workflow wf_92a58d9f-c75 FAILED on transient API 500s → re-dispatching.
- ⚪ **Pending-Dispatch QR scan popup UI** (scan PL/DO QR → item list, e.g. DO-2606-072): show (1) **Customer PO** in the header, (2) per item **Product SKU = our Product Code** (e.g. 1013-(K)) **+ colour/fabric** (e.g. PC151-01). Example: "PO2605-123 · SO2606-133 · 1013(K) · Fabrics: PC151-01".
- ⚪ **Production Schedule PRINT must use the SAVED layout** — once owner sets columns + "Save as Production Schedule", every "Print Schedule" should print THAT saved column layout (not the current on-screen view); operator shouldn't hand-hide columns each print. ALSO verify "Save as Org Default" / "Reset to Org Default" actually work.
- ⚪ **Barcode (Print Schedule)** — (a) rename the "Scan" column → **"Barcode"**; (b) printed barcodes too THICK/LONG → only 6 items/page (30 items = many pages) AND insensitive/hard to scan ("scan 到半死都 scan 不到"). Redesign: compact + reliably scannable + more per page.
- 🟡 **Production STICKER component-type label (MISSED on first pass — added after owner flagged dropped tasks)** — on the printed per-job-card production stickers (the SO-2605-302-01 cards with QR + Fab Cut/Fab Sew + Qty), the bottom-right should clearly state WHAT PART this sticker is for: **HB / Armrest / Base / Divan / Cushion / Leg** etc. Owner asked "給我設計你會怎麽做" → propose a DESIGN first (mockup), get OK, then build. Component is derivable from the WIP/piece string (reuse the existing piece derivation).
- 🔵 **Catalog photos** — owner CHOSE: collapse same-family variants into ONE base tile (e.g. 1003 covers 1003 / 1003(A) / 1003(A)(HF)(W) + sizes), click tile → see variants, ONE family-level photo applies to all. Dispatched wf_6ed2a0bc-f17 (products/, parallel-safe). Feature → decide main vs staging at merge.
- ❌ **#54 Supplier Pricing merge — DROPPED** — owner: doesn't recognise it / not needed. Removed from scope.
- 🟢 **Announcement** — owner asked how workers see it / does it pop up. Current build = banner on worker phone home screen when they OPEN the app (no web-push). Offered: forced popup-on-open if wanted.

### ✅ JV account picker dropdown un-clipped (bug fix → main)
Owner screenshot: New Journal Entry line **Account** picker cut off after ~3 rows (CAPITAL / RETAINED EARNING / RESERVES). Root cause = `<div className="overflow-x-auto">` wrapping the JV lines table → `overflow-x:auto` forces `overflow-y:auto` → clipped the `absolute` AccountPicker dropdown. Fix = drop the wrapper (`accounting/index.tsx` ~L2493), matching OD/OC (bare table) / PV-OR (`w-80`) / labour (grid). Swept all 9 AccountPicker sites on the page — JV was the last clipped one. `BUG-2026-06-23-006`. tsc clean. → main.
- *Incidental:* paid down one pre-existing lint error blocking the gate on this file — `react-hooks/set-state-in-effect` (eslint-plugin-react-hooks v7) on the debtor/creditor ledger fetch effect (L5219, from today's `52fbe419` merge, which skipped the pre-commit hook). Targeted justified `eslint-disable-next-line` (standard `useCallback` data-load reused by the Refresh button; no behavior change).

## 2026-06-22

### 🔵 Mail Center — Gmail-style redesign with toggles (worktree, feature; do NOT push/merge)
Owner showed Gmail screenshots; asked for ALL of:
1. Compact single-line conversation rows (checkbox · star · unread dot · **Sender** · Subject — snippet … date right; hover row actions; tighter rows; unread distinct). Toggle = density compact/comfortable.
2. Category tabs above list: All / Primary / Notifications. CLIENT-SIDE heuristic over fetched rows (no backend cols). Toggle = show/hide tabs.
3. Reading-pane toggle: split (list + right pane, current) vs full-width list (row opens detail route). Persist in localStorage.
4. Cleaner Gmail-like visual polish; keep left nav functional (Inbox/Starred/Sent/Archive/Drafts/Trash/All + Labels + Departments/Mailboxes).
PLUS a master toggle Gmail-view vs Classic-view OR per-feature toggles ARE the "可以开关" (document choice).
PRESERVE ALL behaviour: reply/forward/star/unread/archive/trash, labels, Assign to, mailbox+dept scoping, unread counts, search, pagination, ~300 conversations. No API-contract change. build:strict must pass; UI 100% English.

### 🔵 F6 T4b — wire FIFO engine into P&L (branch `f6-material-fifo`, only `src/api/routes/accounting.ts`)
- New `loadMaterialCost(db, orgId, startIso, endIso)` → `{rmGroups[], wipOpenSen, wipCloseSen, fgOpenSen, fgCloseSen, warnings}` using the verified engine (`computeMaterialPeriod`/`rollupByGroup`/`valueIssues`).
- RM: opening (material_opening_stock) + GRN receipts (PI-weighted-avg if APPROVED PI else grn_items.unit_price) + cost_ledger RM_ISSUE/ADJUSTMENT, post-cutover, same-date receipts before issues.
- WIP: per-PO Σ FIFO issue cost (ref=PO) + LABOR_POSTED for POs in-progress as-of-D (date reconstruction).
- FG: per completed-not-delivered batch, FIFO unit cost = (PO FIFO material@completion + labor@completion)/original_qty × undelivered-qty-as-of-D (fg_units.delivered_at).
- Swap rmGroups/wip/fg values in computePnlWindow to loadMaterialCost; keep 704-x excluded from GL bands.

---

## 2026-06-21

### ⏸️ AWAITING OWNER — 3 decisions to finish the purchasing batch
- ✅ **① PI import DONE** — Excel reconcile: all 15 Excel POs already present; 19 PIs were missing (PI-2604-019→037, OCEAN SKY, RM 7,258) → imported via a piNo-override on the PI POST (commit `95bfd036`), preserving original numbers + status APPROVED + supplier Inv#/DO# + items. Verified live (19/19 present+APPROVED, line counts + amounts match Excel). Total PIs 592→611.
- **② J cleanup** — delete ~1665 pre-1-Apr docs (PO 555 / GRN 555 / PI 555): (a) docs only, or (b) docs + their stock batches + cost ledger? Destructive → needs a one-time script (option-A lock blocks normal delete). Snapshot first.
- **③ GRN no-draft** — imports-in-transit use the arrival pipeline (Planning→Arrived) instead of Draft; local goods → direct create + post. OK?

### ✅ Effective-dated supplier pricing + Price Change Log + Supplier Quotation PDF (G/H) — shipped main `ba306a41` (effective_from, append-only price_histories, PDF matches Customer Quotation).

### ✅ Purchasing create: no-draft (PO/PI) + supplier reference numbers — shipped main `8374fc6d`
- ✅ **PART 1 — no-Draft on manual create** (owner: manual → active; only OCR → Draft, like SO).
  - **PO create** (`procurement/create.tsx`): button "Save as Draft"→"Create Purchase Order";
    payload sends `status: "CONFIRMED"` (POST takes body.status verbatim, else DRAFT). Split-by-Supplier
    groups also CONFIRMED. Summary hint → "Status will be set to CONFIRMED". PO has no OCR path.
  - **PI create** (`procurement/pi/create.tsx`): manual → `PENDING_APPROVAL` (first non-DRAFT in
    purchase-invoices.ts VALID_TRANSITIONS); OCR/scan (`?scan=1` deep-link OR in-form Scan modal's
    applyOcr) flips `ocrUsed`→DRAFT. Button "Create Invoice" unchanged. Convert-from-GRN/PO prefill =
    PENDING_APPROVAL (operator-initiated, not OCR). Convert chain (line guard + grnItemId increment)
    unaffected — status-independent.
- ✅ **PART 2 — supplier reference numbers** (snake_case + runtime self-apply + migration file + SQLite mirror):
  - `grns.supplier_do_no` (ensureGrnMigrations); `purchase_invoices.supplier_do_no` +
    `purchase_invoices.supplier_invoice_no` (ensurePiMigrations). Migration files
    `migrations-postgres/0183` + `migrations/0105`.
  - FE: "Supplier DO No." on GRN create + GRN detail (inline edit via main PUT); "Supplier Invoice No."
    + "Supplier DO No." on PI create + PI detail (edit-mode, DRAFT-only). Read dual-keyed. Persist
    through create + edit (GRN main PUT + PI PUT both extended).
- tsc clean (only 3 known jsbarcode/@zxing). `npm test` 1010 pass / 0 fail. **NOT pushed** (worktree commit only).

### 🔵 IN FLIGHT — parallel agents (owner: "全部做完，不要紧" + ultracode; review+test+confirm before prod)
- ✅ **Convert-chain backend foundation** — line-level invoice guard (partial/2nd PI ok, blocks over-draw) + per-line `availableQty` + `grn_item_id` link + **OPTION A** (owner: received/POSTED GRN LOCKED from delete+un-post → no stock-reversal hole). 17 tests. Shipped main `97a69de6`; **verified live** (DELETE posted GRN → 409). postGRNToStock untouched.
- ✅ **P2 convert UX** — `convert-from-po-modal` (GRN) + `convert-to-pi-modal` (PI, GRN+PO tabs, carries grnItemId); picks show availableQty + clamp ≤ available; GRN "From PO|Manual" toggle DROPPED (manual default + PO-linked banner). Shipped main `77ed0013`; verified live (availableQty + grn item id exposed). 1010 tests.
- ⚪ **P3 multi-source** — multi-GRN→1 PI is close (per-line grnItemId already supports it; needs picker UI). **多PO→1 GRN needs SCHEMA** (grns.poId single-column → per-line PO source) = high-risk, own branch.
- ⚪ **P4 PI→COGS cascade** — highest-risk cost cascade; own branch + owner buy-in.
- ✅ **Supplier Price History → PO view + filter/sort** — shipped `774ed7ff` (suppliers/detail.tsx).
- ✅ **GRN arrival DO-parity** — Planning rename + forward jumps (FE+BE) + DO tab layout. Shipped `dc6a880a`.
- ✅ **Price Comparison multi-select + cross-material** — multi-select, A-vs-B table, badge legend, filter+sort. Shipped `e695c3c1`.
- **NEXT after backend lands:** P2 convert UX (Convert-from buttons + line-pick pickers, drop GRN Manual toggle), P3 multi-doc consolidation endpoints, P4 PI→COGS cascade.

- 🔵 **PURCHASING CONVERT-CHAIN ALIGNMENT (the big one, owner directive + 2990 ref)** — owner wants
  Hookka's PO→GRN→PI (+PO→PI) to match 2990: create & convert = SAME page; a top-right **"Convert from
  <upstream>"** button (GRN→From PO, PI→From Goods Receipt/PO) that PRE-FILLS; manual = blank default
  (NO "From PO|Manual" toggle); every add/delete line must cascade to INVENTORY. **High-risk (inventory
  cascade) → investigate→propose→confirm + isolated branch.** Study agent `a9320f47` reading 2990 fe+be
  + Hookka gap → will return a plan. This SUPERSEDES the earlier GRN "Manual (no PO)" toggle.
- ✅ **PI/GRN/PO line-picker dropdown clip FIXED** — MaterialPicker dropdown was absolute → clipped by
  the rounded `overflow-hidden` items-table wrapper (owner: "drop down 还没展开完"). Portaled to <body>
  (fixed pos, scroll/resize tracked). tsc+tests, shipped `1dc8e361`.
- ✅ **Supplier Batch Edit** (task #54 follow-up) — upgraded grid Batch Edit to sofa-combos pattern:
  useConfirm + 4 fields (payment terms / company / status / rating). Agent `cc0e3fa3`, cherry-picked, shipped `2cbade89`.
- ✅ **Supplier Quotation PDF** — found ALREADY built (`generate-supplier-quotation-pdf.ts` + button on
  supplier detail, shared letterhead). Parked item was stale; nothing to do.
- ✅ **Purchasing Phase D — lineage SmartButtons** — new `PurchaseLineageBar` on PO/GRN/PI detail
  (PO→GRN→PI clickable, counts, client-side derived, read-only). Agent `c91834df`, cherry-picked, shipped `2cbade89`.
- ✅ **GRN list: arrival chips fixed + explicit From PO entry** — (1) arrival filter chips were
  misaligned (dot used `<Badge variant=status>` which renders the status TEXT in a 6px dot →
  overflow/overlap); swapped for a plain `getStatusColor(state).hex` dot. (2) Header only showed
  "Create GRN" though create.tsx already defaults to PO mode → added explicit **From PO / Manual
  Receipt (`?manual=1`) / Scan GRN**. tsc clean, shipped `5bcbbcd3`, **verified live** (chips clean,
  3 buttons present). Found via owner screenshot; fixed via CODEBASE-MAP (Procurement module).

## 2026-06-20

- ✅ **CoE / Dev-Efficiency System built** — the "big plan" ([DEV-EFFICIENCY-SYSTEM.md](DEV-EFFICIENCY-SYSTEM.md)):
  Layer 4 **Navigation** = [CODEBASE-MAP.md](CODEBASE-MAP.md) (**15 modules = full system
  coverage**, line-range index for ~30 monster files, spot-verified); Layer 5 **Methodology** = [PLAYBOOKS.md](PLAYBOOKS.md)
  (8 procedures); 9 Codex docs tailored; DOCS-INDEX surfaces all. **Still optional:** light docs reorg
  (merge UI-DATA-DOCUMENT-STANDARDS→UI-CONVENTIONS), Data-dictionary/glossary, ERD map, Test-selection matrix.
- ✅ **#3 / GRN read-bug fix** — dual-key read for snake_case cols folded to camelCase by
  `toCamel`. Shipped `cdfcae69`. **VERIFIED LIVE 2026-06-20:** create→read→delete round-trip on
  prod (`PO-2606-006` throwaway) → `materialCode` stored as "VERIFY-CODE-001" and **read back
  correctly** (was "" before the fix), name clean, deleted 200. GRN arrival reads dual-keyed too.
- ✅ **Employees summary stale-on-date FIX** (task #55) — wired all 6 date-bearing tabs
  (handleSummaryDateChange + onDateChange prop on Efficiency/Dept-Labor/Employee-Detail/
  Dept-Performance/Labor-Cost). Done myself via CODEBASE-MAP (read ~250 lines not 10,951).
  tsc clean, shipped `4157cf88`, verified-live (renders clean). **SWEEP DONE (2026-06-21, CLEAN):**
  audited dashboard-b month switcher, reports, daily-report, analytics, ~10 accounting date-tabs,
  planning — all correctly put the date in the URL/deps → react. **Employees was the only real
  instance.** 2 minor non-same-class notes: reports.tsx "Generate" gate (change-date-forget-to-click
  → stale display, intentional UX); accounting AR cards mount-once (no date picker). **Task #55 DONE.**
- ✅ **Supplier Pricing → Supplier merge** (task #54) — cherry-picked `5064505c` onto main
  ([Suppliers | Price Comparison] tabs in maintenance.tsx; supplier detail [Pricing & SKUs |
  Price History]; nav "Suppliers"→maintenance; `/procurement/pricing` redirects). Reviewed diff:
  ComparisonTab was PORTED from pricing.tsx → **deleted the now-dead pricing.tsx** so there's one
  comparison surface (no drift). tsc clean. Shipped `b3b42b6c`. **TODO left: verify-live.**
- ✅ **Dev Operating Framework + Work Tracker** — this doc set + the 快准省 / review-
  discipline answer + durable tracking cadence. Committed.
- ✅ **Codex docs read + efficiency framework adopted** — read all context-packs +
  LLM-CONTEXT-STRATEGY + AI-DEVELOPMENT-MODES; saved smallest-mode discipline to memory.

## Parked — needs owner one-line confirm (from 2026-06-18 queue)

- 🟡 Supplier inline **Batch Edit** in grid (scope ambiguous).
- 🟡 Supplier **quotation export / print** (scope ambiguous).
- 🟡 Purchasing **Phase D** — document-flow lineage / SmartButtons (deferred).

## 2026-07-03 — Opening-month P&L slice (report-layer) + purchases read ledger

- ✅ **Purchases read the LEDGER** (owner: 「照 C 做,采购改读 ledger」) — P&L raw-material
  PURCHASE lines now come from GL per purchase account; stock stays engine-valued, mapped
  onto the same account rows. Shipped `b092a405`.
- ✅ **Route C ABANDONED before execution** (owner: 「我不想要 ledger 留痕迹」) — no re-post
  with April values, no 22/05 slice JV, no 190 bridge account. Replaced by a REPORT-LAYER
  slice: kv `pnl_opening_prior_cum` (30/04 TB P&L balances, {code: signedSen}) +
  `applyOpeningSlice` in `glWindowSigned` and `/cost-expense-classes`. The opening month
  shows `opening − prior-cum`; earlier months read pnl_historical; ledger keeps exactly ONE
  clean opening entry. `src/lib/opening-slice.ts` (+7 tests, suite 1364 green). Shipped
  `b798847c`, deployed, April TB PUT to prod (20 accounts, RM 125,310.83).
- ✅ **Verified live (sen-exact)**: May purchases 115,981.54 = slice 95,297.58 + real
  post-22/05 GL 20,683.96; May FACTORY OVERHEAD +1,560 (780-0030) + OPEX +1,768
  (900-R002/900-T003) = expense slice 3,328; matrix vs /cost-expense-classes agree
  (119,309.54 both paths); TB untouched (701-0010 cumulative 46,481.42 = opening
  23,038.56 + May real 5,223.60 + Jun 18,219.26).
- Owner-visible effect: Monthly P&L May column now shows the 1–21 May slice on top of real
  post-opening trading; sales opening (debtor v5, still awaiting owner confirm) will land
  in May automatically (April sales = 0, not in the kv).

## 2026-07-03 (later) — Periodic-inventory mode + June-purchase reconciliation + incident

- ⚠️ **INCIDENT (disclosed to owner, zero visible impact)**: intended a dry-run of
  POST /purchase-invoices/backfill-gl-postings but the dry switch is `?dry=1` (query),
  not `{dry:true}` (body) → 46 unposted PIs (RM 58,736.70) actually posted. All 46 are
  dated BEFORE the 22/05 opening → floored out of every report (TB/P&L/aging/GL inquiry
  unchanged, verified to the sen). The nightly cron runs the same call nightly — same
  end state. Found the cron itself has FAILED both nights since shipping (suspect 60s
  curl timeout against the 46-PI backlog); backlog now zero so it should self-heal —
  watch one night.
- ✅ **June purchases reconciled** (owner asked "那么少?"): 103 CONFIRMED + 1 PAID June
  PIs = 187,141.01 = P&L purchase lines 184,954.20 + SST 1,616.81 + R&D 570.00
  (PI-2606-010 maps to 900-R002). 2 DRAFTs (2,427.60) unposted by design. The "small"
  number the owner saw was CONSUMED (BOM under-consumption, no May/June stock takes).
- ✅ **Periodic-inventory mode shipped** (`3a4b92b7`, owner: 「不要用 BOM 算先」): kv
  `rm_valuation_mode = stock_take_only` → RM month-end value = latest stock-take +
  PI purchases since (opening seed before any count); consumption only in counted
  months. Toggle card on Stock Take tab; PUT /rm-valuation-mode (audited); GET
  /stock-take returns mode. Pure stockTakeChainValue in material-cost-fifo.ts (+5
  tests; suite 1369 green). **Prod switched to stock_take_only + verified**: June RM
  consumed 8,353.67 → 5,310.56 (= FEE/SERVICE/unmapped lines GL posts to purchase
  accounts but that never become stock — correct immediate-consumption semantics, not
  BOM). May shows 73,692.84 (opening-slice boundary + hand-keyed pre-opening PI
  attribution) — absorbed once the owner enters the 31/05 count. Until counts exist,
  June COGS is ~0/negative and GP ≈ sales — expected shape, meaningful after counts.
- ✅ **v2 (owner: 「不要我还没 import 就用 BOM 的方式」, `590fbaad`)**: stock_take_only P&L
  chain moved to ACCOUNT level off the GL — month-end value = latest import (complete
  statement; absent groups = 0) + GL purchases since (opening seed before any import).
  Un-imported months show consumed = 0 BY CONSTRUCTION (May 73,692.84 / June 5,310.56
  residuals → 0.00, verified live; chain continuity 107,268.13 → 223,249.67 → 408,203.87).
  Import month absorbs true consumption. glWindowSigned gained a per-request memo
  (DocDateCtx.glMemo). Group-level PI chain still serves Stock Summary + closing-stock GL
  posting. Until imports exist COGS is FG/WIP/labour only (GP > sales) — owner-accepted
  interim shape.

## 2026-07-12 (morning) — Agent 再进化 (owner ask)
- [x] 答概念问题：是否全部基于 LLM / 是否都会自我进化+懂数据 (诚实盘点)
- [x] Console 补齐全部 blueprint Agent ID (10 个卡片, 未建=COMING SOON)
- [x] 共用 LLM 大脑抽层 (agent-brain.ts, production-brief 重构复用)
- [x] Delivery 进化: LLM focus + console pause/run-now 接线 + 学习环→跨 Agent 调参提案 (实际州运输天数 → cs-agent transitDays)
- [x] CS 进化: promise log 表 + 承诺达成率 KPI 基础
- [ ] gates → merge main → deploy → prod 验证 → 文档/memory

- [x] 自主排班心跳 (owner 裁定: 节奏 Agent 自己定) — agent-scheduler.ts + heartbeat 30min + 理由留痕

## 2026-07-28 (session: opening re-post + GL totals + supplier-payment advance)
- [x] Opening 页预览补 405/305（BUG-003 前端半截）→ owner 重按开账成功，405=1,200 达标
- [x] CLM 1,150 + NLY PI-2605-008 3,432 放行进开账（owner 逐笔拍板）
- [x] BUG-2026-07-24-001：edit 腿 sourceId 尾巴逃开账地板（+407.04）→ stripSourceIdSuffix 根治，AP recon 首次全零
- [x] GL：一键返顶 + By-Account 顶部总计条 + 单科目 DR/CR 总额
- [x] Debtor/Creditor Ledger：每家 TOTAL 行 + 顶/底总计卡 + 打印同步
- [x] PV-2607-001 编辑报错调查：restate 加 VOID 守卫 + 技术报错持久化(kv+debug端点)；顺手修 BUG-2026-07-24-002（unvoid 复活旧分录）
- [x] 「double 开 PV」检查：无系统复制，全是作废+重录对子 → 根因=预付款不可编辑
- [x] 预付款可编辑（owner 拍板）：Edit=批量 knock-off 工作台，Advance 自动缩减，restate 接受 advanceSen

## 2026-07-31 (session: purchasing follow-ups ①② + mechanism sub-BOM ③ + FILLER inches)
- [x] ① Supplier phone/email standardization — supplier-form-dialog: PhoneInput (+60/intl) + isValidEmail gate (mirrors customer/lead forms) — PR #141
- [x] ② Purchase Return convert-from-GRN (not just PI) — loadGrnItemsForReturn, GET /source/grn/:id, POST branches PI|GRN, GRN-detail "Create Purchase Return" btn, dialog grnMode; DN step gated OFF for GRN returns (not invoiced → no AP) — PR #141
- [x] FILLER sponge sheet default = **96 × 48 INCHES**; every cut/sheet/category-default input labelled inches (owner confirmed "48×96 inches, 全部 usage 用 inches") — PR #140
## 2026-07-31 (session: mechanism→screw reusable sub-BOM, owner 乙)
- [x] ③ Mechanism→screw binding — owner chose **乙 (reusable sub-BOM / multi-level BOM)** over 甲 (lightweight per-BOM binding). "更正统 ERP,但重".
  - `component_bom_lines` table (parent SKU → child SKU + qty_per + waste_pct), runtime self-applied (component-bom.ts).
  - `explodeKits()` runs INSIDE `resolveBomMaterials` on the FINAL resolved lines (after autoDetect), so a mechanism bound via LEG also pulls its screws. Parent line kept (mechanism still consumes on its own); children appended with qty = parentQty × qtyPer, inheriting the parent's repair-scope tags; self/loop-guarded, one level deep.
  - API `/api/component-boms` (GET / GET:code / PUT / DELETE), RBAC `bom`.
  - Maintenance page **Component Kits** at `/bom/component-kits` (MaterialPicker for parent + children; sidebar under BOM).
  - BOM editor shows a read-only `+ kit` hint on any material line whose SKU has a kit (module-level KIT_PARENT_CODES, loaded from /api/component-boms).
  - Tests: `component-kit-subbom.test.mjs` — functional (saveKit self-guard, explodeKits qty math / parent-kept / no-op) + structural wiring. Full suite 1691 pass; build:strict clean.
  - branch `feat/mechanism-subbom` off staging.
## 2026-07-29 owner rulings — do NOT re-raise
- [x] Forecast P&L 全套上线（%/RM 双填、按类型归并、父子折叠+段合计、空行自动藏、千位逗号、% 两位小数、表头 Aug 2026 + AMOUNT/% SALES 图例、SALES 行 100%）
- [x] BUG-2026-07-29-001 partial payment 约束名破案并修复
- [x] Edit Payment「不预填」实测无 bug（PV-2607-012 25 行全预填）— 结案
- [ ] ⛔ 完工重复记 318 件 / DO 出货短记 63 件 → **owner: 会有别人处理**，不要动
- [ ] ⛔ 收货流水断线（RM_RECEIPT 4月起为 0）→ **owner: 到时才提供开货量，时间未定**；他每月自行 import closing stock（stock_take_only 口径成立），不要修管道
- [ ] ⛔ 客户期初 60,000 / 20 笔供应商预付款对销 → **owner: 到时我会解决**

## 2026-07-31 (session: BOM per-material wastage %, owner "跟行业标准")
- [x] BOM material lines now carry an optional **% waste** (industry-standard scrap factor). Added `wastePct?` to WIPMaterial + a waste input at all 6 material-row editor contexts (updateWIPMaterial / onUpdateMaterial / updateL1Material / updateMaterialAtPath). Engine already applied `× (1 + waste%/100)`; backend stores wipComponents JSON as-is so it persists end-to-end. Guidance in tooltip: cut/bulk (fabric/foam/wood) carry waste, discrete parts (screws/legs/mechanism) stay 0. Tests: bom-wastage.test.mjs. → branch feat/bom-wastage off staging.

## 2026-08-01 (session: owner bug report — Component Kits + Foam relabel completion)
- [x] **Component Kits saved but never appeared** (owner screenshot: toast "Kit saved — SL 13.5(E) → 1 component(s)", list still "No component kits yet").
  ROOT CAUSE = the repo's camelCase read-bug class. `db-pg.ts` installs `transform.column.from` on the postgres.js client, so `SELECT *` on the runtime-created `component_bom_lines` returns **camelCase** keys (parentCode / childCode / qtyPer / wastePct), but `component-bom.ts` read snake_case only → `r.parent_code` was always `undefined`.
  - `listKits()` skipped EVERY row → empty list (the visible symptom).
  - `explodeKits()` built an empty kit map → **the screws never reached consumption / costing at all**. Silent money-path hole, worse than the reported symptom.
  Fixed by reading DUAL-KEYED (`str()` / `dualNum()` helpers) in both functions.
- [x] Component Kits page no longer swallows a failed list read — `if (!kRes.success) throw` instead of falling through to the "no kits yet" empty state (that silence is exactly why the bug looked like "it only saves one").
- [x] Regression tests: `component-kit-subbom.test.mjs` gained a camelCase-returning D1 stub (the old stub fed snake_case, which is why the suite was green while prod was broken) covering both listKits and explodeKits.
- [x] **Foam relabel finished across the system.** The 2026-07-30 rollout updated some label maps and missed others. Owner-visible symptom: the BOM process-dept `<select>` rendered a BLANK option (FOAM_CUTTING was in DEPT_ORDER but absent from DEPT_LABELS) and still showed "Foam" instead of "Foam Bonding".
  - `bom.tsx`: added FOAM_CUTTING to DEPT_LABELS + DEPT_COLORS; FOAM → "Foam Bonding"; 3 master-template seed rows `dept: "Foam"` → "Foam Bonding".
  - FOAM → "Foam Bonding" in: `production/utils.ts`, `production/tracker.tsx`, `service-cases/detail.tsx`, `m/config/forms.ts`, `m/screens/ProductionScreen.tsx`, `m/screens/ProductionDetailScreen.tsx`, `lib/repair-scope.ts`, `planning/index.tsx` (shortName), `lib/mock-data.ts` (shortName).
  - FOAM_CUTTING was missing ENTIRELY from 5 dept lists (tracker, both mobile production screens, service-cases depts, mobile working-hours dept picker) — added, ordered immediately before FOAM to match `production/utils.ts`.
  - `wip-times.tsx`: kept legacy label aliases ("foam" / "foam cut") in DEPT_CODE_BY_LABEL so spreadsheets exported before the relabel still import.
  - `repair-scope.test.mjs` badge expectation updated to "Custom: Foam Bonding + Packing".
  - New regression tests in `foam-cutting-department.test.mjs`: DEPT_LABELS must cover every DEPT_ORDER code (blank-option guard) + no label map may still spell FOAM as bare "Foam".
- [x] BOM toolbar (owner): removed **Production Categories Editor** + **Production Times** buttons (the dedicated WIP Times module supersedes both); added a **Component Kits** button in their place. The Production Times LOOKUP is untouched — BOM rows still auto-fill minutes from that matrix. Sidebar entry kept.
- [x] Answered: foam usage = qty is the PIECE COUNT; required = qty x poQty x (1+waste%), then **only if cut L x W AND the RM sheet size are both present** it becomes x (cutArea / sheetArea). Blank cut size => qty 1 consumes ONE WHOLE SHEET, not one cut piece.
- [x] Sales Pipeline stage relabel (owner: "New / Won / Lost 这些名词要换掉") — owner chose Potential / Confirmed / Dropped; shipped in the session below (PR #153).

## 2026-08-01 (session: Sales Pipeline stage relabel — owner "New / Won / Lost 这些名词要换掉")
- [x] Stage LABELS renamed to match the Customer module's vocabulary (a lead enters as
  Potential and becomes a Confirmed customer): New→**Potential**, Won→**Confirmed**,
  Lost→**Dropped**. Contacted / Quoted / Negotiating unchanged.
- [x] Stored `key` values (NEW / WON / LOST) are UNTOUCHED, as is `LEAD_STAGES` in
  `api/routes/sales-leads.ts` — display-only change, no migration, existing rows unaffected.
- [x] `STAGES` in `src/pages/leads/index.tsx:35` is the single label source (kanban columns,
  card stage picker, drawer badge, move menu all read it). Two hardcoded strings outside it
  also fixed: the "Won" summary header → "Confirmed", and the card's "Lost: <reason>" →
  "Dropped: <reason>". The stage-change prompt now reads "Why is this lead being dropped?".
- [x] Regression test in `sales-leads.test.mjs`: asserts the exact key→label pairs AND that
  no stale label ("New" / "Won" / "Lost") survives on the page. Guards both halves — a future
  edit that renames a KEY instead of a label would orphan every sales_leads.stage row.
- [ ] NOT renamed: the "+ New Lead" create button. That is the create action, not the stage —
  say the word if it should read "New Potential" / "Add Lead" instead.

## 2026-08-01 (session: close out the open items — owner "把还没做的都做完")
- [x] **Component Kits multi-create** — the kit editor can now bind ONE component list to
  several parent SKUs in a single save ("Also apply to these SKUs", create-mode only;
  editing still targets one kit). A mechanism usually comes in several sizes / handings
  that take the identical screw set, and re-entering the list per SKU was the actual chore.
  Targets are de-duplicated; the Save button states how many kits the click will write.
  Writes are SEQUENTIAL with a per-parent catch so a partial failure reports
  "3 of 4 saved, X failed" and keeps the editor open — a rejected `Promise.all` would have
  hidden which parents landed. Self-reference (a parent listed in its own components) is
  caught up front, because the backend rejects per parent and one bad pick would otherwise
  half-apply the save.
- [x] **`+ New Lead` → `+ New Potential`** (dialog: "New potential customer", submit:
  "Add potential"). Adding a card now also mints a POTENTIAL customer, so the old label
  matched neither the first pipeline column nor the Customer module.
- [ ] ⛔ **`customer_wishlist` table NOT dropped.** The feature is retired (UI + routes gone)
  but the rows are kept. Dropping data is irreversible and the owner asked to remove a
  feature, not to wipe records — needs an explicit instruction before anyone touches it.
- [ ] Owner data check (not a code task): the BOM line `NLY-D30-1.5"` has BLANK cut L×W, so
  qty 1 consumes ONE WHOLE SHEET rather than one cut piece. Worth auditing how many filler
  lines are in that state.

## 2026-08-01 (session: System Health — MISDIAGNOSED, corrected below)
- [x] **CORRECTION.** I reported that System Health was "monitoring nothing" and shipped a
  `CF_ACCOUNT_ID` into `wrangler.toml [vars]`. **Both were wrong.**
  - PRODUCTION (`erp.hookka.com`) health has been **LIVE all along**: `kpis-diag` returns
    `CF_ACCOUNT_ID_set:true`, and the live AE probes return 200 with real data (smoke = 25,526
    rows; spark = real hourly counts 416 / 118 / 1144 / 762 …).
  - What I actually tested was **staging**, which is a Pages *preview* environment. Pages keeps
    production and preview env vars SEPARATE, and only preview is missing `CF_ACCOUNT_ID`.
    The mock banner is correct behaviour for preview, not a production defect.
  - Worse, the value I added was the account from `wrangler whoami` on this machine
    (`816e4573…`, hello@houzscentury.com) — a DIFFERENT Cloudflare account from the one
    production actually uses (`27cd35…`). Even had it been needed, it was the wrong value.
  - The deploy then failed outright: `Binding name 'CF_ACCOUNT_ID' already in use` — Pages
    already had it, which was the clue that production was fine.
  - Lesson for next time: `/admin/health` shows mock data on ANY preview deploy. Diagnose
    environment-scoped config against the environment you actually mean to fix, and treat
    "the dashboard says mock" on staging as expected, not as an incident.
- [ ] Remaining, genuinely open: staging's preview env has no `CF_ACCOUNT_ID`, so health on
  staging stays mocked. Decide whether that's worth fixing (it needs the PROD account id set
  on the Pages *preview* environment) or whether health is a production-only concern.
- [ ] Still to do (unchanged by the correction): measure /admin/health page load on prod, then
  the module-by-module devtools sweep for slow fetches / console errors.

### [SUPERSEDED — see the correction above] 2026-08-01 first pass
- [x] **Diagnosed: the whole /admin/health dashboard was deterministic mock data.** The page
  banner said so ("No live data yet…") but the headline card still read "All systems normal ·
  P50 41ms · P95 241ms · No 5xx" — i.e. it looked green while measuring nothing. Every question
  of the form "which page crashed / lagged / failed" had no answer because nothing was recorded
  on the READ side.
- [x] Root cause via `GET /api/admin/health/kpis-diag`: `ERP_METRICS_bound:true`,
  `AE_QUERY_TOKEN_set:true`, **`CF_ACCOUNT_ID_set:false`**. The AE SQL endpoint is
  `…/accounts/{CF_ACCOUNT_ID}/analytics_engine/sql`, so without the id the fetch cannot be
  addressed and the route falls back to `_mock:true`. ONE missing variable. Write side has been
  healthy since P6.2, so **historical data already exists** and appears the moment this lands.
- [x] Fixed by adding `CF_ACCOUNT_ID` to `wrangler.toml [vars]` (value read from
  `npx wrangler whoami`; an account id is not a credential — this file already carries KV
  namespace ids, the D1 id and the Sentry DSN). `AE_QUERY_TOKEN` stays a Pages secret.
  `wrangler pages secret put` was tried first and is refused under an OAuth login (API 10000),
  which is also why this must not depend on a manual dashboard step.
- [ ] AFTER DEPLOY: re-check `kpis-diag` shows `CF_ACCOUNT_ID_set:true`, then confirm
  /admin/health drops the mock banner and shows real numbers. Then measure page load — the
  dashboard fans out to many AE SQL calls and may need caching.
- [ ] Then sweep module-by-module (devtools) for slow fetches / console errors, now that there
  is real telemetry to cross-check against.
## 2026-08-01 (session: OCR re-upload hint + OCR observability asks)

Owner asks logged verbatim before work (multi-part message, CLAUDE.md rule):
1. 「OCR upload 的是之前就 upload 过了的会怎么样？」→ 调查
2. 「cached 只提醒不 block，只要有 OCR 的功能都这样，frontend 提示而已」→ 实作
3. 「OCR scan 了很久，OCR dashboard 东西全部没看到了」→ 调查
4. 「要有平均 scan 一张 PO/PI/GR 等等文件的时间」→ 未建
5. 「每个种类的 accurate rate 是多少 %？by customer、by category (sofa/bedframe)，PI/SO/GR」→ 部分已有，未分单据类型
6. 「第二张 PO 明明 scan 到 customer + hub，create as draft 就没有了」→ 定位到根因
7. 「明明还在 loading 很多突然全部跑出来」→ 队列轮询行为，见 4
8. 「Draft(2) 但列表 by default 是空的」→ 定位到根因（旧 bug class 复发）

- [x] **(2) Cached-scan 提示上线（纯 UI，绝不 block）** — `src/components/scan-cached-hint.tsx`
  新增 `ReusedScanBadge` +「Already scanned · reused」/ `CachedScanNotice`「N of M files had
  been uploaded before」。接进**全部三个 OCR wizard**：scan-po-modal（Customer PO→SO）、
  scan-supplier-modal 的 CreatePIWizard + CreateGRNWizard，收合态与展开态都有徽章。
  后端本来就回传 `items[].cached` + `summary.cached`，前端从来没渲染 → 只补前端。
  build:strict clean。branch `feat/scan-cached-reused-hint` off staging.
  文案同时点出两件不明显的事：replay 是**原始 OCR**（上次手改的 correctedJson 不会回写
  scan_queue.raw_json）、cache hit 跳过 prompt 所以新学的 ocrPromptRules 不生效。

- [ ] **(3) OCR Accuracy dashboard 永远空 — 根因已定位，未修**
  `GET /api/ocr-accuracy` 只算 `correctedJson IS NOT NULL` 的样本。自 2026-06-30 队列流程
  成为默认后，两条路都不再回写 correctedJson：
  · **SO 路**：scan-po-modal 给队列卡片编造 `sampleId = \`queue-${rowId}-${docIdx}\``
    (scan-po-modal.tsx:1308)，create 时 POST 到 `/api/scan-po/samples/<假id>/confirm`
    (:921) → UPDATE 命中 0 行，correctedJson 永远 NULL。
  · **供应商路**：队列卡片 `sampleId = null` (scan-supplier-modal.tsx:1816 注释自陈
    "Gold/correction confirm skipped in that case") → confirm 整个跳过。
  队列 worker 其实**有**写真样本（scan-queue.ts:560 `recordSample: true`，
  scan-engine.ts:997 / :1199 生成 id），但那个 id 从没回传给前端。
  修法：把 engine 生成的 sampleId 存进 scan_queue 一列并随 batch 回传，前端改用真 id。
  （附带：dashboard 卡片按 Command Center 的 period 走，选到 2026-08 时今天才 8/1，
  即使修好也几乎没样本 — 先看 All-time。）

- [ ] **(6) Claude 路 delivery hub 解析不出来 → SO 建成没有 hub**
  `resolvedHubId = po.deliveryHubId || mapDeliveryHub(po.customerName, po.customerState).hubId`
  (scan-po-modal.tsx:944-945)。`mapDeliveryHub` (src/lib/po-parser.ts:564) 是**硬编码表**：
  要求 `customerName === "Houzs Century"` 完全相等、且第二参数是 `"KL"/"PG"/"SRW"/"SBH"`。
  实际传进去的是 `po.customerState = "Selangor"`，而 customerName 是 OCR 读到的
  "Houzs Century Sdn Bhd" → 两个条件都不成立 → hubId = ""。
  **OCR 其实读到了 hub**（`po.deliveryHub` = "Houzs KL"/"Houzs PG"，就是卡片上那颗灰徽章），
  但 Claude 路的 hub 解析**从不看这个字段**（只有 legacy 路 :1137 才传 po.deliveryHub）。
  另外硬编码的 `hub-h1..h4` 是否还等于 delivery_hubs 真实 id 也要核。
  → 应改成拿 `po.deliveryHub` 去 `catalog.customers[].hubs[].shortName` 匹配拿真 id。

- [ ] **(8) Sales Orders「Draft (2)」但表格 0 of 2 records · 1 filter active**
  `valueFilterKey={filterStatus || "all"}` (sales/index.tsx:1415) **没有把 `tab` 算进去**，
  而 tab 是独立的 url state (:311)。data-grid 的持久化 key 是
  `datagrid-filters-<gridId>-<valueFilterKey>-<user>` (data-grid.tsx:2080) → DRAFT 与
  CONFIRMED 两个 tab 共用同一个 key。种子逻辑 (:2154) 只把**当前 data 里出现过的** status
  值勾选进来；在 CONFIRMED tab 种下的集合里没有 "DRAFT"，切到 DRAFT tab 沿用该集合 →
  两张 draft 全被过滤掉。
  ⚠️ **这是 BUG 2026-05-16 的同类复发**（:1409-1414 注释就是上次的修复说明，当时只补了
  filterStatus 没补 tab）→ 依 BUG-CLASSES 纪律，修的时候要把这一类的每个实例都扫一遍。

- [ ] **(4)(7) 缺 OCR 耗时可观测性** — scan_queue 已有 created_at / completed_at，够算
  每份文件的实际耗时，但没有任何地方聚合或展示。owner 要：按单据类型（PO/PI/GR）的平均
  scan 时间。待定：放 OCR Accuracy 卡旁边还是独立卡。
- [ ] **(5) accuracy 未按单据类型拆** — 现有 API 只有两大类：Sales Orders（已细分
  by customer × category SOFA/BEDFRAME/ACCESSORY，逻辑在 ocr-accuracy-core.ts）和
  Supplier（只 by supplier）。owner 要 **PI / GR 分开**，但两者共用 supplier_scan_samples
  且没有区分列 —— 需要先决定怎么标记来源（docType？还是建单时回写）。

### 2026-08-01 全 OCR 面「显示值 vs state」审计（owner: 「确认看全部OCR功能 这个很重要」）

范围 = 全部 4 个 OCR 面。方法：列出每个受控输入的 `value={...}` 绑定，逐个判定它读的是
state 还是渲染期派生值；再确认建单 payload 读的是同一批 state。

| OCR 面 | 入口 | picker 绑定 | 建单读取 | 结论 |
|---|---|---|---|---|
| Customer PO → SO/CO | ScanPOModal（sales + consignment 两页共用） | **customer picker = `matchId`（派生）**，其余 20 个全 `po.*`/`item.*` | create 自己再算一次宽松匹配 | ❌ **唯一病灶** |
| Purchase Invoice | ScanSupplierModal · CreatePIWizard | 17 个绑定全 `card.*`/`line.*` | `supplierById(card.supplierId)` (:1560) | ✅ 一致 |
| GRN | ScanSupplierModal · CreateGRNWizard | 16 个绑定全 `card.*`/`line.*` | `supplierById(card.supplierId)` (:3736) | ✅ 一致 |
| Finance bill / voucher | accounting/index.tsx `applyScan` | `scanNameMatch` → **立刻 `setForm({partyId})`** | 读 form state | ✅ 一致（且未匹配时弹「建档」对话框，UX 最好） |
| legacy POCard（模板路，非 AI） | scan-po-modal:2599 | 只有一个 checkbox，无 picker | — | ✅ 不涉及 |

**结论：这个 bug class 全库只有 1 个实例** — scan-po-modal.tsx:2112 `value={matchId ?? ""}`。
`matchId` 在 :2094 算出来后从不 `onUpdate`，所以 `po.customerId` 保持 null。
唯一的下游受害者是 hub picker (:2180) —— 它是全库唯一直接读原始 `po.customerId` 的地方，
读到 null → `hubs=[]` → picker 不渲染 → 退化成纯文字 Badge → `deliveryHubId` 永远 null。
（客户本身没事：create 路 :1041 有自己的宽松再解析兜底，所以 SO 上客户是对的。）

**顺带发现：全库有 4 套各自为政的公司名匹配器**（这才是 ADD WOOD / Houzs 的共同病根）
1. `matchByCompanyName`（lib/company-name-match.ts）— 剥 SDN BHD/BERHAD/BHD/PLT，正规化全等，
   歧义→null。用于 scan-po 后端 + customer picker。**唯一处理法定后缀的一套。**
2. `pickSupplierFromName`（scan-supplier-modal.tsx:203）— **不剥后缀**，exact→正规化全等→
   前后缀包含三级，歧义→null。用于 PI/GRN。
3. `scanNameMatch`（accounting/index.tsx:5912）— 不剥后缀，双向 substring，`.find()`
   **首个命中即返回、无歧义保护**（最松，有静默选错家的风险）。用于财务单。
4. scan-supplier.ts:180 的 SQL `regexp_replace(...) LIKE ... || '%'` — Postgres 前缀匹配。
   用于 gold→distill 的供应商反查。

- [ ] **修法（最小面）**：scan-po-modal 只需 (a) `matchId` 算出后写回 state，
  (b) hub picker 改读同一个 id 并用 `po.deliveryHub` 文本比 `hubs[].shortName` 预选。
  **不碰任何抽取逻辑** — 提取准确度由 scan-engine 的 prompt 决定，与 picker 匹配无关。
- [ ] **修法（根治）**：4 套匹配器统一到 `matchByCompanyName` + 新增 `party_name_aliases`
  表（原始 OCR 名 → partyId），操作员手改一次即永久记住。见本文件 learning-loop 段。

### 2026-08-01 staging 实测 QA（owner: 「你可以chromemcp去看啊 做qa啊 不要什么都要我检查」）

在 staging（prod 每晚克隆）用登录态实测，非推论。测试数据已全部清理，无残留。

**① ADD WOOD 匹配不到 — 根因是主档拼错，不是匹配器口径**
供应商档案存的是 **`ADD WOORD TRADING SDN. BHD.`（code 400-A002）**— 比发票上的
`ADD WOOD TRADING SDN BHD` 多一个 R。实测三套算法对同一输入的结果：

| 算法 | 结果 |
|---|---|
| `pickSupplierFromName`（供应商现行） | exact 0 / normEq 0 / containing 0 → **null** |
| `matchByCompanyName`（本来打算统一过去的那套） | **0 → null** |
| 编辑距离排序 | **第 1 名 ADD WOORD… 距离 1；第 2 名距离 8** |

⚠️ **推翻先前建议**：把供应商侧统一到 `matchByCompanyName`「顺带解决 ADD WOOD」是**错的**，
两套都归零。主档一个字母的拼写差异只有**模糊排序**能跨过去，而这个案子第一名与第二名
差 8 倍，预选零风险 —— 印证 owner「找最像的就好」的判断。
→ 结论：候选排序不是 UX 优化，是这一类（主档拼错 / OCR 误读 / 缩写）的**唯一解**。
   alias 表负责「改一次永久记住」，模糊排序负责「第一次就猜中」，两者都要。

**② SO draft 删不掉 — 后端完全正常，是前端没有入口**
- `DELETE /api/sales-orders/<不存在的id>` → **404**（不是 403）⇒ Super Admin 有 delete 权限、
  路由正常。
- 实建一张 DRAFT 再删 → **200 `{"success":true}`**。纯 draft 无子记录，外键不挡。
- 真正原因：**列表页没有任何删除入口**。行右键菜单 = View / Edit / Print / Transfer to DO /
  Transfer to Invoice / 状态log / Refresh（sales/index.tsx:798-878，无 Delete）；
  Draft 分页工具栏只有 Convert to Confirmed + Re-assign company。
  唯一能删的地方是**进单据详情页右上角 Delete**。
- [ ] TODO：Draft 行菜单加 Delete（仅 DRAFT 显示）+ 选中后批量删除；后端 DELETE 端点
  同时补状态守卫（现在 CONFIRMED 只要没子记录也照删，比删不掉危险）。

**③ 编号回收 — 实测证实**
建 `SO-2608-001` → 删掉 → 再建 → **又拿到 `SO-2608-001`**。
证实 `generateCompanySOId` 的 MAX+1 语义：删当月最大号会被重新发放；删中间号则永久空洞。
（对照：财务单走 `doc_no_counters` 原子计数器，只增不回收 —— 两套语义不一致。）

### 2026-08-01 供应商改名的影响 — staging 前后对照实测

Owner 在 prod 把 `400-A002` 从 `ADD WOORD TRADING SDN. BHD.` 改成 `ADD WOOD TRADING SDN. BHD.`，
问「旧单会不会全部跟着变」。在 staging 做同一次改名，改名前後各读一次：

| | 改名前 | 改名后 |
|---|---|---|
| suppliers 主档 | ADD **WOORD** … | ADD **WOOD** … ✅ |
| 24 张 PI 的 `supplierName` | ADD **WOORD** … | ADD **WOORD** … （不变）|
| 13 张 PO 的 `supplierName` | ADD **WOORD** … | ADD **WOORD** … （不变）|

**结论：旧单据保留建单当下的名字快照，不会回溯。** 存快照的表：`purchase_orders` /
`grns` / `purchase_invoices` / `supplier_payments` / `purchase_credit_notes` /
`ap_aging` / `three_way_matches` / `goods_in_transit`，读取端不 JOIN suppliers。
✅ **不会把一家拆成两家**：AP 账龄/对账按 `supplierId` 分组（accounting.ts:526/2455），
不按名字，所以金额与归属不受影响；只有旧单据上显示的字样还是旧拼写。

**副作用（好的）**：改名后 `pickSupplierFromName` 实测 normEq=1 → 直接命中
`ADD WOOD TRADING SDN. BHD.`。即这一家**靠修主档就已经解决**，不需要等模糊匹配上线。
但这是「把资料改成配合演算法」，不是系统学会了 —— 见下。

- [ ] ⚠️ **仍未解决（owner 反复强调）**：手动改正供应商/客户之后，系统学不到。
  三层都断：confirm 只写 `correctedJson`+`isGold`（不回写改正后的 supplierId）→
  queue 流程连 confirm 都没调（假 sampleId）→ distill 取样要 `correctedJson IS NOT NULL`
  所以池子恒空。且 distill 本质是「已知是哪家之後学它的单据长相」，天生学不了身份。
  → 下一个 PR：真 sampleId 回传 + confirm 回写 partyId + `party_name_aliases` 表
    （OCR 原始名 → partyId，改一次即时生效，不等周日 cron）+ 模糊候选排序预选第一名。

### 2026-08-01 staging 部署后验证（PR #166 已合入 staging）

全部在 staging 用真实资料实测，不是推论。

**① 改名传播 / backfill — 通过**
- 单家 `{supplierId: sup-20d0fa1f}`：50 列（purchase_invoices 24 + purchase_orders 13
  + supplier_payments 13），重跑 = 0（幂等成立）。
- 读取端复验：24 张 PI + 13 张 PO 全部变 `ADD WOOD TRADING SDN. BHD.`，WOORD 残留 = 0。
  ⚠️ 第一次复验读到旧值是**快取**（详情端点当下已是新值）；带 cache-buster 重读即一致。
- 全量供应商 backfill 另外修正 **34 列 purchase_orders** —— 即 ADD WOOD 以外还有别家
  历史改名留下的漂移，一并对齐。
- 全量客户 backfill：0 列（staging 无待修漂移），7 张无 id 表如预期回报 notBackfillable。
- ⚠️ 副作用：部分 PO 原本存的是 `400-A002 - ADD WOORD TRADING SDN. BHD.`（含代码前缀），
  backfill 后统一成主档名字，前缀被抹掉。属于把不一致资料正规化，但要知道有这回事。

**② hub 修复 — 用真实 catalog 验证通过**
Houzs Century 在 catalog 里有 4 个 hub（KL/PG/SRW/SBH）。喂入你那 9 张单的实况
（customerId=null、name="Houzs Century Sdn Bhd"、state="Selangor"、OCR hub="Houzs KL"）：
`customerId → cust-1`、`hubs.length = 4`（下拉会渲染）、`hubId → hub-h1`（已预选）。
修复前这三个分别是 null / 0 / null。
顺带证实硬编码表的 `hub-h1..h4` **确实是真 id**，它失败纯粹因为比对条件错
（要求名字完全相等，且传的是 customerState 而非文件上的 hub 名）。

### 2026-08-01 (晚) — 全批次 staging 验证结果

四个 PR（#173 学习循环 / #175 SO draft 删除+编号 / #176 accuracy sampleId / #179 耗时修正）
全部合入 staging 并实测。

**① 学习循环 — 通过**
- `party_name_aliases` runtime 建表成功；`GET /api/party-aliases?type=SUPPLIER` 200。
- 教一次 `ADD WOOD TRADING SDN BHD → sup-20d0fa1f`：`recorded:true`，key `ADDWOODTRADING`。
- 三种写法变体（`SDN. BHD.` / `add-wood-trading-sdn-bhd` / 多空格）**全部命中同一个 key**
  —— 印证 normalizeCompanyName 的连字号修正是必要的。
- 重教成别家 → **覆盖**（keys 仍为 1，不累积矛盾列）；DELETE → 清空。语义符合设计。

**② 扫描耗时 — 修正后数字才可信**
初版量「入队 → 完成」，实测 Customer PO 平均 **22 分钟**、供应商 **24 小时**、p90 **3.9 天**。
改量 `started_at → completed_at` 后：

| 类型 | 平均 | p90 | 笔数 |
|---|---|---|---|
| Customer PO | **11.7s** | 14.9s | 144 |
| 供应商单据 | **8.8s** | 15.4s | 53 |

⇒ **单张扫描本身是健康的（~10 秒）**。owner 反映的「scan 了很久」是**排队等待**，
不是扫描成本 —— 一次传 9 个档 + PDF 自动切分出更多子档，全部排队等 worker。
- [ ] 待议：要不要在卡片上同时显示「实际等待（入队→完成）」当第二栏，因为那才对应
  操作员的体感；目前只显示处理成本。

**③ 两个只有实跑才会暴露的 bug（单元测试全绿）**
- 量错区间（见上）—— 测试无法判断「哪个时间戳才有意义」。
- **静默空**：`sample_id` 栏位挂在 scan-queue 路由的 lazy ensure 上，accuracy 端点在新
  isolate 上 JOIN 失败 → 被 catch 吞掉 → 回传空阵列，**看起来跟「还没有资料」一模一样**。
  直到我碰巧打了 `/api/scan-queue/pending` 才有数字。已改成端点自己 ensure。
  ⚠️ 教训：`catch → return []` 会把「坏掉」伪装成「没资料」。

**④ accuracy dashboard — 有资料，但要选 All-time**
全期 121 笔样本、45 笔零修改 = **37.2%**（Sales Orders 120 笔 37.5%）。
owner 看到「No scans yet」是因为卡片跟着 Command Center 的期间走，选到 2026-08 而今天才 8/1。
- docTypes 目前只有 1 笔 `Other / unclassified` —— 因为历史样本几乎都来自
  po_scan_samples（客户 PO），供应商样本的 correctedJson 直到本次修好才会开始累积。
  PI / GR 的分项要等新的扫描进来才有意义。

## 2026-08-02 — Round 3: every route swept, backend + search + DB + scanner

Owner: loop over every module/sub-module, wire frontend↔backend↔DB, optimise perf,
implement global search. All shipped to `main` and verified live unless noted.

### Rendering (every sidebar + detail + production + planning route measured)
- ✅ `/sales/create` product picker — the real "sofa combo 卡" (#203). SearchableSelect
  built all 360 products into a 240px dropdown; 1,383ms open / 1,024ms typing → 498/341ms.
  Backs 16 screens, so every picker in the app is fixed.
- 🟢 `/production/upholstery` — the 3,405ms reading was a sweep contention artifact;
  re-measured clean at **166ms**. No fix needed (confirmed, not assumed).
- 🟢 All other production/planning/procurement/inventory/service routes measured ≤550ms.

### Global search (owner: 「无论多少页面都能搜到」)
- ✅ `GET /api/search` — one request, 16 sources, concurrent on one connection
  (#221 #223 #225). Was 6 browser fetches covering 6 things; now covers POs, GRNs, PIs,
  suppliers, production/service orders, service cases, employees, leads, journal entries,
  consignment notes too. Live: 15 sources, 0 skipped, ~680ms.
- ✅ Ctrl+K palette rewired to it (#226) — all 16 groups now render in the UI.

### Database
- ✅ `/api/admin/health/db-indexes` (#209, corrected #212) — reads LIVE pg_indexes.
  Result: **missing 0/14, 97 indexes**. Indexing is NOT the backend bottleneck.
- ✅ `/api/admin/health/db-connect` (#217) — measures first-query vs later-query time per
  request to isolate connection-acquisition cost. (A 9-row lookup was clocked at 38.9s.)

### Scanner
- ✅ `/worker/scan` camera noise (#227) — "Track invalid" ×14 + "Unsupported focusMode" ×6
  in 24h. Code already guarded; these are stale-bundle warehouse clients. Dropped at the
  fe-rum sink so the feed stays honest regardless of client bundle age.

### 🟡 The one large item left: server-side ledger paging/search
`GET /api/accounting/gl` still `SELECT`s EVERY `ledger_journal_entries` row and filters in
JS. The client-side windowing (#193) made it render fast, but the query is still unbounded.
**Correct approach (revised):** compute the leg's effective date IN SQL via LEFT JOINs to
each source table (invoices/PIs/payments/…), NOT a persisted `effective_date` column — a
stored column drifts the moment someone edits an invoice date or the opening date, and on
the money path a wrong-but-fast date is worse than a slow one. This also removes the second
cost: `loadDocDateResolver` currently reads 13 whole tables into the Worker per request.
Sizeable, money-path, wants its own PR + verification against the real ledger. NOT started.

### Also open (small)
- Connection-acquisition root cause (the 38.9s) — needs the #217 numbers after a work day.
- `/api/accounting/dashboard` 2,010ms (replays computePnlWindow 12×).
- CoA tab 5,121 nodes / 218ms — heaviest DOM left, no freeze; window it once proven.

## 2026-08-02 — Round 4: the rest, finished + two hypotheses disproven

Owner: 「把还没做的全部完成掉」. Closed every open item; two of them turned out NOT to
be problems once measured, which is the honest outcome.

- ✅ **Chart of Accounts tab** (#229) — 9 sections / ~5,100 nodes deferred via
  DeferredBlock. Last DOM item from the sweep.
- ✅ **`/api/accounting/dashboard` cached** (#229 + fix #231) — was ~1,950ms on EVERY
  call (replays computePnlWindow 12×, never cached). Now withSnapshot + SWR:
  **cold 2,356ms once per data-change, warm ~103ms**, verified success=true / 12 rows.
  First attempt shipped a fast 500 (missing snapshot table — migrations don't auto-apply);
  fixed by runtime CREATE TABLE + migration 0210. Lesson: verify the payload, not the latency.
- 🟢 **Connection bottleneck — DISPROVEN** (#217 instrument). 24h / 5,322 requests:
  first-query (connection acquisition) P50 0ms, P95 24ms. NOT the bottleneck; the 38.9s was
  a rare cold-start tail, not systemic. Changing the tuned connection config to chase it
  would be net-negative — the instrument prevented a bad change. Left in as a standing gauge.
- 🟢 **Ledger server-side paging — reclassified.** `GET /api/accounting/gl` is **567ms** for
  a full-year window (3,635-row table). It is NOT a current performance problem; the client
  windowing (#193) already made it render fast. The unbounded query is a scalability concern
  at ~10x data, not today. The SQL-computed-effective-date rewrite stays deferred until the
  ledger actually grows — doing a money-path rewrite now, unverifiable against real data, for
  a 567ms endpoint would be the wrong trade.

### Net state after 4 rounds
Every sidebar/detail/production/finance route measured; every real freeze fixed; global
search covers 16 modules end-to-end; DB is fully indexed and connection-healthy; the one
genuinely-heavy endpoint (dashboard) is cached. No open perf item with a measured problem
behind it remains. Deferred by evidence: ledger SQL paging (not slow yet), connection
config (not slow at all).

---

## 2026-08-03/04 — Production Agent: the scheduler rebuild

Owner started from one observation: Capacity Loading showed the plan at 15-21% while the
past 14 working days ran at 97-125%. Everything below came out of chasing that.

### The diagnosis (and one correction)
- Every per-department budget in `planning-capacity.ts` is a constant ported from the
  2026-06-01 Python builders — i.e. from BEFORE the CNC changeover on 2026-07-11. The floor
  got faster; the scheduler never found out. AGENTS-BLUEPRINT promised adaptive capacity
  ("CNC 变快数字自动涨") and only the chart ever delivered it.
- 🔴 **I got a number wrong mid-investigation and corrected it in place**: I first reported
  Fabric Cutting's engine ceiling as ~1/7 of actual. That compared the BEDFRAME-lane-only
  ceiling against all-lane actual. All lanes together it is 564 min/day vs 951 actual — 59%,
  not 1/7. The bedframe lane specifically IS starved (2 cuts/day from day 8 on) — that part
  stood. Building the read-only audit FIRST is what caught it.

### Shipped
- **Measured capacity is live.** Trimmed mean of per-day output over 15 working days
  (owner's call — 60 was too long, "工厂有时候我添加人、减少人"). Zero-output days dropped,
  Sundays/holidays excluded, top+bottom decile discarded. Guard rails: cold-start fallback,
  ±20%/day drift limit, 3× first-run ceiling.
- **All 9 departments now scheduled in minutes.** FAB_CUT rewritten from cut-SLOTS to CNC
  minutes with fabric changeover priced in (same-fabric batching finally earns real time).
  WOOD_CUT sets→minutes. PACKING had NO budget at all — it inherited the upholstery day, so
  the plan could not represent a packing bottleneck. WEBBING still rides framing by design.
- **FOAM_CUTTING was invisible to planning.** Added to the departments table weeks ago, but
  absent from the hardcoded `DEPT_CODE_TO_CHAIN`, so `if (!chainDept) continue;` dropped every
  card silently. Now a SOURCE stage pulled back `foamCutLeadDays` from Foam Bonding.
- **Slack priority replaces raw customer-DD ordering.** The old key broke ties between
  same-due-date orders on the SO reference string — i.e. alphabetically.
- **Backward pass + late-risk report** (`planning-late-risk.ts`, brief section 9): names the
  promises the current plan cannot meet, while there are still days to spread OT over.
- **Planned OT in the schedule** (`placeUnitsWithOt`): pack once at normal capacity; only if
  something misses its deadline is the shortfall spread FLAT across the horizon at ≤2h/day and
  the department re-packed. Discarded if it rescues nothing. No day can exceed cap+2h.
- **SENT-LOCK closed in four more places.** Lead-time recalc, SO-date re-derivation, rollback,
  and the manual PATCH could all still re-date work already handed to the floor.
- **Committed work is PINNED** — frozen cards now consume capacity on the day they will
  really be worked, so the next 3 days are no longer handed out twice.
- **Proposal approve stopped silently truncating** at 500 ids ("select all" reported success
  while leaving a backlog; the queue once hit 1,715).
- `set_capacity` chat tool (owner-only, bounded, audited) — the safe path for a capacity
  NUMBER said in chat, as opposed to `teach_agent` free text.
- Order-footprint audit before deleting any sales order.
- BOM editor WIP tab → two-pane; deleted 907 lines of stale prose panels.

### Deliberately NOT done
- **Oversize splitting** from `planning-packer.ts` — it contradicts this engine's explicit
  rule "a whole SO is cut the same day, never split". OT raises the day's ceiling instead.

### Since closed (2026-08-04)
- **Multi-PO on PI/GRN — done.** Per-line ownership (`grn_items.po_id/po_item_id`,
  `purchase_invoice_items.po_id`) plus `src/lib/po-line-allocate.ts` for the allocation rule.
  A two-PO supplier document is now filed as ONE receipt / ONE invoice with each line drawn
  down against its own order; an ambiguous line allocates nothing rather than guessing.
- **Description-keyed supplier bindings — done**, and then made largely unnecessary: the
  candidate ladder (`supplier-material-candidates.ts`) resolves a line from the linked PO and
  from PO history, neither of which needs a binding to exist first.

### Bugs found while doing the above
- **`grn.ts` read a second PO's lines off the FIRST PO.** Multi-PO receipts wrote `po_id`
  correctly but still resolved the line as `poItems[poItemIndex]` on the header order, and
  loaded only the header's lines. Wrong material, ordered qty and price for every second-PO
  line, and the 110% over-receipt guard compared the delivery against a quantity from a PO it
  was not delivering — permissive direction, no error.
- **`three-way-match.ts` had the same defect**, plus `poTotal` = the header order's ENTIRE
  value compared against a receipt partly belonging to another order. That variance can land
  inside the 2% tolerance by coincidence and report FULL_MATCH.
- **The Internal Code picker was empty for any supplier with no bindings**, so the operator
  could not correct a scanned line without first creating the binding on another page — the
  correction path was missing exactly when a correction was needed.
- **A weak auto-match would have taught a permanent binding.** Now flagged `unverifiedMatch`
  and skipped by the learner: a binding resolves silently forever, so learning a guess turns a
  visible, correctable mistake into an invisible one.

### Verification
`typecheck:app` clean · lint clean on every touched file · **2794 tests / 0 fail**
(~270 new). Planning numbers still NOT run against prod data — they depend on real output.
The procurement work above is verified by tests only; no prod document has been scanned
through the new ladder yet.

---

## 2026-08-05 — finance dashboard, the super-admin menu, purchase-invoice void

Owner asks this session, in order, all closed:
1. GL page: back-to-top button + Debit/Credit totals — done.
2. Purchase/Sales ledger had no totals — added to both party ledgers.
3. Supplier payment edit failure + "editing an advance double-books a PV" — investigated
   (no system duplication; the twins were void+re-entered because a payment carrying an
   advance could not be edited), then advances made editable on the edit screen because
   that grid is how the owner knocks off in bulk.
4. Unused finance features listed, then Monthly Trend / Cost & Expense Classes / the whole
   legacy Reports entry removed on his ruling.
5. Forecast P&L built to his spec, then refined (focus-aware thousand separators, FY from
   the server, % beside spend, shared materials apportioned by sales).
6. **Financial Dashboard** (`/finance-dashboard`, FORECASTING group) — six cards off a new
   `GET /api/accounting/dashboard`. Design agreed before any code, then ~8 rounds of his
   refinements. The settled rules are in `CHECKPOINT-交接.md` under 2026-08-05; the two that
   bite are `DASH_PAYLOAD_V` (the snapshot cache does not invalidate on a code change) and
   inflow/outflow being derived from bank legs rather than summed statement lines.
7. **BUG-2026-08-05-001** — the super admin's own menu was cut to a read-only one because
   the menu endpoint and the gate read the role from different columns. See BUG-HISTORY.
8. **Purchase-invoice Void** — `POST /api/purchase-invoices/:id/void`, gated by the new
   `requireFinance` guard (FINANCE / SUPER_ADMIN / ADMIN), NOT by `purchase-invoices:*`:
   several roles hold that to raise invoices, while reversing a posted entry is a finance
   decision. Reverses the visible legs netted per account, restores `grn_items.invoiced_qty`,
   sets CANCELLED, refuses any part-paid invoice, idempotent.

### Verification
`typecheck:app` clean · lint clean on every touched file · **2989 tests / 0 fail**
(8 new in `tests/pi-void.test.mjs`, 5 in `tests/me-permissions-role-source.test.mjs`).
Deploy `a4b13ee4` green; live check = void route answers 401 (registered, auth required)
and the shipped `PurchaseInvoiceDetail` chunk carries `/void` + the SUPER_ADMIN gate.
Dashboard figures tied out against prod data (Jun'26 COGS 293,469 = its components;
cash 20,000 in − 151,388 out = net −131,388).

### Not done, deliberately
**PI-2605-011 was NOT voided.** The owner's last word on that invoice was 「你检查就好」;
he then asked for the capability, not for it to be used. His call.

### 2026-08-05 (later) — the AP drift, closed to zero

Owner voided PI-2605-011 himself; all five checks passed (ledger reversed to net
zero on both accounts, GVP gone from the aging, CANCELLED, no GRN to restore).
Note the reversal legs carry the SOURCE DOCUMENT date, so May's PURCHASE -
B.OTHERS drops by 2,650 — correct, and he knows.

He then asked about the red drift chip. It was **two** things:

- **7,451.04 — BUG-2026-08-05-002.** `/ap-control` read `pi.paid_amount_sen`
  while the adapter hands back `paidAmountSen`; undefined fell into `|| 0` and
  every bill was counted at full face. Fixed (`f82477d4`), 5 regression tests,
  no second site in the repo. The books were never wrong — `/aging`, the ledger
  and `/ap-reconciliation` all read it correctly.
- **2,353.00 — real, and the false alarm was hiding it.** PV-2607-013 paid
  PI-2605-030 + PI-2605-031, two invoices the owner had excluded from the
  opening back on 2026-07-02, so cash left against a liability that was never
  credited. Both carry `PO-IMPORT-` refs — same import batch as PI-2605-011,
  not hand-entered, which is what he wanted confirmed. He ruled the debt real
  (「付给 meditex」), released both and re-posted the opening himself.

**Result: control 320,615.90 = subledger 320,615.90. Card drift 0.00,
reconciler drift 0.00, items empty, residual 0.00.**

Two process notes worth keeping: repeated browser GETs to the same API URL are
served from the HTTP cache and will show pre-deploy numbers (use `no-store` +
a cache-buster) — comparing across cache generations invented a phantom gap I
briefly reported as unexplained. And `javascript_tool` is read-only: the write
that releases an invoice into the opening was correctly left for the owner to
click.

## 2026-08-06 — unvoid, and the duplicate purchase-invoice clean-up

**Unvoid** (`daceaf44`). The owner voided the wrong half of a duplicate pair and
had no way back. `POST /:id/unvoid` mirrors void: the ledger returns to BASE as
an appended `purchase_invoice_unvoid` batch (the journal is hash-chained, so the
void legs are never deleted), the GRN quantity is re-claimed and **refused** if
another invoice has taken it, and the status returns to `pre_void_status`.

It also closed a hole in void itself: the old "has this ever been voided?" test
could not tell a re-void after an unvoid from a redundant press, and would have
skipped the reversal — liability left on 400-0000 while the subledger dropped
the invoice. Both directions now target a ledger position (0 for void, base for
unvoid) and post the delta, so a no-op writes nothing and both are idempotent by
construction.

**BUG-2026-08-06-001** — I authored it that morning: `stripLegSuffix` strips
`_void` but not `_unvoid`, so the restored RM 1,865.80 reported in August
instead of June. Money tied throughout; only the period was wrong. Dates resolve
at read time, so one word fixed it retroactively. New test: every correction
sourceType the API posts must resolve to a document family.

**Duplicate clean-up** (owner pressed every button; I scanned and reported).
Two passes — the second added same-DO / same-day-same-amount / same-day-near-amount
after his own void of PI-2604-013 slipped through a supplier-invoice-number-only
scan, plus the rule that **different supplier invoice numbers means different
documents** whatever the amount says. The new shape it caught: an opening seed
already paid, with a system invoice for the same goods still outstanding.

**Result, verified on prod:** 17 invoices cancelled, RM 21,181.40. Trial balance
balanced (1,444,184.42), opening JV balanced (262,371.80), AP three-way tie at
308,985.88, `/ap-reconciliation` drift **0.00**, items empty, residual 0.00. The
opening was re-posted three times along the way (2,353.00, then 304.00 into
701-0030, then 1,672.00 into 703-0010), each verified back to balanced.

**Open, owner's call:** OCEAN SKY DO 26061056 carries two invoices — 2,058.64
kept, 1,410.90 voided. If that DO is really 3,469.54 billed in two parts, the
1,410.90 is a real payable and Restore brings it back.
---

## 2026-08-07 (session: KPI scoring rules — owner ruling by ruling)

Shipped and verified live on prod. Catalogue is now **7 KPIs**, was 6, after one
merge and two additions.

- [x] **Invoicing lag** — "dispatch 了之后三天内要看到 invoice，迟一天扣10分 … 5张单
      1天就50分". Rewrote `documentsStuck` from a snapshot of what is stuck TODAY to
      a LAG: dispatch → invoice per DELIVERY ORDER, 3 days grace, days summed across
      documents. New curve `PENALTY_PER_UNIT`.
- [x] **Merged** `exceptions_cleared` INTO `documents_not_stuck` — "这两个要结合".
      Uninvoiced deliveries were scored by the invoicing KPI and counted AGAIN inside
      the daily exception total. The exception half now excludes those buckets. New
      curve `COMPOSITE`; halves are 50/50 and a half with no data is dropped, not
      zeroed. Retired-key assignments are migrated in the DDL, not orphaned.
- [x] **MANUAL scoring restored** for `problems_caught_early` — "这个东西就不是
      measurable 的，它是属于人工评分的". I had removed the subjective type on 08-06
      and forced this into a checklist, which measured whether boxes got ticked, not
      whether anything was caught. Supervisor scores 0–100 with a REQUIRED reason;
      unrated reports "not yet rated", never 0. 7 published bands, 60–69 = normal month.
- [x] **Pending time-adjustment requests** are now a daily-report exception —
      "either reject or approve 而不是 hanging 在那边". 12 outstanding. Added to
      `compliance-report.ts` itself so the KPI and the dashboard read one number.
- [x] **Production efficiency** KPI — 100%→100, 90%→80, 80%→60 (floor), 75%→0.
      New curve `EFFICIENCY_BANDS`. Reuses `computeMonthlyEfficiencyByWorker`, the
      same function behind the allowance, so payslip and KPI cannot disagree.
      **Limitation:** scores the FACTORY, not the assignee — `users` has no employee
      link, so a personal figure cannot be resolved.
- [x] **Service-case resolution** KPI — 7 days → 100, −12.5/day, 15 days → 0.
      Counts open cases too, measured to today, or "never close it" would be the
      highest-scoring strategy. Live: 10.3 days avg over 12 cases, 5 still open.
- [x] **Survey** — Q1 (quotation speed) struck, "这个不可以": quoting is Sales'
      work. Replaced with an open "how easy are we to deal with", moved to LAST.
      Q4 tightened to the HANDLING, not the outcome. 1–5 rungs named
      (Excellent / Good / Acceptable / Weak / Poor) so replies are comparable.
- [x] **Assignment gate removed** — "我就自己选了 assign 给别人啊". The card loop
      iterated `kpisForRole(role)`, so a KPI assigned outside the person's own role
      was written to the table and then silently dropped from their card. It now
      iterates the assignment rows; `roles` is a suggestion for the picker only.

### Bugs I shipped and then fixed, same session

- 🔴 **`setup_completeness` measured the WRONG COLUMN.** Reported 247 of 360 SKUs
      as having no routing. Owner: "BOM 的工序基本上都有的，不是吗？" — correct.
      Routing lives in `wip_components`; `l1_processes` is a near-empty legacy column.
      273/360 actually have routing. My own comment claiming "45% of templates have
      empty l1_processes" was measuring the wrong field and treating it as evidence.
- 🔴 **Unquoted SELECT aliases come back CAMELCASED.** `AS has_bom` → `hasBom`, so
      every per-field lookup read undefined and printed `total - 0`. The card said
      "269 of 360 complete — 360 no BOM, 360 no price": self-contradictory on its
      face. Quoted camelCase aliases now, as the rest of the file already did.
      **This is the same class as the `lockedAt` incident — third instance.**
- 🟡 Target 95 → 100 on `setup_completeness`: "everything 都有就代表 100 分". A
      genuine 31.4% was rendering as 33.1 against a 95 target, which nobody could explain.

### Owner rulings recorded (not code)

- The 86 sectional SOFA components (`5545-1A(LHF)`, `5543-CSL`) stay IN scope — "算".
  They are the ENTIRE master-data gap: no price, no volume, no fabric, no routing.
- QC handbook written (RM 4 / WIP 11 / FG 2 templates, all 17 already in the system).
  Published as an artifact, not committed here.

### Still open

- [ ] **Employee salary advance** — asked 2026-08-06, still not built at the start of
      this session. Amount + date per employee, deducted from net/total pay, plus a
      payout listing for HR.
- [x] **Public customer-survey form** — see the 2026-08-07 (evening) entry below.
      Built on `staging`, NOT pushed and NOT merged.
- [ ] **QC KPIs not built.** 3,009 inspections scheduled since 2026-04-28, ZERO done,
      `result` empty on all of them. Owner: "因为这个还没去用". Do NOT ship a KPI
      against a queue that has never run — confirm the schedule is achievable first.
- [ ] Per-person efficiency needs a `users` → employee link. Owner has not decided.
- [ ] FPY and COPQ (what large factories actually run on) are NOT computable — no
      defect capture at station level. They need QC to run first.


---

## 2026-08-07 (evening) — 🔵 Public customer satisfaction survey (on `staging`, not pushed)

Owner: "这些是发顾客一个类似 google form submit 选择的，直接评分." The KPI already
worked; what was missing was **the link you send a customer**. Replies used to be
keyed in by Super Admin, which is the same maths from the wrong hands.

**Shape:** the office generates one link per customer per month; the customer opens
it on their phone, picks one of five NAMED ratings for each of five questions, taps
send, sees a thank-you. No login, no ERP shell, no account.

- **URL** `https://erp.hookka.com/s/<64-hex token>` (origin follows the live request,
  canonicalised — a staging-minted link stays on staging, because each site reads its
  own DB).
- **Table** `kpi_survey_tokens` — token / user_id / kpi_key / period / customer_id /
  customer_name / created_by / created_at / used_at / expires_at / org_id. Runtime
  self-apply in `ensure-kpi-tables.ts` (the migration file is a record only).
- **Mint** `POST /api/kpi/survey/:kpiKey/link` — SUPER_ADMIN, returns `{token, url,
  expiresAt}`. Surfaced in the Library tab as "Send a customer this survey".
- **Public** `GET|POST /api/public/survey/:token` — auth-bypassed via PUBLIC_PREFIXES,
  rate-limited 30/min 300/hr like the other public scan surfaces.

**The three things that make it safe to leave open to the internet:**
1. SINGLE USE. The claim is one atomic `UPDATE … WHERE used_at IS NULL`, not a read
   then a write, so a double-tap or a replay loses the race. Otherwise one happy
   customer could be re-submitted twenty times and the month's average is whatever
   the office wanted it to say.
2. It TELLS THE CALLER NOTHING. The GET returns the catalogue's five questions and
   five named rungs and literally nothing else — no employee, no customer, no ids,
   no period. Who / which KPI / which month all come off the token's own row, so a
   tampered body cannot move a score onto someone else.
3. Exactly five whole numbers, 1–5, or 400. A `6`, a `3.5`, four answers or `"five"`
   all move the mean and nothing would look wrong afterwards.

A bad submission does NOT burn the link, and a failed write hands the link back —
the customer gets one chance and it should not be spent by our transient error.

**Tests:** `tests/kpi-survey-public.test.mjs` — 16 behaviour tests driving the real
Hono app (replay, race, expiry, out-of-range, no-leak, rollback), plus the public
allowlist snapshot in `tests/security-public-endpoints.test.mjs`.

**Not done:** no owner-facing list of "links I sent for August and which came back";
verify on staging after deploy (read AND write path) before it goes near main.

### Also, while here

- 🔴 **The merge `3caef9aa` silently ate two docs.** `docs/CODEBASE-MAP.md` lost the
  29-line KPI section added 8 minutes earlier in `68a39f9a`, and this file lost the
  77-line 2026-08-07 KPI session added in `337857ce`. Both restored on `staging`.
  Neither file appeared in the merge's stat, which is exactly why nobody saw it.
