# Patient crisis status after reload

The canonical SI-022 patient history endpoint, GET /v1/crisis/mine, now reads
the authenticated patient's durable crisis events. Crisis admission deliberately
runs before an ordinary consultation URL is validated, so this history does not
invent a case association. The read remains available independently of payment,
form validity and current care-consent choices.

An offset-only query returns up to25 events, newest detection first, with
crisis_event_id, detected_at, current_state and nullable state_changed_at.
offset, limit and has_more support pagination. active_event contains the latest
event whose actual lifecycle is not resolved, even when that event is outside
the requested history page. A missing lifecycle is exposed as unknown rather
than guessed resolved. No trigger text, clinical category, patient/account ID,
provider delivery metadata or encrypted payload is exposed.

An unresolved event is a record state, not a new clinical assessment, patient
risk classification, contact promise or clinician response. The patient cannot
resolve an event through this endpoint. Returning resolved represents a durable
lifecycle record; it does not make an independent clinical claim about the
patient's present condition. Reading history does not authorize ordinary clinical
mutation, AI execution or suppression of a new crisis input.

The private Crisis owner derives the real patient/session/tenant/country and
checks that authority before and after its database snapshot. No caller-selected
subject is accepted. Server read deadlines and separate bounded connections match
SI-026. Configured local resources are resolved separately; a resource outage
returns resources.status unavailable and never an invented number. Live identity
is checked again after that lookup before disclosing any history.

An unavailable or unauthenticated history read is an error, never an empty
successful history or an automatically cleared safety interruption. No client
storage of crisis IDs, answers or clinical text is required for recovery.
Patient frontend integration must preserve that distinction and display durable
status when care is reopened. This backend increment alone does not claim that
frontend integration or escalation delivery is complete.

Migration097 adds a function only; ordinary app access uses the existing narrow
crisis_care_patient role. Rollback removes that read function and preserves
canonical events, admission proof, lifecycle, audit and pending escalation.
