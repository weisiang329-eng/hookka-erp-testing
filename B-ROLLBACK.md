# B 版本回滚指南

如果 `/production-b` 或 `/delivery-b` 跑不通，想完全回到改造前的状态，按下面步骤一次性清除 B 版本所有痕迹。A 版本（`/production`、`/delivery`）完全不受影响。

## 方法 1：Git 回滚（推荐，如果提交过）

```bash
cd C:/Users/User/Desktop/hookka-erp-vite
git reset --hard before-sticker-flow-v1    # 需要先打 tag
# 或
git checkout main  # 如果改动都在 feat/sticker-flow-v1 分支上
```

**注意**：目前还没打 tag 也没换分支，要么现在补打（见末尾），要么用下面的"方法 2"手动删除。

## 方法 2：手动删除 B（不依赖 git）

### 要删的文件 & 目录

```
src/pages/production-b/         整个目录
src/pages/delivery-b/           整个目录
src/lib/spec-pool.ts            新建文件
src/lib/batch-identity.ts       新建文件（如果确定不要保留）
B-ROLLBACK.md                   本文件
```

删除命令（在项目根目录跑）：
```bash
rm -rf src/pages/production-b src/pages/delivery-b
rm -f src/lib/spec-pool.ts src/lib/batch-identity.ts B-ROLLBACK.md
```

### 要改回的文件

#### 1. `src/router.tsx`
删除这两段（搜 `ProductionB` 和 `DeliveryB` 就能找到）：

- 顶部 import 块：
  ```ts
  // Production B (new sticker flow — batch/pool/FG identity)
  const ProductionB = lazy(() => import('./pages/production-b'))
  const ProductionBDetail = lazy(() => import('./pages/production-b/detail'))
  const DepartmentBDetail = lazy(() => import('./pages/production-b/department'))
  const ProductionBScan = lazy(() => import('./pages/production-b/scan'))
  const FGScanB = lazy(() => import('./pages/production-b/fg-scan'))

  // Delivery B (new DO Master QR + sign-all flow)
  const DeliveryB = lazy(() => import('./pages/delivery-b'))
  const DeliveryBDetail = lazy(() => import('./pages/delivery-b/detail'))
  ```

- 路由注册块：
  ```ts
  // Production B (sticker flow experimental)
  { path: '/production-b', element: <S><ProductionB /></S> },
  { path: '/production-b/:id', element: <S><ProductionBDetail /></S> },
  { path: '/production-b/department/:code', element: <S><DepartmentBDetail /></S> },
  { path: '/production-b/scan', element: <S><ProductionBScan /></S> },
  { path: '/production-b/fg-scan', element: <S><FGScanB /></S> },

  // Delivery B (master QR experimental)
  { path: '/delivery-b', element: <S><DeliveryB /></S> },
  { path: '/delivery-b/:id', element: <S><DeliveryBDetail /></S> },
  ```

#### 2. `src/components/layout/sidebar.tsx`

- 删除 `FlaskConical` 这个 icon import
- 删除 `{ name: "Delivery Order B", href: "/delivery-b", icon: FlaskConical }` 这一行
- 删除 `{ name: "Production B", href: "/production-b", icon: FlaskConical }` 这一行
- 删除 `isItemActive` 里的 `/production-b` 和 `/delivery-b` 两块 if
- 把 `/production` 和 `/delivery` 的 if 里末尾 `&& !pathname.startsWith("/production-b")` / `/delivery-b` 去掉

#### 3. `src/types/index.ts`

把 `DeliveryStatus` 改回原版：
```ts
// 现在
export type DeliveryStatus = "DRAFT" | "LOADED" | "DISPATCHED" | "IN_TRANSIT" | "SIGNED" | "DELIVERED" | "INVOICED" | "CANCELLED";
// 改回
export type DeliveryStatus = "DRAFT" | "LOADED" | "IN_TRANSIT" | "DELIVERED" | "INVOICED" | "CANCELLED";
```

#### 4. `src/lib/mock-data.ts`

- `FGUnitStatus` union 把 `"PENDING_UPHOLSTERY"` 和 `"UPHOLSTERED"` 删掉
- `FGUnit` interface 删掉 "B-flow extensions" 注释下的所有字段（batchId, sourcePieceIndex, sourceSlotIndex, upholsteredBy, upholsteredByName, upholsteredAt, doId, scanHistory）
- `FGScanEvent` interface 删掉
- `DeliveryOrder` type 删掉 "B-flow extensions" 注释下的所有字段（doQrCode, fgUnitIds, signedAt, signedByWorkerId, signedByWorkerName）

### 验证

```bash
npx tsc --noEmit   # 应该 0 错误
npm run dev        # A 版本正常运行
```

## 影响范围确认（哪些文件没改 → 绝对安全）

✅ `src/pages/production/` 原版 — 未改一行
✅ `src/pages/delivery/` 原版 — 未改一行
✅ 所有 `src/api/routes/*.ts` — 未改（B 还没有自己的 API）
✅ 数据库/localStorage — 未改（mock data in-memory，重启即重置）
✅ `src/lib/mock-data.ts` 的 A 相关字段 — 只增不改

## 如果想保留 B 的脚手架但不要数据模型改动

只需要恢复 `types/index.ts` 和 `mock-data.ts` 两个文件的 B 字段删除，`/production-b` 和 `/delivery-b` 页面仍然跑（因为目前它们还是 A 的内容拷贝）。

---

## 额外：补打 Git Tag（推荐立即做）

现在就打一个 tag 记录"B 脚手架 + Phase 1 数据模型完成"状态，万一后面任意步骤失败都能一键回到这里：

```bash
cd C:/Users/User/Desktop/hookka-erp-vite
git add .
git commit -m "B scaffold + Phase 1 data model (pre-API)"
git tag b-phase-1-complete
```

规格仓库同样：
```bash
cd C:/Users/User/Desktop/hookka-erp-spec
git add .
git commit -m "ADR-0001 sticker identity flow"
git tag b-phase-1-complete
```
