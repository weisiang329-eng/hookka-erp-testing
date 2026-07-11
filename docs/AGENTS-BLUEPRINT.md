# Hookka ERP — AI Agent 总蓝图（Master Blueprint）

Owner + Fable 5 定稿于 2026-07-12。这是全公司 Agent 化的执行大纲：以后按此清单
一个一个做。原则：**LLM 当大脑（判断/归因/决策/说人话），确定性引擎当手脚
（算数/执行），审批当保险丝** —— 纯 LLM 会瞎编，纯逻辑不进化，混合才是企业级。

真 Agent 判据：感知 → 思考（运行时自己选路径）→ 行动 → 观察 → 学习 的闭环。

---

## 0. 共用底座（建一次，所有 Agent 复用）

| 组件 | 状态 | 说明 |
|---|---|---|
| LLM 大脑 | ✅ 已接 | Claude API（assistant.ts + anthropic-client.ts），66 个只读工具 + 多轮循环 |
| 定时运行器 | ✅ 已有 | GH Actions cron 模式（mail-sync / production-brief 先例） |
| 提案-审批框架 | 🔄 P2 已建原型 | schedule_proposals 模式：Agent 出提案 → 人一键批准 → 写入 + 快照留痕。**要泛化成通用 proposals 框架**供全部 Agent 用 |
| 通知层 | 🔄 邮件已通 | Brevo 邮件（晨报）；WhatsApp Business API 待开（utility ≈ RM0.056/条，Meta 商业账号验证后接） |
| 学习环模式 | 🔄 骨架已有 | 漂移检查（配置 vs 实际）→ AI 归因 → 调参提案 → 批准生效（kv 配置在线改） |
| 权限/审计 | ✅ 已有 | RBAC + audit_events 每个工具调用留痕；写动作全部走审批 |

## 1. Production Agent ⭐ 进行中（模板工程，验证整套打法）

- **P1 生产晨报** ✅ 已上 prod：每工作日 07:00 自动生成（今日计划/逾期/昨日实绩/
  瓶颈/CNC 同布队列+换布次数/漂移检查/AI 今日焦点），Gmail + Dashboard 卡。
- **P2 排产提案** ✅ 代码完成，staging 部署绿，待 owner 登录 staging 实测：
  引擎（同布抱团第一优先 + 拉单窗口 + 部门链 +1/+2 交接）给未排产/过期工卡出
  建议日期 → Planning「Schedule Proposals」tab 一键批准 → 写 dueDate + 计划快照。
  铁律层 = jc.sequence + branchKey + wipKey（数据驱动，永不排出打包先于扪皮）。
- **P3 学习环**（下一步）：每日 计划 vs 实际 → 偏差归因（缺料/人手/速度漂移）→
  调参提案（产能/交接天数）→ 批准生效。产能感知 = 近 7 工作天实际完成量（自适应，
  CNC 变快数字自动涨；owner 自调 WIP production time，Agent 不碰标准）。
- 数据源：computeChain / planning-schedule.ts / compliance-report / dashboard-overview。

## 2. 采购 Agent（Purchasing）★★ 底子最厚，建议第二个做

- 感知：MRP 缺料（/api/mrp）、PO 状态、GRN 到货、supplier 比价（pricing.tsx 数据）。
- 行动（全走审批）：缺料 → 自动拟 PO 草稿（供应商按最近价/最快交期建议）；
  超期未到货 → 催货清单/邮件草稿；比价异常（同料价差>X%）→ 提醒。
- 学习环：供应商实际交期 vs 承诺 → 供应商可靠度评分 → 影响下次推荐。
- 依赖：提案框架泛化。

## 3. 账务/收款 Agent（Finance/AR）★★ 数据刚修干净

- 感知：已交货未开票（compliance soNoInvoice，已修准）、发票账龄、付款记录。
- 行动：漏开票清单 → 一键生成发票草稿；逾期账款 → 分级催收邮件草稿（你批准发）；
  月末对账异常清单。
- 学习环：每客户实际付款周期 → 信用画像 → 催收节奏自调。
- 备注：service order RM0 规则已内置；CN 永不开票规则已内置。

## 4. 销售/报价 Agent（Sales/Quotation）★★

- 感知：OCR 扫描客户 PO（管道已修通含手机端）、产品目录+sofa combo 价、排程引擎。
- 行动：扫描 → SO 草稿（已有）→ **自动回复承诺交期**（用排程链算真实可交日，
  不是拍脑袋）；价格异常（低于组合价/目录价）→ 拦截提醒。
- 学习环：报价 vs 成交率、承诺交期 vs 实际达成率。

## 5. 送货/物流 Agent（Delivery/Logistics）★

- 感知：READY_TO_SHIP 池、3PL 州费率卡（已上线）、自车成本、hub 规则。
- 行动：装车建议（同州/同 hub 拼车、PL-first 已有）→ 3PL vs 自车成本对比 →
  DO 草稿；派车日报。
- 学习环：实际运费 vs 预估、准时率 per 3PL。

## 6. 人事 Agent（HR/Payroll）★

- 感知：打卡+selfie+围栏、效率%（口径已统一）、扣款/OT、payslip 引擎。
- 行动：异常日报（连续迟到/效率骤降/漏打卡）；发薪前预检清单（异常工时/
  统计口径 diff）；时间调整建议（partial-approve 流程已上线）。
- 学习环：per-worker 效率基线 → 偏离才报，不刷噪音。
- 红线：不碰已完成工卡/已批工资（inviolate 规则）。

## 7. 数据质检 Agent（Data Quality）★ 把 0711 大审计变成天天自动跑

- 感知：tally 矩阵规则（同指标跨页一致）、未来日期、孤儿引用、口径漂移
  （0711 审计的 20 条全部规则化）。
- 行动：每晚扫 → 异常清单进晨报/独立周报；高危（账目类）即时通知。
- 学习环：新增页面/指标自动纳入对账清单。

## 8. 库存/物料 Agent（Inventory）

- 感知：RM/FG 库存、消耗速率（fabric usage 已有）、在途 PO、安全库存。
- 行动：低于安全线 → 触发采购 Agent；呆滞料（N 天无动）清单；批次老化提醒。
- 依赖：采购 Agent 先行。

## 9. 客服/服务单 Agent（Service）

- 感知：service case 链（case→SV→部件），QC fail 记录。
- 行动：新 case 自动分诊（查原单/交期/部件建议）；repair scope 建议。

## 10. 老板助理 Agent（Chief-of-Staff）— 收官之作

- 现有 Hookka AI 升级：跨模块问答（已有）+ 主动周报/月报（日报已有编辑版）+
  "本周你需要拍板的 N 件事"聚合（各 Agent 的待批提案汇总一页）。
- 通道：WhatsApp（接通后）。

---

## 执行顺序（owner 定案 2026-07-12：先做两个）

**第一优先：① Production Agent（排产）+ ② Delivery Agent（TMS）** —— 其余按下表顺延。

**Delivery Agent（TMS 式，owner 原话范围）**：管整条送货生命线
pending delivery → 装车/派车（拼车建议、3PL vs 自车、州费率、hub 规则、PL-first）
→ dispatch → delivered（POD 跟踪、未签收提醒）→ 开 invoice（漏开票闭环，
接 compliance soNoInvoice）→ delivery return（退货 DO/换货，接 service case 链）。
学习环：3PL 准时率与实际运费 vs 报价、每客户收货窗口。现成底子：3PL 州费率+
PL-first+hub 完整性已上线、Dispatch/Delivered 客户通知邮件已上线、DO 价值统计共享。

## 原执行顺序（参考，每个 ≈ 数天）

```
① Production P2 验收 + P3 学习环   ← 现在
② 提案-审批框架泛化（从 schedule_proposals 抽通用层）
③ 采购 Agent → ④ 账务 Agent → ⑤ 数据质检 Agent（省心三连）
⑥ 销售 Agent → ⑦ 送货 Agent → ⑧ 人事 Agent
⑨ 库存 Agent → ⑩ 服务 Agent → ⑪ 老板助理收官 + WhatsApp
```

## 成本口径

- LLM：晨报/归因类每天几次调用 ≈ 每月几块钱级；助手问答按量。
- WhatsApp：公司主动推送 ≈ RM0.056/条；你先发问的回复免费。
- 全部走现有 Claude API key（assistant 已有额度管理）。

## 铁规（每个 Agent 都必须遵守）

1. 写动作一律 提案 → 人批准 → 执行 + 快照留痕（护栏内自动化需 owner 明示升级）。
2. 算数交给确定性引擎，LLM 只做判断/归因/表达。
3. BOM/顺位/已完成数据 = 不可违反的铁律层（数据驱动，不硬编码）。
4. staging 先行验证，数字核对后才上 prod。
5. 学习环的每次调参都留痕可回滚。
