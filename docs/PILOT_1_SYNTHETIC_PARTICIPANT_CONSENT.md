# Pilot 1 Synthetic Participant Consent Form

**Filed:** 2026-08-30
**Version:** 1.0
**Owner:** Evans (custodian of signed copies) + Ghana counsel (advisory review before distribution)
**Purpose:** consent template for Pilot 1 volunteer testers (Heros team members, friendly clinicians, contracted UX researchers) participating in the workflow rehearsal on the Hetzner staging substrate

---

## Plain-English one-pager (participant-visible)

**What this is:**
You are being invited to help test the Telecheck telehealth software before it is used with real patients. This is called Pilot 1. It is a **workflow test**, not real medical care.

**What you'll do:**
- Sign up for a Telecheck account using a **synthetic identity** provided in the Participant Kit (not your real name, real phone, or real address)
- Complete a health intake using **contrived scenarios** provided by the test team
- Chat with the Telecheck AI assistant using **only the scenarios** you were given (not your real health information)
- If the scenario requires a "consult," a friendly clinician will review your synthetic case and record a synthetic decision

**What this is NOT:**
- This is NOT real medical care. No real prescriptions are issued. No real medical decisions apply to you.
- No real health advice reaches you. Anything the AI or clinician "recommends" is part of the test, not for your use.
- If you have a real medical concern, use your real healthcare provider — not this system.

**What data we collect:**
- The synthetic identity, scenarios, and interactions you produce in the system.
- No real personal information about you. **You agree not to enter your real name, phone, address, date of birth, medical records, or any real information about yourself or anyone else.**
- Technical logs of system behavior (timing, errors, workflow steps).

**How we protect against accidental real-data entry:**
- The system has automated detection that will block or warn if you accidentally enter something that looks like real personal information (real names, phone numbers, addresses, ID numbers, credit card numbers, etc.).
- If you get a warning, replace the entry with a synthetic value from the Participant Kit and try again.
- If real data is detected, the affected test session may be reset. You may be asked to try the scenario again.

**Risks:**
- **Very low.** The system does not affect your real medical care. The only realistic risk is accidental disclosure of your own real information if you ignore the guidance above — which the automated detection is designed to catch.

**Benefits:**
- Contribute to a real telehealth system that will serve chronic-care patients in Ghana and eventually the US.
- Optional: participants may receive [compensation TBD by Evans — leave placeholder or specify].

**How long the test runs:**
- Pilot 1 window: TBD (target: 2–4 weeks from Evans's participant-list confirmation).
- You can withdraw at any time by notifying [named contact].

**What happens to the test data:**
- Kept in the staging environment for defect analysis and workflow-review purposes.
- Periodically purged as part of test-session hygiene.
- Not shared with anyone outside the Telecheck engineering team.
- Not used for any commercial purpose.

**What happens next:**
- **Pilot 2** is a separate program. It uses **real patients** in **Ghana** with **real prescribing** on **regulated infrastructure**. Pilot 2 uses a completely different consent form and different substrate. Pilot 1 participation does not enroll you in Pilot 2.

**Named contacts:**
- **Test coordinator:** Evans, `info@cardinalfive.com`
- **Technical incident owner:** Claude (on-call via the test coordinator)
- **Privacy contact:** [Ghana counsel + Heros privacy lead — Evans to fill]

---

## Consent statements (participant to check + sign)

- [ ] I understand this is a workflow test, not real medical care.
- [ ] I agree to use only the synthetic identity + scenarios provided in the Participant Kit.
- [ ] I agree NOT to enter my real name, phone, address, date of birth, medical records, or any real personal information about myself or anyone else.
- [ ] I understand that if I accidentally enter real personal information, the system may block it, warn me, and possibly reset the affected test session.
- [ ] I understand that any medical "recommendation" produced by the system during Pilot 1 is part of the test and is NOT for my real use.
- [ ] I will use my real healthcare provider for any real medical concerns.
- [ ] I agree the test team may collect technical logs of my interactions with the system for defect analysis.
- [ ] I understand test data is kept in the staging environment and may be periodically purged.
- [ ] I understand I can withdraw at any time by notifying the test coordinator.
- [ ] I understand Pilot 2 is a separate program and this consent does not enroll me in Pilot 2.

**Participant signature + printed name + date:**

```
____________________________________  ______________________
Signature                             Date

____________________________________
Printed name

____________________________________
Participant handle (assigned from Kit)
```

**Test coordinator counter-signature:**

```
____________________________________  ______________________
Signature                             Date

Evans (test coordinator)
```

---

## Storage

Signed copies are kept **off-repo** by Evans (secure personal storage — cloud drive or physical file). This document is the template; specific signed copies are NEVER committed to git.

Retention: signed copies retained for 12 months post-Pilot-1 exit, then destroyed unless required for regulatory / defect-attribution purposes.

## Counsel review status

**Advisory review by Ghana counsel recommended but NOT required for Pilot 1** since Pilot 1 does not process real PHI or real patient data.

Counsel review IS required before Pilot 2 patient consent template is finalized — this template does NOT serve as the Pilot 2 consent.

## Version control

Any change to the consent statements (§Consent statements section above) requires a version bump + Evans's re-signature acknowledging the revised terms + participant re-signature if the change is substantive.

- **v1.0** (2026-08-30) — initial draft under Path α ratification.
