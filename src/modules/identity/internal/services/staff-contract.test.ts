import { describe, expect, it } from 'vitest';

import {
  StaffEnrollmentSchema,
  StaffRosterQuerySchema,
  StaffEnrollmentReceiptSchema,
} from './staff-contract.js';

const valid = {
  first_name: 'Synthetic',
  last_name: 'Clinician',
  phone_e164: '+12025550191',
  email: null,
};
describe('staff enrollment contract', () => {
  it('requires real contact and names without inventing patient demographics', () => {
    expect(StaffEnrollmentSchema.parse(valid)).toEqual(valid);
    expect(
      StaffEnrollmentSchema.parse({ ...valid, email: 'synthetic@example.invalid' }).email,
    ).toBe('synthetic@example.invalid');
  });
  it.each([
    'tenant_id',
    'account_id',
    'account_type',
    'status',
    'verified',
    'license_number',
    'date_of_birth',
    'password',
  ])('rejects caller authority or unrelated %s', (field) => {
    expect(StaffEnrollmentSchema.safeParse({ ...valid, [field]: 'injected' }).success).toBe(false);
  });
  it.each([
    { first_name: '' },
    { first_name: ' Someone' },
    { last_name: 'A\u0000B' },
    { last_name: 'A\ud800B' },
    { last_name: 'x'.repeat(101) },
    { phone_e164: '2025550191' },
    { phone_e164: '+02025550191' },
    { email: 'SYNTHETIC@example.invalid' },
    { email: 'missing-at' },
  ])('rejects malformed bounded identifiers %j', (change) => {
    expect(StaffEnrollmentSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
  it.each(['-1', '1.5', '1e2', '01', ' 1', '10001', 'NaN'])('rejects pagination %s', (offset) => {
    expect(StaffRosterQuerySchema.safeParse({ offset }).success).toBe(false);
  });
  it('does not allow a receipt to imply activation or licensing', () => {
    const receipt = { account_id: '01K00000000000000000000000', status: 'pending_verification' };
    expect(StaffEnrollmentReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(StaffEnrollmentReceiptSchema.safeParse({ ...receipt, status: 'active' }).success).toBe(
      false,
    );
    expect(
      StaffEnrollmentReceiptSchema.safeParse({ ...receipt, license_verified: true }).success,
    ).toBe(false);
  });
});
