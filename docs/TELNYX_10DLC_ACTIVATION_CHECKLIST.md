# Telnyx 10DLC Activation Checklist — Heros Health SMS OTP

**Purpose:** complete the US A2P 10DLC registration that unblocks real phone-OTP
SMS delivery on staging. Everything on the code + server side is already done
(see [SI-SMS-DELIVERY-PROVIDER](./SI-SMS-DELIVERY-PROVIDER.md), Addenda 355–357):
the Telnyx sender is merged + deployed, the API key + number are staged in the
VPS secret store, and `SMS_PROVIDER=noop` is the only thing keeping it inert.
**These steps are the operator/portal work only you can do.** When they're done,
activation is a ~2-minute config flip on the engineering side.

> **Why this is required:** US mobile carriers (T-Mobile, AT&T, Verizon) block or
> heavily filter application-to-person (A2P) traffic sent from unregistered
> 10-digit long codes. Registration ties your business (a "brand") to a declared
> use case (a "campaign") in The Campaign Registry (TCR). Without it, OTP texts
> silently fail at the carrier.

---

## Your account values (fill the blanks as you go)

| Item | Value |
|---|---|
| Telnyx number | `+13468450373` (Houston 346; SMS/MMS-capable, A2P) |
| Existing messaging profile | `heros-console-messaging` (`40019f2e-b47b-4318-9e95-7954a1f528b0`) |
| Brand ID (after Step 1) | `__________` |
| Campaign ID (after Step 2) | `__________` |
| Messaging profile used for OTP | `__________` (reuse heros-console-messaging, or a dedicated one) |

---

## Prerequisites — gather before you start

- [ ] **Legal business name** exactly as registered (must match IRS/state records).
- [ ] **EIN / Tax ID** (US business). Sole-proprietor path exists if no EIN, but throughput is lower.
- [ ] **Business address, website, and a contact** (name, email, phone).
- [ ] **Business type** (e.g., Private for-profit LLC) and **industry** (healthcare).
- [ ] A payment method on the Telnyx account (TCR fees below are billed through Telnyx).

**Rough fees (Telnyx passes through TCR — confirm current pricing in-portal):** one-time brand registration ~$4; optional brand vetting ~$40 (improves carrier throughput, recommended for healthcare); campaign ~$10/month + carrier per-campaign fees. 2FA/account-notification use cases are among the fastest to approve.

---

## Step 1 — Register the Brand

Telnyx portal → **Messaging → 10DLC → Brands** (a.k.a. Campaign Builder).

- [ ] Click **Create Brand**.
- [ ] Enter legal business name, EIN, address, website, contact.
- [ ] Entity type: **Private Company** (or Sole Proprietor if no EIN).
- [ ] Vertical/industry: **Healthcare**.
- [ ] Submit. Brand identity check is usually near-instant.
- [ ] **(Recommended for healthcare) request Standard Vetting** — higher daily message throughput and better T-Mobile treatment. Adds ~1 business day.
- [ ] Record the **Brand ID** in the table above.

---

## Step 2 — Register the Campaign

Telnyx portal → **Messaging → 10DLC → Campaigns → Create Campaign** (under the Brand).

- [ ] **Use case:** choose **Account Notification** or **2FA / One-Time Passwords** (the OTP is authentication — pick the 2FA/OTP-aligned use case; it approves cleanly and has good throughput). Avoid "Marketing".
- [ ] **Campaign description** (paste):
  > Heros Health sends one-time verification codes so patients can securely log in to and register for their telehealth account. Codes are transactional only; no marketing.
- [ ] **Sample message 1** (paste — this is the EXACT text our code sends):
  > `123456 is your Heros Health verification code. It expires in 5 minutes. If you didn't request it, ignore this message.`
- [ ] **Sample message 2** (registration variant — same template, provide a second sample if the form requires two):
  > `408291 is your Heros Health verification code. It expires in 5 minutes. If you didn't request it, ignore this message.`
- [ ] **Opt-in / consent description** (paste — reviewers require this; it must describe how the user consents):
  > The patient enters their own mobile number in the Heros Health app to log in or create an account and taps to request a code. Entering the number and requesting the code is the opt-in. Codes are sent only in direct response to that action. No numbers are collected from third parties and no marketing is sent.
- [ ] **Opt-in message / call-to-action location:** "In the Heros Health web and mobile app login/registration screen."
- [ ] **HELP response** (paste): `Heros Health: For help contact support@heroshealth.com. Msg&data rates may apply.`
- [ ] **STOP/opt-out:** confirm STOP is honored (Telnyx handles STOP/UNSUBSCRIBE automatically at the platform level for A2P; leave the default on). *Note: pure 2FA campaigns are often exempt from requiring marketing-style opt-out language, but keeping HELP/STOP configured never hurts approval.*
- [ ] **Message volume:** estimate low-to-moderate (staging is low; production TBD). Under-estimating is fine — you can raise it later.
- [ ] Submit. Campaign vetting is typically a few hours to ~2 business days (T-Mobile may add its own review).
- [ ] Record the **Campaign ID** above.

---

## Step 3 — Attach the number to the campaign + a messaging profile

- [ ] Once the campaign shows **Approved/Registered**, go to **Messaging → 10DLC → Campaigns → [your campaign] → Assign Numbers** (or **Numbers → `+13468450373` → Messaging**).
- [ ] **Assign `+13468450373` to the approved campaign.**
- [ ] **Attach `+13468450373` to a messaging profile** — reuse `heros-console-messaging` or create a dedicated `heros-otp` profile. (This is what our sender needs: Telnyx will not send from a number that is in no messaging profile.)
  - *Optional:* I (engineering) can do this number→profile attach via one API call once the campaign is approved — just say so. It's the only portal step I could take off your plate; everything else in Steps 1–2 needs your business info.
- [ ] Confirm the number's messaging settings now show a **messaging_profile_id** and a **campaign** assignment.

---

## Step 4 — Hand back for activation (engineering, ~2 min)

When Steps 1–3 are done, tell me **"telnyx is registered"** and I will:

- [ ] Verify read-only via the Telnyx API that `+13468450373` now shows an approved campaign + a messaging profile.
- [ ] Flip `SMS_PROVIDER=noop → telnyx` in `infra/staging/.env` (key + `SMS_FROM=+13468450373` are already staged). If you prefer pool-sending, I'll set `TELNYX_MESSAGING_PROFILE_ID` to the chosen profile instead of `SMS_FROM`.
- [ ] `docker compose up -d app` (config fail-fast validates the key + sender on boot).
- [ ] **Live-verify:** trigger a phone OTP to a destination number you give me, confirm Telnyx reports it delivered and the app log shows a clean send (no `passcode_sms_skipped_no_provider`, no `passcode_sms_send_rejected`).
- [ ] Append an activation Addendum. Rollback stays one flip back to `noop`.

---

## Gotchas / notes

- **The sample messages must match production.** Our SMS body is generated by `src/lib/sms/passcode-template.ts`. If that copy changes, update the campaign samples or carriers may flag a mismatch.
- **Sender brand = "Heros Health"** (the consumer DBA), consistent with the email sender and the app. Not "Telecheck".
- **Ghana / other countries:** this checklist is US-only (10DLC is a US construct). A Ghana number/route is a separate registration and is out of scope here — the SMS provider abstraction already supports per-country selection when that work is picked up (see the SI).
- **Throughput:** unvetted brands get low T-Mobile daily caps. For any real patient volume, do the Step 1 vetting.
- **Toll-free alternative:** if 10DLC approval drags, a Telnyx **toll-free number with toll-free verification** is an alternative A2P path (different form, often faster for 2FA). Same code works — just set `SMS_FROM` to the toll-free number. Ask me if you want to go that route instead.
