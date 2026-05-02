---
name: Spec Issue (SI / DSI)
about: Flag a spec contradiction, ambiguity, or design-spec gap per EHBG §12
title: "[SI] "
labels: ["spec-issue", "triage"]
assignees: []
---

<!--
Spec Issue (SI) / Design Spec Issue (DSI) escalation per Telecheck_Engineering_Handoff_Build_Guide_v1_3.md §12.

Use this when implementation runs into a spec contradiction or ambiguity. The hard rule is:
"Do NOT silently fork." When a slice PRD disagrees with CDM / OpenAPI / State Machines, OPEN
THIS ISSUE — do not edit the engineering spec to match the slice and do not bend implementation
to a guess.

Source-of-truth hierarchy (top wins on conflict, per Contracts Pack v5.2 SOURCE_OF_TRUTH):
  1. Platform Invariants
  2. ADRs
  3. Cross-cutting contracts (Contracts Pack v5.2)
  4. Master Platform PRD v1.10
  5. Slice PRDs
  6. Engineering specs (CDM v1.2, State Machines v1.1, OpenAPI v0.2, System Architecture v1.2)
  7. Experience specs (DIC v1.1)
  8. Operations
-->

## Spec file involved

<!-- Full filename(s) from the spec corpus (arthurmenson/telecheckONE). -->

- Primary:
- Secondary (if cross-doc contradiction):

## Section / line

<!-- Anchor precisely. "Section 10.5" beats "somewhere in the PRD". Quote the exact passage. -->

> <!-- paste the contradictory or ambiguous passage here -->

## Contradiction or ambiguity

<!-- What's wrong? Pick one and elaborate. -->

- [ ] Direct contradiction between two spec docs (which two?)
- [ ] Ambiguity (multiple defensible interpretations; pick one and ship is unsafe)
- [ ] Gap (the spec is silent on a case that arises during implementation)
- [ ] Design-spec mismatch (DSI — design system says X, slice PRD says Y)

## Proposed resolution

<!-- Cite which doc should be updated, in which direction, per the source-of-truth hierarchy. -->

## Downstream impact

<!-- Which slices / modules block on this resolution? Be specific. -->

- Slices affected:
- Modules affected:
- Blocks first slice (Forms/Intake v2.1)? <!-- yes/no -->

## Action

- [ ] Update spec (raise PR in `arthurmenson/telecheckONE`)
- [ ] Update code (raise PR in this repo once spec settles)
- [ ] Both (spec PR first, then code PR)

## Owner

<!-- Per EHBG §12: SI escalates to Engineering Lead by default; DSI escalates to Design Lead. -->

- Escalation owner:
