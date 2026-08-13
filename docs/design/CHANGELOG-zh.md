> **ARCHIVED / SUPERSEDED — this is a closed design-session requirements log, not current
> state.** It records the prompts given to a design tool and what changed inside the
> `.dc.html` prototypes. The current phone/fold design is the `.dc.html` sources; the
> current *app* is `src/pages/m/`. Kept for history only; do not treat as current.
>
> Corrected 2026-08-13: the source paths below said `source/…`. **There is no
> `docs/design/source/` directory.** The `.dc.html` files sit directly in `docs/design/`,
> and the two standalone deliverables are in `docs/design/standalone/`. A ✅ in this file
> describes the prototype, never the shipped React app.

# Hookka ERP — 移动版 + Fold 版 · 需求与更改记录

> 本文件记录你（客户）给出的每一条 prompt（= 需求），以及对应做了什么改动。
> 交付物：`standalone/Hookka ERP Mobile (Phone).html`、`standalone/Hookka ERP Fold.html`（单文件、离线可用）
> 源码：`docs/design/Hookka ERP Mobile.dc.html`、`docs/design/Hookka ERP Fold.dc.html` + `support.js` + `hookka-logo.png`
> （路径 2026-08-13 更正：原写作 `source/…`，该目录不存在）

---

## 一、最终交付的模块总览（全部可点、可操作）

**Dashboard（首页，照桌面版重建）**
- KPI：This Month Sales / This Month Invoices / Pending Delivery (On DO) / Outstanding
- 图表：Revenue 折线（SO / Production / Invoices 三线，可点图例开关）、Plant Load 仪表盘、Order Pipeline、Worker Efficiency（Top/Lowest 5）、Sales by Customer（甜甜圈 + 客户表，可按 All/Bedframe/Sofa 切换）、Top Sellers、Fabric Usage、Department Backlog、Purchasing
- Plant Load 的 Daily Capacity / Total Backlog / Active Jobs / Completed 可点 → 进入 Planning

**Sales Orders / Delivery Orders / Procurement（采购）/ Invoices**
- 列表卡显示：我方 SO、客户名、Customer PO、Customer SO、Reference、Hub、日期、金额
- 多选（multi-select）批量操作；PO 一键转 GRN / Purchase Invoice，列表多选批量转换
- OCR 扫描（SO / PO）→ 识别 → 自动带出草稿可编辑保存
- 增 / 改 / 删（DO 等）；单据详情含条码 + 可开 QR、状态时间线、单据关系图、History 审计
- 创建表单：日期=日历选择器、文字=文字框、数字=数字框；SO 行项目按品类出不同变体字段（Sofa：颜色/脚/Total Height/D1/Mattress Gap/Seat Depth；Bedframe：对应尺寸）

**Customers（客户）**
- 开户、编辑（Credit Limit / BIC(SSM) / 电话 / 联系人 / 状态）
- Delivery Hubs：查看、添加、编辑
- 导出：Quotation PDF / Catalogue PDF / View History

**Suppliers（供应商）**
- 添加 / 编辑（采购公司、账期 Terms、状态、电话、联系人）
- 评分卡、价目 SKU 表（带表头）、Last Purchase Orders（可点开进 PO 详情）
- Price Comparison（真实对比子页）、SKU Mapping（真实映射子页）

**3PL Providers（物流）**
- 添加 / 编辑；State Rate Card（州费率）、Fleet & 车辆尺寸、Drivers（司机联系）

**Products（产品）**
- SKU / 变体 / BOM；列表按 Category 筛选；列表头 Export PDF（Sofa / Bedframe / By customer 目录导出）；封面缩略图

**Service Cases（服务个案，按桌面版重建）**
- 8 段 pipeline：Opened → Investigating → Service Order → Repair in progress → Repair done → Delivery arranged → Delivered → Closed
- 可编辑 + Start Work / Advance；区块：Issue Description(5W)、Photos、Affected Products（含损坏部件）、Service Orders（可 Spawn）、Issue Replacement Parts（RM/WIP/FG）、Root Cause & Prevention、Action Taken log
- 详情含 Customer PO / Customer SO / Customer Reference / 我方 SO；可下载文档 / 关闭个案
- 修正：日期正名为「Completion Date」、修掉 [object Object] 与 fade 问题

**Service Orders（服务订单）**
- 列表：Company SO / Customer SO / Customer PO / Customer / State / Reference / 日期 / Items / Qty / Total
- New Service Order → 「Copy from Sales / Consignment Order」弹窗（选 Sales Order / Consignment Order，输入 SO/PO/SO/reference）→ Next 自动带出草稿（客户、Cust SO/PO、reference、复制行项目，价格默认 RM 0）
- 可独立查看，数据跟 Sales Order 一样完整；与 Service Case 串联

**R&D Projects（研发）**
- 列表按 Category（Bedframe/Sofa…）；Create New Project；详情：Stage Timeline、Clone Source、Milestones（含照片）、各部门 prototypes（可 Add）、Material Issuance、Labour Hours、Budget + R&D 成本拆解、封面

**Warehouse（仓库）**
- Rack 货架总览（占用进度）、Stock In / Stock Out（真写入 movement）、Recent Movements、Movement History（可筛）
- QR：单个货架 QR、**Create Item QR**（选成品生成可扫码）、Download 全部货架 QR（PNG）、单 QR 下载

**Employees（员工）**
- Working Hours（可编辑行）、Attendance（打卡 + GPS/地理围栏 + 异常标记）、Department Performance（部门+类别筛选、打印报表）、Employee Performance（按姓名搜 + KPI + 每日明细 job card）、Labor Cost vs Revenue、Payroll（查看）
- Employee Master：开户口 / 改密码 / 改效率津贴、薪水、标准工时；Dept Labour 按部门筛；请假/标准工时调整可 Approve/Reject

**User Management（用户管理）**
- 邀请（email、显示名、角色，72h 链接）；成员列表 + 待接受邀请；Reset password / Deactivate / Resend / Revoke

**Announcements（公告）**
- 创建（含 Category、Send to 对象）；已读追踪（Read X of N、已读名单 + 未读名单、提醒未读 / 提醒全部）

**Mail Center（邮件）**
- 创建：From + To 联络人选单（不需手打）

**全局功能**
- 全局搜索：客户 / PO / SO / Reference / 单号，任何模块列表都能搜
- 各模块定制 Filter & Sort（采购按 Supplier、客户按 Customer、员工按 Department、产品/研发按 Category、3PL 按 Coverage、用户按 Role…；不相关的日期范围/实体段自动隐藏）
- Dark / Light Mode：手机版在 More 菜单、Fold 版在左栏底部；即时切换、记忆设置；logo/QR/照片不反色
- 真 logo（黑色 HOOKKA 合家 字标）；KPI 大数字不再爆框
- 底部中间凸起的「More」九宫格按钮

**Fold 版（Samsung Fold 风格）**
- 收起 = 手机版（底部导航）；展开 = Fold 版（左侧持久导航栏 + 宽屏内容）
- 真实折叠屏/浏览器按视口宽度（≥700px）自动切换；顶部按钮可手动覆盖（编辑器预览用）
- 宽屏内容居中限宽，滑动不松散

---

## 一·B、更早期阶段（登录 / 工人端，先于详细记录）

> 这些是 ERP 主程序之前完成的部分，依项目内文件补记：
- **Hookka 主登录页**（`Hookka Main Login.dc.html` + Light 默认版）：品牌深色背景、logo、登录表单。
- **Hookka 工人登录页**（`Hookka Worker Login.dc.html` / Light / 默认版若干）。
- **Hookka 工人端移动 Portal**（`Hookka Worker Portal Mobile.dc.html` 及副本）。
- 随后进入本文件主体记录的 **ERP 移动版** 全模块开发，并扩展出 **Fold 版**。

> 说明：上述早期阶段的逐条 prompt 早于当前可追溯的对话范围，故以「成果文件」形式列出；ERP 移动 / Fold 阶段的需求则在下方逐条完整记录。

---

## 二、你给过的 Prompt（需求）逐条清单

> 以下按时间顺序整理你提出的要求；每条都已落实到上面对应模块。
> （ERP 移动 / Fold 阶段为完整逐条；更早的登录/工人端见上方一·B。）

1. Dashboard 要能看所有资料：Trend、Plant Load、Sales by Customer、Top Seller 等。
2. Warehousing：看 Rack、Stock In/Out、生成并下载 Rack QR、生成 Item QR、Recent Movements 与 Movement History。
3. 底部中间要 More 功能按钮（凸起）。
4. PO 可开给 supplier、可 print/preview；可转 Goods Receipt / Purchase Invoice；多选转 Purchase Invoice；SO/DO 都要可多选。
5. PO / GR / Purchase Invoice 要支持 OCR 扫描。
6. Service Case：可开 case → 生成 service order；可点 category、affected products、issue replacement parts、填 root cause 与 prevention；可下载文档 / close case。
7. Employee：Working Hours、Attendance、Department Labour（可按部门筛）；Employee Master 可开户口/改密码、改效率津贴/薪水/工时；Payroll 只读；Employee Performance 可按姓名筛；Attendance 的 Leave Report 可 Approve 标准时间调整申请。
8. 全系统的 Search 要能搜任何资料（客户/PO/SO/reference/我方 SO），且在任何板块（SO/DO/invoice…）都可用。
9. 全套系统资料都要有：我方 SO、顾客名、PO、顾客 SO、顾客 reference——并排进卡片。
10. Create customer 时要能选 Hubs；Order date / Expected date 应自动默认，只需选 Customer Delivery Date；Notes 排版、variants 排版、价钱处理要顺。
11. Customer 模块要完整：添加 customer、添加 Hubs、编辑（Credit Limit、BIC、电话…）、看 Hubs、导出（Export / Quotation / Catalogue）。
12. 3PL Provider 要可 edit：Driver Contact、Stock Out、Fleet、罗里大小和资料。
13. 字体要跟系统统一（用干净字体与干净单号）。
14. Dashboard 上面要能看到 This month delivery / invoice / pending DO 等（KPI 补回）。
15. 数字跑出来会爆框 → 要用小一点的数字 / 不溢出；左右要锁住不能乱滑。
16. 检查全系统哪里 UI 需要调整、重新排版（报表卡挤歪、操作栏挤歪、最后一张照片挤歪等）。
17. Home 要换成 Dashboard；Stock Alert/Overview 与桌面版不一样 → 以桌面版为准（去我的 frontend / 截图比照）。
18. procurement 换成 delivery order（底部分页）。
19. Products 要有 Category、可按 category 筛、可选 framing、Export PDF。
20. Product 详情要能放/上传照片；Price Comparison、SKU Mapping 要有下一步页。
21. R&D Project：可 Create New Project、可编辑里面资料；要能拉出封面；分 BEDFRAME 等类别。
22. 单据详情：Expected Delivery 点进去要看到谁 Complete、PIC 是谁、Related Document、金额、Summary、Order Progress、Status Timeline、关系图、History。
23. Service Case 要可开、可 edit（catalog/category/issue 等）、可 Start Work；与 Service Order 串联，资料/Line Item 一模一样；New Service Order = Copy from Sales/Consignment Order。
24. Service Case 资料要够多（顾客 reference、PO 等）。
25. User Management：可 add email、disable、reset password 等。
26. Mail / New Announcement：To 不用手打要可选、要有 From；Announcement 少了 Category → 补上。
27. Filter & Sort 要按各模块定制（采购选 supplier name、客户选 customer name…），全套系统都要看。
28. Daily Capacity / Total Backlog 等不应跳 Production，要照桌面版（→ 改为进 Planning）。
29. Rack Number 要顺着排 1、2、3…
30. 全套要 Dark Mode 和 Light Mode（手机 + Fold 都要）。
31. Fold：收起=手机版、打开=Fold 版；unfold 要能自己 detect；右边滑动不要松散感。
32. 各种交付：给电话版、给 Fold 版、给 HTML 全文件、给 DC 可编辑源码、打包成一个文件夹。
33. logo 要用我们自己的 logo；Dark mode 下 logo 不见了 → 修（手机 + Fold）。
34. Warehouse 要有 Create Item QR（确认：一直都在，Rack 标签页顶部）。

---

## 三、重要修复记录（过程中处理掉的 bug）

- KPI 大数字溢出导致整页可横向滑动 → 数字缩放 + 不换行省略 + 锁宽。
- 逻辑类一处编辑残留导致全部按钮失效（白色不能按）→ 定位并修复。
- supActions 行残留片段造成解析错误 → 修复。
- Service Case 混入错误字段、fade、[object Object] → 整模块按桌面版重建。
- Dashboard 之前自行加了桌面版没有的内容 → 以你 frontend / 截图为准重建。
- 报表卡片 / 底部操作栏挤歪 → 改 2 列网格 + 缩小图标。
- Dark mode 下 logo 被「防反色」规则误处理变黑/消失 → 让 logo 随主题转白（手机 + Fold）。

---

## 四、说明：原型 vs 后端

这是**前端原型（prototype）**：所有数字、列表、跳转用内置示例数据演示「界面长相 + 交互」，**未连接** Desktop 后端 API。上线时这些按钮接到**与 Desktop 同一套 API**，把示例数据换成真实调用即可——本原型即作为界面与交互规格。

---

*最后更新：2026-06-29*
