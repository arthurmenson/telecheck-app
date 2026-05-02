# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Use one of the channels below.

### Preferred: GitHub private vulnerability disclosure

[Open a private advisory](https://github.com/arthurmenson/telecheck-app/security/advisories/new) on this repository. Engineering Lead will acknowledge within 2 business days.

### Email

Send a detailed report to **security@telecheck.health** *(placeholder — Engineering Lead to confirm the live address before this repo goes public).*

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce, including any required configuration
- The commit hash or version affected
- Whether the issue is already known to be exploited in the wild
- Your name and contact info if you want acknowledgment in the fix's release notes

Do **not** include PHI (patient identifiers, message contents, lab values, etc.) in the report.
If reproduction requires PHI-bearing fixtures, note that and we will coordinate a secure handoff.

## PHI-related disclosures

Suspected PHI exposure routes through the Platform Privacy Officer per **Master PRD v1.10 §22**, separately from the standard vulnerability disclosure flow. See the spec corpus (`arthurmenson/telecheckONE`) for the exact contact pattern and breach-notification timelines.

If you are unsure whether a finding involves PHI, treat it as if it does and contact the Privacy Officer first.

## Scope

In scope:
- This repository (`arthurmenson/telecheck-app`) and its deployed environments
- Anything reachable from the production Telecheck-US (heroshealth.com) or Telecheck-Ghana (ghana.heroshealth.com) surfaces

Out of scope (use the contact channels above to coordinate a separate report rather than the bug bounty path, if one exists):
- The spec corpus (`arthurmenson/telecheckONE`) — those are markdown files; spec defects use the Spec Issue template
- Third-party services (Anthropic, AWS, LiveKit, etc.) — report to those vendors directly
- Social engineering of Telecheck staff
- Physical attacks against Telecheck infrastructure

## Response process

1. Acknowledge receipt within 2 business days
2. Triage severity (using CVSS v3.1) and assign an owner
3. Develop a fix on a private branch
4. Coordinate disclosure timing with the reporter (default: 90 days from acknowledgment, accelerated if actively exploited)
5. Release the fix and publish a public advisory once the fix is deployed

## Hall of fame

We acknowledge external researchers who report valid issues. Names listed in release notes with the reporter's permission.
