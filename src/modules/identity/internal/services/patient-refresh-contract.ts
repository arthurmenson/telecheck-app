import { z } from 'zod';

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.iso.datetime({ precision: 3 });

export const patientRefreshRequestSchema = z.object({ refresh_token: opaque }).strict();
export const patientRefreshKeySchema = id;
export const patientRefreshReplySchema = z
  .object({
    session: z
      .object({
        session_id: id,
        account_id: id,
        created_at: timestamp,
        last_active_at: timestamp,
        expires_at: timestamp,
      })
      .strict(),
    access_token: z.string().min(1).max(4096),
    refresh_token: opaque,
  })
  .strict();

export type PatientRefreshReply = z.infer<typeof patientRefreshReplySchema>;
