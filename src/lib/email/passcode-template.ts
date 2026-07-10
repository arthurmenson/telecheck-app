/**
 * email/passcode-template.ts — renders the subject + plain-text + HTML body
 * for a one-time passcode email. Provider-independent (both the Resend sender
 * and any future sender render through this).
 *
 * Copy rules (Design Implementation Contract v1.1):
 *   - Honest, literal copy; no hedge-slop, no aspirational phrasing.
 *   - No emoji (cross-market reliability rule).
 *   - Brand = consumer DBA; iris (#6E5BD6) is reserved for AI-authored content
 *     and is deliberately NOT used here (this is a transactional system email).
 */

import type { PasscodeMessage } from './types.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPasscodeEmail(msg: PasscodeMessage): RenderedEmail {
  const brand = msg.consumerDba;
  const isRecovery = msg.purpose === 'pin_recovery';
  const purposeLine = isRecovery
    ? `Use this code to reset your ${brand} PIN.`
    : `Use this code to verify your email and finish setting up your ${brand} account.`;
  const subject = isRecovery
    ? `Your ${brand} PIN reset code`
    : `Your ${brand} verification code`;

  // Code is validated as 6 digits upstream; escape defensively anyway.
  const code = escapeHtml(msg.code);
  const safeBrand = escapeHtml(brand);
  const ttl = msg.ttlMinutes;

  const text = [
    `${purposeLine}`,
    ``,
    `Code: ${msg.code}`,
    ``,
    `This code expires in ${ttl} minutes. Enter it in the app to continue.`,
    ``,
    `If you didn't request this, you can ignore this email — no changes will be made.`,
    ``,
    `— ${brand}`,
  ].join('\n');

  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#12211d;">`,
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">${escapeHtml(purposeLine)}</p>`,
    `<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#eaf5f2;border-radius:12px;padding:18px 0;text-align:center;color:#0f3d33;">${code}</div>`,
    `<p style="font-size:13px;line-height:1.5;color:#4a5c57;margin:20px 0 0;">This code expires in ${ttl} minutes. Enter it in the app to continue.</p>`,
    `<p style="font-size:13px;line-height:1.5;color:#4a5c57;margin:12px 0 0;">If you didn't request this, you can ignore this email — no changes will be made.</p>`,
    `<p style="font-size:13px;color:#4a5c57;margin:24px 0 0;">— ${safeBrand}</p>`,
    `</div>`,
  ].join('');

  return { subject, text, html };
}
