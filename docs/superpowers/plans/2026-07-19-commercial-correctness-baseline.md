# 商业正确性基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure customer-facing price bundles use the canonical quotation engine, protect the default tenant from deletion, and make the current test suite the default pytest target.

**Architecture:** The backend quotation engine remains the single price-calculation authority. `BundlesMixin` will reuse it when producing a company bundle, then remove sensitive source fields. Tenant deletion protection belongs in the store so every API caller receives the same rule. Pytest discovery is constrained declaratively, without moving legacy archive files.

**Tech Stack:** Python 3.13, FastAPI, SQLite, pytest, Node.js test runner.

---

### Task 1: Make company price bundles match the canonical quotation engine

**Files:**
- Modify: `tests/test_backend_v1.py`
- Modify: `backend/smart_quotation/store/bundles.py`

- [ ] **Step 1: Write a failing regression test for a non-default formula**

Add a test that saves a schema-v3 configuration with `face_price * discount_percent / 100 * 0.9`, stores a 100 CNY item with a 50% default discount, builds a company price bundle, decodes its base64 payload, and asserts the bundle's `quote_price` equals `QuotationEngine(store).quote("A")[0]["fields"]["quote_price"]` and equals `"45.0"`.

- [ ] **Step 2: Run the one regression test and verify it fails**

Run: `py -m pytest tests/test_backend_v1.py -q -k company_bundle_uses_canonical_engine`

Expected: FAIL because the bundle currently returns `"50.0"` from its simplified calculator.

- [ ] **Step 3: Replace the duplicate company calculation with the canonical engine**

In `BundlesMixin._desensitize_item_fields`, evaluate a copied item through `QuotationEngine(self).quote_row(...)`, use its resulting fields as the safe bundle source, and then remove every configured sensitive field. Keep the public bundle shape unchanged.

- [ ] **Step 4: Run the regression test and the full Python suite**

Run: `py -m pytest tests/test_backend_v1.py -q -k company_bundle_uses_canonical_engine; py -m pytest tests -q`

Expected: regression passes; full suite has no failures.

### Task 2: Protect the default tenant from destructive deletion

**Files:**
- Modify: `tests/test_multi_tenant.py`
- Modify: `backend/smart_quotation/store/companies.py`
- Modify: `backend/smart_quotation/api/routes_companies.py`

- [ ] **Step 1: Write a failing API regression test**

Create a temporary store and development-mode FastAPI client. Call `DELETE /api/companies/default` with the development admin key and assert HTTP 409, then assert the persisted default company still exists.

- [ ] **Step 2: Run the one regression test and verify it fails**

Run: `py -m pytest tests/test_multi_tenant.py -q -k default_company_cannot_be_deleted`

Expected: FAIL because the endpoint currently returns HTTP 200 and removes the default company record.

- [ ] **Step 3: Add the store-level guard and map it to a conflict response**

Make `delete_company` raise `ValueError("默认公司不能删除")` for `DEFAULT_COMPANY_ID`. In the route, translate that value error to HTTP 409; retain the existing 404 behavior for unknown companies.

- [ ] **Step 4: Run the regression test and the full Python suite**

Run: `py -m pytest tests/test_multi_tenant.py -q -k default_company_cannot_be_deleted; py -m pytest tests -q`

Expected: regression passes; full suite has no failures.

### Task 3: Make current tests the default pytest collection

**Files:**
- Create: `pytest.ini`

- [ ] **Step 1: Add pytest discovery configuration**

Create `pytest.ini` containing:

```ini
[pytest]
testpaths = tests
```

- [ ] **Step 2: Verify root pytest no longer collects archive tests**

Run: `py -m pytest -q`

Expected: 28 passing tests and no collection errors from `_archive/`.

- [ ] **Step 3: Verify JavaScript regression suite remains green**

Run: `node --test tests/*.test.js`

Expected: all JavaScript tests pass.

### Task 4: Record release-path limits for the next approved phase

**Files:**
- Modify: `docs/superpowers/plans/2026-07-19-commercial-correctness-baseline.md`

- [ ] **Step 1: Append the deferred release design decision**

Record that the current publish/sync flow is not transactional because database status and Supabase files are updated independently. The next phase must introduce a versioned release manifest and atomic client pointer before claiming atomic publication.

- [ ] **Step 2: Verify scope stayed surgical**

Run: `git diff --check; git status --short`

Expected: only the files listed in Tasks 1-4 are changed; no commit, push, or sync has occurred.

---

## Deferred: Release Atomicity (P0-2)

**Status:** Documented; implementation deferred to next phase.

**Current behavior:** Publishing is not transactional. `admin/lib/config-api.js:saveConfig` first writes the new config to the SQLite database via `POST /api/config`, then separately uploads `config.json` / `version.json` to Supabase Storage. Price and stock bundles require a separate manual "sync" step (`admin/lib/event-bindings.js`). If any Supabase upload fails after the DB write, the database has already switched to the new published config while clients continue reading stale bundles from Supabase.

**Impact:** Config/bundle version skew. Clients may see a new `config.json` pointing at a `data_revision` that doesn't exist in the uploaded `price.bundle.json`, causing empty or broken quotes.

**Required next-phase design:**
1. Introduce a versioned release manifest (e.g. `releases/{revision}/manifest.json`) containing all artifacts (config, price bundle, stock bundle, version).
2. Upload all artifacts to the versioned path atomically (all-or-nothing).
3. Switch a stable client pointer (`config.json` → current manifest) only after all uploads succeed.
4. On failure, the pointer still references the previous manifest; no partial state is visible.
5. Database `status='published'` should be updated only after the pointer switch succeeds, or in the same logical transaction.

**Why deferred:** This requires changes to the client bundle-loading protocol (new manifest path), the admin publish flow (multi-file atomic upload with rollback), and the Supabase URL convention. It is a behavioral change to the release path and should be designed and confirmed before implementation.
