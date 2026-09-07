import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (s) =>
      s === s.trim() &&
      Array.from(s).every((character) => {
        const point = character.codePointAt(0)!;
        return (
          point > 31 && !(point >= 127 && point <= 159) && !(point >= 0xd800 && point <= 0xdfff)
        );
      }),
  );
export const StaffEnrollmentSchema = z
  .object({
    first_name: name,
    last_name: name,
    phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/u),
    email: z
      .string()
      .email()
      .max(254)
      .refine((s) => s === s.toLowerCase())
      .nullable(),
  })
  .strict();
export const StaffEnrollmentReceiptSchema = z
  .object({
    account_id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
    status: z.literal('pending_verification'),
  })
  .strict();
export const StaffRosterQuerySchema = z
  .object({
    offset: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,4})$/u)
      .transform(Number)
      .refine((v) => v <= 10000)
      .optional(),
  })
  .strict();
export const StaffRosterSchema = z
  .object({
    offset: z.number().int().min(0).max(10000),
    limit: z.literal(25),
    has_more: z.boolean(),
    items: z
      .array(
        z
          .object({
            account_id: StaffEnrollmentReceiptSchema.shape.account_id,
            first_name: name,
            last_name: name,
            status: z.enum(['pending_verification', 'active', 'suspended', 'archived']),
            enrolled_at: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .max(25),
  })
  .strict();
