/**
 * Unit tests for parseTenantHostOverrides (staging/preview hostname → tenant
 * aliasing; see tenant-context.ts). DB-free: pure parsing + validation.
 *
 * Contract under test:
 *   §1 empty/undefined input → no overrides
 *   §2 valid pairs clone canonical entries by tenant id (hostname lowercased)
 *   §3 unknown tenant id → boot-time throw (fail-fast, never silent fallthrough)
 *   §4 malformed pair → boot-time throw
 *   §5 overrides cannot mint tenants — cloned entry carries the canonical
 *      tenantId / countryOfCare / consumerDba unchanged
 */
import { describe, expect, it, vi } from 'vitest';

// tenant-context imports db.js, whose transitive config.js import validates
// process.env at module load — mock it out (parse function under test is
// pure and touches neither).
vi.mock('./db.js', () => ({ withConnection: vi.fn() }));

import { parseTenantHostOverrides } from './tenant-context.js';

describe('parseTenantHostOverrides §1 — empty input', () => {
  it('returns no overrides for undefined', () => {
    expect(parseTenantHostOverrides(undefined)).toEqual({});
  });

  it('returns no overrides for blank string', () => {
    expect(parseTenantHostOverrides('   ')).toEqual({});
  });
});

describe('parseTenantHostOverrides §2 — valid pairs', () => {
  it('aliases a single staging host to Telecheck-US', () => {
    const o = parseTenantHostOverrides('87.99.159.214.sslip.io=Telecheck-US');
    expect(Object.keys(o)).toEqual(['87.99.159.214.sslip.io']);
    expect(o['87.99.159.214.sslip.io']?.tenantId).toBe('Telecheck-US');
  });

  it('parses multiple pairs and lowercases hostnames', () => {
    const o = parseTenantHostOverrides(
      'Stage.Example.io=Telecheck-US, ghana.stage.example.io=Telecheck-Ghana',
    );
    expect(o['stage.example.io']?.tenantId).toBe('Telecheck-US');
    expect(o['ghana.stage.example.io']?.tenantId).toBe('Telecheck-Ghana');
  });

  it('tolerates trailing commas and stray whitespace', () => {
    const o = parseTenantHostOverrides('a.example=Telecheck-US, ,');
    expect(Object.keys(o)).toEqual(['a.example']);
  });
});

describe('parseTenantHostOverrides §3 — unknown tenant id fails fast', () => {
  it('throws on a tenant id outside the canonical registry', () => {
    expect(() => parseTenantHostOverrides('a.example=Telecheck-Mars')).toThrow(
      /unknown tenant id "Telecheck-Mars"/,
    );
  });

  it('throws on bare-Heros identifier (forbidden alias, C3 brand structure)', () => {
    expect(() => parseTenantHostOverrides('a.example=Heros')).toThrow(/unknown tenant id/);
  });
});

describe('parseTenantHostOverrides §4 — malformed pairs fail fast', () => {
  it.each(['no-equals-sign', '=Telecheck-US', 'host.example='])('throws on "%s"', (pair) => {
    expect(() => parseTenantHostOverrides(pair)).toThrow(/malformed pair|expected hostname/);
  });
});

describe('parseTenantHostOverrides §5 — aliases cannot mutate canonical identity', () => {
  it('cloned Ghana entry carries canonical countryOfCare + consumerDba', () => {
    const o = parseTenantHostOverrides('gh.stage.example=Telecheck-Ghana');
    const entry = o['gh.stage.example'];
    expect(entry?.countryOfCare).toBe('GH');
    expect(entry?.consumerDba).toBe('Heros Health Ghana');
    expect(entry?.legalEntity).toBe('Telecheck-Ghana Ltd.');
  });
});
