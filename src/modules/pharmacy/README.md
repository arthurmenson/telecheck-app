# Pharmacy module — `src/modules/pharmacy/`

> ⛔ **BLOCKED ON SI-001** — schema authoring paused per `docs/SI-001-MedicationRequest-Schema-Gap.md`.

This directory is a **skeleton** at v0.1. It establishes the module
boundary (per ADR-001 modular monolith) and the Fastify plugin wiring
so app-level registration is stable; **schema, repos, services, and
HTTP handlers wait for SI-001 closure** (Promotion Ledger P-011 in the
spec corpus).

## What's in here at v0.1

- `index.ts` — public-interface re-exports (branded IDs + plugin)
- `plugin.ts` — Fastify plugin shell registering `/v0/pharmacy`
- `routes.ts` — only `/health` mounted; explicit BLOCKED state in response
- `internal/types.ts` — branded IDs only (`MedicationRequestId`, `RefillId`,
  `DispensingId`, `ShipmentId`, `ProductCatalogId`); NO row-shape interfaces

## What's NOT in here (waits for SI-001 closure)

- Migrations (no `medication_requests`, `refills`, `dispensing`, `shipments`,
  `product_catalog` tables yet)
- Row-shape interfaces in `internal/types.ts`
- Repositories (`internal/repositories/medication-request-repo.ts`, etc.)
- Services (`internal/services/medication-request-service.ts`, etc.)
- HTTP handlers (`internal/handlers/medication-requests.ts`, etc.)
- Audit emitters (`audit.ts`)
- Domain-event emitters (`events.ts`)
- Real route surface (POST `/prescriptions`, POST `/refills`, etc.)

## Resume path when SI-001 closes

1. Pull spec corpus; verify CDM v1.2 §4.16 MedicationRequest is now expanded
   AND State Machines v1.1 §19 + AUDIT_EVENTS v5.2 + DOMAIN_EVENTS v5.2
   carry the canonical entries.
2. Author migration `020_medication_requests.sql` (and follow-on migrations
   for refills, dispensing, shipment, product_catalog) per CDM §4.
3. Add row-shape interfaces in `internal/types.ts`.
4. Build out repos → services → HTTP handlers, mirroring Slice 3 pattern
   (consent module).
5. Wire audit + domain-event emission per the established
   `{slice}AuditPlaceholder()` + same-tx outbox pattern.
6. Author full test layer (schema, repo, service, HTTP, cross-tenant,
   I-003 audit chain, idempotency replay, domain-events outbox-landing).
7. Update `docs/SI-001-MedicationRequest-Schema-Gap.md` to mark Step 2
   complete; update `PHARMACY_SLICE_STATUS_*.md`.

Estimated: 30–40 commits to reach Slice 4 implementation-complete after
SI-001 closes.

## References

- Pharmacy + Refill Slice PRD v2.1 (`telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Pharmacy_Refill_Slice_PRD_v2_1.md`)
- CDM v1.2 §3.5 entity inventory + §4 schema gap (this is what SI-001 closes)
- EHBG §10b Sprint 4 (weeks 9-10) — original sprint target for this work
- `docs/SI-001-MedicationRequest-Schema-Gap.md` — the blocker
- `docs/PHARMACY_SLICE_STATUS_2026-05-05.md` (forthcoming) — slice status doc
