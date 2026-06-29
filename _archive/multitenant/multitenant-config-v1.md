# Multi-tenant GUI Configuration V1

This repository now includes a runnable v1 of the multi-tenant configuration-driven quotation platform.

## Run

```powershell
py -m pip install -r requirements.txt
py -m backend.smart_quotation
```

Open:

- API health: `http://127.0.0.1:8001/api/health`
- GUI configuration center: `http://127.0.0.1:8001/admin/`

## What Is Implemented

**Backend**

- FastAPI app factory with company-scoped endpoints.
- SQLite-backed storage for companies, published/draft configs, quotation items, and audit events.
- Schema v2 to v3 config migration.
- JSON and YAML config import/export.
- Hot config reload by invalidating the per-company config cache on publish.
- Safe rule DSL for discounts and safe formula evaluation using Python AST whitelisting.
- Plugin registry and ERPNext adapter interfaces reserved for future provider implementations.
- Config version history listing and one-click rollback.
- Data statistics endpoint (count + active revision).
- Audit event log with per-company scoping.
- Company listing endpoint.

**GUI Configuration Center (admin/)**

- Company section: create company, list all companies with one-click switch.
- Fields section: add/edit/remove fields, Excel alias mapping.
- Rules section: condition + action rule builder.
- Copy template section: configurable copy columns with prefix/suffix.
- **Page Display section (new)**: app title, result layout (identity/metrics/chips/details), pricing formula, decimal places, rounding mode and integer threshold — all GUI-driven, no JSON editing required.
- **Data Import section (upgraded)**: tabbed UI with JSON input and field-mapping preview; data statistics bar shows current count and revision.
- ERPNext section: connection settings and test.
- Publish section: save draft, publish, export JSON/YAML, import JSON.
- **Version History section (new)**: lists all revisions with status badges; one-click rollback to any previous revision.
- **Audit Log section (new)**: shows last 50 audit events scoped to the active company.

## API Reference

### Companies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/companies` | List all companies |
| `POST` | `/api/companies` | Create a company |

### Config

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/companies/{id}/config` | Get active (published) config |
| `POST` | `/api/companies/{id}/config` | Save config (draft or published) |
| `GET` | `/api/companies/{id}/configs` | List all config versions |
| `POST` | `/api/companies/{id}/config/{revision}/publish` | Rollback: publish a previous revision |
| `GET` | `/api/companies/{id}/config/{revision}/export` | Export config as JSON or YAML |
| `POST` | `/api/companies/{id}/config/import` | Import config from JSON or YAML |

### Data

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/companies/{id}/items` | Replace item data for a revision |
| `POST` | `/api/companies/{id}/items/upload` | Upload file import; `multipart/form-data`; `?write=false` preview, `?write=true` write |
| `DELETE` | `/api/companies/{id}/items/rollback` | Roll back the most recent import by `data_revision`, deleting all rows for that revision |
| `GET` | `/api/companies/{id}/items/stats` | Data statistics (count + revision) |

### Quotation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/companies/{id}/quote?q=...` | Run quotation query |

### Audit

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/companies/{id}/audit` | Audit event log (last 50) |

### ERPNext (reserved)

### Customer Portal

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/customer/login` | Customer login |
| `GET` | `/api/customer/me` | Get customer profile |
| `GET` | `/api/customer/config` | Get config (desensitized for company accounts) |
| `POST` | `/api/stock-query` | Mitsubishi stock query (no auth required) |

## Verification

```powershell
py -m unittest tests.test_backend_v1 tests.test_admin_gui -v
```

Test coverage:

- v2 config migration to v3
- Rule priority, rounding, copy output
- Company data isolation (multi-tenant)
- Config cache invalidation on publish
- **Config version rollback**
- **Version history listing**
- **Data statistics**
- **Company listing**
- **Audit log recording**
- **Config validation: missing default rule, forbidden formula, unknown action type**
- GUI: all navigation sections present, all render/API functions present

The existing Node tests still belong to the static frontend. In this environment, the bundled `node.exe` is blocked by Windows permissions, so Python verification is the reliable baseline for this implementation.

## Notes

- `httpx` is required for `fastapi.testclient` (used in `test_backend_api_and_extensions.py`). It is not available via pip in the current environment due to SSL restrictions; those tests can be run when network access is available.
- All ERPNext sync and push adapters remain reserved stubs — they do not block standalone operation.
- User authentication and customer management are implemented (see `docs/multitenant-config-v1-zh.md` for details). The GUI admin panel uses API key Bearer auth; the customer portal uses session tokens.
- **2026-06-28**: Discount popup refactored from hardcoded 4 brands to dynamic rendering based on `discount_rules`. Configuration publish now auto-deploys to Supabase Storage. Mitsubishi stock query integrated: `POST /api/stock-query` (no auth, QueryEngine GWT-RPC). Customer portal with auth (admin/company roles, per-customer pricing, tax rate, profit margin). See `docs/multitenant-config-v1-zh.md` for full Chinese technical documentation.
