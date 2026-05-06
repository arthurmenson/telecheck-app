/**
 * consult-event-repo.ts — append-only access to the `consult_events`
 * table per migration 020 / SI-005 placeholder schema.
 *
 * Append-only at the application layer: this module exposes only INSERT
 * + SELECT, no UPDATE or DELETE. The lifecycle history of a consult is
 * a tamper-resistant sequence of state-transition events (complements
 * I-003 audit chain integrity for the Consult lifecycle specifically).
 *
 * Tenant-scoped (RLS enforced via `tenant_isolation` policy + the
 * composite FK `consult_events_tenant_consult_fk` from migration 020
 * inline / migration 021 ALTER — preventing cross-tenant event-history
 * binding even if the attacker knows a consult_id from another tenant).
 *
 * This repo is INTERNAL to the async-consult module per ADR-001.
 *
 * Spec references:
 *   - migrations/020_async_consult.sql (placeholder schema)
 *   - SI-005 (Consult / ConsultEvent schema gap; resume gate)
 *   - I-003 (audit append-only — this repo applies the same discipline
 *     to ConsultEvent rows by exposing only INSERT)
 *   - I-023 (tenant scoping; 3-layer enforcement — RLS at this layer)
 */

import type { DbClient } from '../../../../lib/db.js';
import { withTenantBoundConnection } from '../../../../lib/db.js';
import {
  asConsultEventId,
  type ConsultEvent,
  type ConsultEventId,
  type ConsultEventType,
  type ConsultId,
  type ConsultState,
} from '../types.js';

const CONSULT_EVENT_COLUMNS = `
  id          AS consult_event_id,
  consult_id,
  tenant_id,
  event_type,
  from_state,
  to_state,
  actor_id,
  metadata,
  created_at::text AS created_at
`;

interface ConsultEventRow {
  consult_event_id: string;
  consult_id: string;
  tenant_id: string;
  event_type: ConsultEventType;
  from_state: ConsultState | null;
  to_state: ConsultState | null;
  actor_id: string | null;
  metadata: unknown;
  created_at: string;
}

function rowToConsultEvent(row: ConsultEventRow): ConsultEvent {
  return {
    consult_event_id: asConsultEventId(row.consult_event_id),
    consult_id: row.consult_id as ConsultId,
    tenant_id: row.tenant_id,
    event_type: row.event_type,
    from_state: row.from_state,
    to_state: row.to_state,
    actor_id: row.actor_id,
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// INSERT — record a state transition event
// ---------------------------------------------------------------------------

export interface CreateStateTransitionEventInput {
  consult_event_id: ConsultEventId;
  consult_id: ConsultId;
  tenant_id: string;
  from_state: ConsultState | null;
  to_state: ConsultState;
  actor_id: string | null;
  metadata?: unknown;
}

/**
 * Record a state-transition event on a consult. Append-only.
 *
 * The composite FK `consult_events_tenant_consult_fk` enforces at the
 * DB layer that the consult_id resolves to a consult in the SAME tenant
 * — preventing cross-tenant event-history binding even if the caller
 * knows a consult_id from another tenant. Codex async-consult-r1 HIGH
 * closure 2026-05-05.
 */
export async function createStateTransitionEvent(
  input: CreateStateTransitionEventInput,
  externalTx?: DbClient,
): Promise<ConsultEvent> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<ConsultEvent>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<ConsultEvent>) =>
        withTenantBoundConnection(input.tenant_id, fn);
  return runner(async (client) => {
    const result = await client.query<ConsultEventRow>(
      `INSERT INTO consult_events (
         id, consult_id, tenant_id, event_type, from_state, to_state, actor_id, metadata
       ) VALUES ($1, $2, $3, 'state_transition', $4, $5, $6, $7::jsonb)
       RETURNING ${CONSULT_EVENT_COLUMNS}`,
      [
        input.consult_event_id,
        input.consult_id,
        input.tenant_id,
        input.from_state,
        input.to_state,
        input.actor_id,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('createStateTransitionEvent: INSERT returned no row');
    }
    return rowToConsultEvent(row);
  });
}

// ---------------------------------------------------------------------------
// SELECT — list events for a consult (tenant-scoped via RLS + composite FK)
// ---------------------------------------------------------------------------

/**
 * List the event history for a consult, ordered by created_at ascending
 * (oldest first; canonical lifecycle replay order).
 *
 * Cross-tenant note: the composite FK ensures the parent consult is in
 * the same tenant, AND the RLS policy on consult_events filters by
 * `tenant_id = current_tenant_id()`. Two layers of enforcement — even
 * if a consult_id from another tenant is supplied, this returns empty.
 */
export async function listConsultEvents(
  tenantId: string,
  consultId: ConsultId,
  externalTx?: DbClient,
): Promise<ConsultEvent[]> {
  const runner = externalTx
    ? (fn: (client: DbClient) => Promise<ConsultEvent[]>) => fn(externalTx)
    : (fn: (client: DbClient) => Promise<ConsultEvent[]>) =>
        withTenantBoundConnection(tenantId, fn);
  return runner(async (client) => {
    const result = await client.query<ConsultEventRow>(
      `SELECT ${CONSULT_EVENT_COLUMNS} FROM consult_events
        WHERE consult_id = $1
        ORDER BY created_at ASC, id ASC`,
      [consultId],
    );
    return result.rows.map(rowToConsultEvent);
  });
}
