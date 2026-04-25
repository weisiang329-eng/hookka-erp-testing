# Documentation Index

This file organizes key documentation so implementation and operations are easy to navigate.

## Start Here
- `README.md` — project overview, local run commands, module map.
- `docs/SETUP.md` — development environment setup and troubleshooting.
- `docs/ARCHITECTURE.md` — current system architecture and extension points.

## Program / Execution
- `docs/PROGRAM-90D-EXECUTION.md` — **active**. 90-day enterprise upgrade plan (CI gates → RBAC/audit → scheduler → SDK → observability). Updates weekly.
- `docs/UPGRADE-CONTROL-BOARD.md` — **active**. Single source of truth for status (Backlog / In Progress / Blocked / Done). Update on every state change.
- `docs/ENTERPRISE-ERP-ARCHITECTURE.md` — target enterprise architecture blueprint (SAP/Oracle reference shape).
- `docs/PROGRAM-EXECUTION.md` — legacy 6-task status snapshot. Superseded by PROGRAM-90D-EXECUTION.md for the upgrade window.
- `docs/REPO-REVIEW-2026-04-24.md` — repository health review and stabilization notes.

## Product / Domain
- `docs/MODULES.md` — module-by-module product reference.
- `docs/API.md` — API endpoint inventory and conventions.
- `docs/DESIGN-SYSTEM.md` — UI tokens and shared component conventions.
- `docs/B-FLOW.md` — production/delivery test flow (B-flow).

## Cloudflare / Deployment / Migration
- `docs/CLOUDFLARE_MIGRATION.md` — Cloudflare migration details.
- `docs/d1-retirement-plan.md` — D1 retirement/migration runbook.

## Known Issues / Temporary Debt
- `docs/KNOWN-ISSUES.md` — known lint/typecheck/runtime debt and rationale.
- `B-ROLLBACK.md` — rollback notes.
