> **ARCHIVED / SUPERSEDED — this is a closed session log, not current state.** It records
> what one design session changed inside `docs/design/Hookka ERP Mobile.dc.html`; the live
> answer to "what does the phone UI look like now" is the `.dc.html` sources themselves
> plus `src/pages/m/`. Kept for history only; do not treat as current.
>
> Verified 2026-08-13: the design tokens it lists (raisin `#1F1D1B`, taupe `#6B5C32`,
> paper `#FAF8F4`, card border `#E7E0D4`, gold `#C9A961`) all still match
> `src/pages/m/theme-vars.css`. Its ✅/⚠️/❌ status marks describe the **prototype**
> `.dc.html`, **not** the shipped React app — a ✅ here is not evidence a feature exists in
> `src/pages/m/`. It also predates the dark/light mode toggle it asks for in one line and
> the app now ships.

# Hookka ERP — 手机版重新设计 Change Log

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> 本次 session 对设计做的所有更改。状态标记：✅ 已完成可用 ｜ ⚠️ 部分完成 ｜ ❌ 仅可看未接操作

---

## 1. 整体方向 & 架构
- ✅ 从「重新设计」收敛为「统一风格 + 手机版」，删除桌面版，专注手机端原型。
- ✅ 建立数据驱动的通用模块引擎：每个模块 = 一份配置（KPI + tabs + 列 + 行），单文件 `Hookka ERP Mobile.dc.html` 承载全部。
- ✅ 统一设计 token：raisin `#1F1D1B`、taupe `#6B5C32`、paper `#FAF8F4`、卡片边 `#E7E0D4`、金 `#C9A961`；字体 system-ui，数字 tabular。
- ✅ 全部图标换成 Lucide 细线（stroke 1.75），按模块名贴合选择。
- ✅ 导航层级 L1 列表 → L2 详情 → L3/L4 钻取（导航栈 stack 驱动），所有模块结构一致。
- ✅ 底部导航：Home · Sales · Production · Procure · More（去掉扫码 tab）。

## 2. 登录界面
- ✅ 用真实 Hookka logo（房子轮廓 + 合家），白色显示在深色网格背景。
- ✅ 对齐桌面版：Welcome back + "manufacturing intelligence platform"、大写标签、Remember me / Forgot Password、渐变 Sign In、公司注册号页脚。
- ✅ 雪花飘落动效（前后两层景深：后层模糊慢、前层清晰快）+ 暖金光晕脉动。
- ✅ 深 / 浅模式切换按钮（右上角 sun/moon），默认深色。
- ✅ 半透明毛玻璃表单，雪花穿过表单飘落。
- ✅ 输出 4 个独立登录 UI：Main 深 / Main 浅 / Worker 深 / Worker 浅。
- ✅ Worker 登录改为工号 + 6 位 PIN 键盘；工号支持任意格式（EMP-008 / emp008 / EMP008 自动规范化）。

## 3. 统一 DataGrid（早期桌面阶段）
- ✅ 类型感知 filter：文本「包含」、代码「包含/开头」、数字「= > < ≥ ≤ 区间」、日期「起止+快捷」、枚举「多选」。
- ✅ 列操作：排序升降、Flip（显隐）、Clip（冻结/pin）、左右移动、拖拽重排。

## 4. 各模块（手机端）
- ✅ Sales Orders：详情对齐桌面版（Company SO / Customer SO / Customer PO / Reference / Company SO Date / Customer DD / Hookka Expected DD / Delivery Order）+ Summary + Linked Production Orders + 行项目带定制标签（Leg 6"/Nylon Fabric）。Draft→Confirm 状态流程。
- ✅ Delivery：6 状态 tab（Planning / Pending Delivery / Pending Dispatch / Dispatched / Delivered / Packing List）+ 3PL Providers。
- ✅ Production：Overview + 8 部门 tab；详情加 PIC、Started、Completion date。
- ✅ Planning：Capacity Overview / Capacity Loading / Lead Times / Master Tracker。
- ✅ Warehouse：rack 卡片（代表产品 + Items 数 + Occupied/Empty）；详情 = 深色 Rack 头 + 「In this rack now」按件清单 + 出入库记录（对齐真实 rack 页）。
- ✅ Employees：9 个真实 tab（Working Hours / Attendance / Labor Cost / Efficiency / Dept Labor / Employee Perf. / Dept Perf. / Payroll / Employee Master）；详情含考勤条 + 工资单。
- ✅ Invoices：Invoices / Payments / Supplier Pay / Credit Notes / Debit Notes / e-Invoice。
- ✅ Inventory：FG / WIP / RM / Fabrics / Stock Value / Adjustments。
- ✅ Customers / Suppliers / Products / Announcements / Mail Center 全部有列表 + tab + 详情。

## 5. Dashboard（Home）
- ✅ 改为 Command Center：本月销售 / 发票 / 待送 / 应收 4 个 KPI。
- ✅ Daily Report 异常区（Overdue / SO no DO / PO not received / Low efficiency）。
- ✅ Order Pipeline（Confirmed / Outstanding / Delivered 进度条）。
- ✅ This Month / Last Month 可点切换，KPI 数值随之变化。
- ✅ 库存预警 + 本周到期订单。

## 6. 可操作功能
- ✅ 创建：Sales Order / Delivery Order / Purchase Order / Invoice（全字段 + 行项目 + 金额自动算）。
- ✅ 编辑：详情铅笔按钮打开表单、带入原值、改字段 / 加删行项目 / 改金额，保存即更新。
- ✅ 公告：发布（标题 + 类别/收件人 Send to + 附件）+ 签收（Acknowledge）。
- ✅ 邮件：发送（收件人下拉 + 主题 + 正文 + 附件）+ 签收 + Reply/Forward 开新邮件。
- ✅ 全系统单据搜索：按 Company SO / Customer SO / Customer PO / Reference。
- ✅ 用词对齐：Amount（非 Value）、Expected DD（非 Promise）；状态用真实枚举。
- ⚠️ Print / View 按钮：可点有反馈，但非真实 PDF 预览。

## 7. Worker Portal（车间端，独立原型）
- ✅ PIN 登录 + 首页（打卡 CLOCK IN/OUT + SCAN JOB CARD + 今日件数 + 计件工资 + 报修）。
- ✅ Me（绩效 + 日期范围 + 每日考勤 + 完成产品）、Pay（工资 + 工资单）、Team（部门绩效 + 成员）、扫码全屏。

---

## ⚠️ 已知未完成（下一批，建议新对话继续）
- ❌ SO：On-hold / Cancel 按钮；行项目规格编辑（Variant / 颜色 / Gap / Divan 底纹）；OCR 扫单→草稿→编辑。
- ❌ DO：状态推进真实切换；创建 Packing List；编辑 3PL；改司机；真实 PDF 预览打印。
- ⚠️ Invoice：仅能改总额，不能逐行改单价；缺 Balance Due / Lifecycle 深版。
- ⚠️ Production：缺「默认只显示未完成」+ 完成率进度条。
- ❌ Capacity Loading：现为卡片，缺每日工时柱状图。
- ❌ Overview 报表：超期报告 / 产能概览（周月日）/ 全部门效率总览。
- ❌ Announcement：定时自动隐藏；过去公告隐藏删除；已读名单。
- ❌ Mail Center：权限分流、auto-send、代领草稿、完整线程、整封作附件。
- ❌ Dashboard：Revenue 折线、Plant Load 仪表、Worker Efficiency、Sales by Customer、Fabric Usage 等图表。

## 文件
- `Hookka ERP Mobile.dc.html` — 源文件（可读可改）
- `standalone/Hookka ERP Mobile (Phone).html` — 打包版（手机直接打开）（路径 2026-08-14 更正：原写作 `dist/…`，该目录不存在；`README.md:21` 一直是对的）
- `hookka-logo.png` · `support.js` — 资源 / 运行时
