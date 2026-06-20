## Summary

- 

## Development mode

Choose the smallest safe mode from `docs/AI-DEVELOPMENT-MODES.md`:

- [ ] Fast lane — small UI/copy/display change, no API/DB/business lifecycle impact
- [ ] Focused change — normal single-module feature/bugfix
- [ ] Flow change — status/business flow across modules
- [ ] Deep review — DB/security/accounting/payroll/inventory/migration/high-risk change

## Impact check

- Frontend/pages/components:
- Backend/API routes:
- Database/migrations:
- Business flow/status/accounting/inventory/payroll:
- Documents/PDF/email/export:
- Permissions/RBAC/tenant isolation:

## UI/data/document standards

If this PR touches grids, filters, numeric inputs, typography, or documents, confirm:

- [ ] DataGrid columns follow `docs/UI-DATA-DOCUMENT-STANDARDS.md`
- [ ] Numeric inputs preserve blank/null vs zero correctly
- [ ] Money stays sen in API/DB and formats only at UI/document boundaries
- [ ] Typography uses the shared frontend/PDF standards
- [ ] PDFs use shared letterhead/footer/table helpers where applicable

## Staging / rollout

- [ ] Not needed — docs/test-only or very low risk
- [ ] Canary/preview check required before merge
- [ ] Direct production acceptable — low risk, reversible, and rollback notes included if needed
- [ ] Staging branch check required before production because risk is high
- [ ] Rollback notes included below

Rollback notes:

- 

## Testing

- [ ] `git diff --check`
- [ ] Relevant targeted tests:
- [ ] `npm test`
- [ ] `npm run build:strict`
- [ ] Manual/browser check:
- [ ] Screenshot attached for visible UI changes
