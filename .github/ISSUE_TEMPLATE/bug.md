---
name: Bug report
about: Report a defect in the Telecheck app codebase
title: "[bug] "
labels: ["bug", "triage"]
assignees: []
---

<!--
Telecheck bug template.

DO NOT include PHI (patient identifiers, names, DOB, MRN, lab values, message contents, etc.).
If repro requires PHI-bearing data, scrub it before posting and note the scrub in "Repro steps".
For incidents involving suspected PHI exposure, contact the Privacy Officer first
(see SECURITY.md) — do not file a public bug.
-->

## Summary

<!-- One sentence: what's broken. -->

## Repro steps

1.
2.
3.

## Expected behavior

## Actual behavior

## Tenant context

<!-- Which operating tenant? Bare `Heros` is forbidden as a tenant identifier. -->

- Operating tenant: <!-- Telecheck-US | Telecheck-Ghana | both | tenant-agnostic -->
- Consumer DBA surface (if patient-facing): <!-- Heros Health | Heros Health Ghana | n/a -->
- Country of care: <!-- US | GH | n/a -->

## Invariant violated (if any)

<!-- See Contracts Pack v5.2 INVARIANTS.md. Examples: I-003 audit append-only, I-019 crisis detection, I-023 tenant isolation, I-025 error envelope tenant-blind, I-027 audit envelope tenant_id, I-029 research export gate, I-012 reject-unless prescribing. -->

## Spec reference

<!-- Cite the spec artifact whose contract this bug violates. If you can't find one, this might be a Spec Issue (use the spec-issue.md template instead). -->

- Slice PRD / ADR / OpenAPI / State Machine / Contracts Pack file:
- Section / line:

## Environment

- Node version:
- Postgres version:
- Branch / commit:

## Logs / stack trace

<!-- Scrub PHI before pasting. -->

```
```
