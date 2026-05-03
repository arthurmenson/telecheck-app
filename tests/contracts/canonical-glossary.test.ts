/**
 * Canonical glossary static analysis test.
 *
 * Contract under test: I-014 (Canonical vocabulary is enforced).
 * Glossary: Telecheck_Contracts_Pack_v5_00_GLOSSARY.md v5.2.
 *
 * Spec references:
 *   - I-014: "The Glossary defines the only permitted terms for code, schemas,
 *             APIs, events, and audit. Forbidden aliases are listed. Code review
 *             rejects non-canonical terms."
 *   - GLOSSARY v5.2 forbidden aliases enumerated below.
 *   - CLAUDE.md §Hard rules: "Glossary terms are canonical."
 *   - CLAUDE.md §Specific gotchas: "Never render tenant.id to a patient."
 *
 * Approach — static analysis (preferred over runtime):
 *   Read all .ts files under src/; search for forbidden alias patterns;
 *   assert zero occurrences outside the documented allowlist contexts.
 *
 *   Static analysis is chosen because:
 *     1. It catches violations at the declaration site, not at call time.
 *     2. It is fast (no DB, no process spawn).
 *     3. It complements TypeScript brand types in src/lib/glossary.ts.
 *
 * Allowlist rules:
 *   - Lines containing `// GLOSSARY-ALLOW:` are skipped for that line.
 *   - Lines containing `// @test-fixture` are skipped (test fixtures may
 *     use forbidden terms to document what NOT to do).
 *   - The string 'medication_request' itself contains 'request' — NOT a
 *     'prescription' occurrence; the regex checks for the exact alias.
 *   - 'customer' is forbidden as a domain term but may appear in
 *     `customer_id` of external payment processor adapters (allowlisted below).
 *   - 'prescription' may appear in patient-facing UI copy strings
 *     (allowed in files under `src/modules/<module>/ui/` per GLOSSARY v5.2 notes).
 *   - bare 'Heros' (not followed by 'Health') as a tenant identifier is
 *     forbidden per Master PRD v1.10 §17; 'Heros Health' is the DBA (allowed).
 *
 * DEPENDS ON:
 *   - Node.js built-in fs + path (no additional dependencies).
 *   - src/ directory existing (always true at bootstrap).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Forbidden alias rules
// ---------------------------------------------------------------------------

interface ForbiddenAlias {
  /**
   * Human-readable description of the alias and why it is forbidden.
   */
  description: string;
  /**
   * Regex to detect the forbidden usage. Applied to each line of each .ts file.
   * Must not match the canonical term itself (e.g., 'medication_request' must
   * not match 'prescription' detection since it doesn't contain the word).
   */
  pattern: RegExp;
  /**
   * File path patterns where this alias IS permitted (e.g., UI-only files,
   * external adapter files). Paths are relative to src/.
   */
  allowedInPaths?: RegExp[];
  /**
   * Inline allowlist marker: lines containing this string are skipped.
   * Default: '// GLOSSARY-ALLOW:'
   */
  allowMarker?: string;
}

const FORBIDDEN_ALIASES: ForbiddenAlias[] = [
  // ----- medication_request / prescription -----
  {
    description:
      'prescription (forbidden alias for medication_request in code/schemas/events/audit). ' +
      'Allowed in patient-facing UI copy and PRD section titles per GLOSSARY v5.2.',
    // Match word-boundary 'prescription' but NOT 'medication_request' (which doesn't contain it).
    // NOT in a comment that is explaining what is forbidden.
    pattern: /\bprescription\b(?!\s*[:=]\s*['"](not|forbidden))/i,
    allowedInPaths: [
      // UI-facing text may use 'prescription' per GLOSSARY v5.2 §medication_request notes.
      /modules\/.*\/ui\//,
      // Test fixtures that explain forbidden usage.
      /\.test\.ts$/,
    ],
  },
  {
    description: 'Rx (forbidden alias for medication_request)',
    pattern: /\bRx\b(?!.*GLOSSARY-ALLOW)/,
    allowedInPaths: [/\.test\.ts$/],
  },

  // ----- Mode 1 / Mode 2 / chatbot -----
  {
    description:
      'chatbot (forbidden alias for Mode 1 / conversational_assistant per GLOSSARY v5.2)',
    pattern: /\bchatbot\b/i,
    allowedInPaths: [/\.test\.ts$/],
  },
  {
    description: 'AI doctor / virtual doctor (forbidden alias for Mode 1 per GLOSSARY v5.2)',
    pattern: /\b(ai[\s_-]*doctor|virtual[\s_-]*doctor)\b/i,
    allowedInPaths: [/\.test\.ts$/],
  },
  {
    description: 'AI prescriber / auto-prescriber / robot doctor (forbidden alias for Mode 2)',
    pattern: /\b(ai[\s_-]*prescriber|auto[\s_-]*prescriber|robot[\s_-]*doctor)\b/i,
    allowedInPaths: [/\.test\.ts$/],
  },

  // ----- tenant identifier: bare 'Heros' -----
  {
    description:
      'bare "Heros" as a tenant or operator identifier (forbidden per Master PRD v1.10 §17). ' +
      '"Heros Health" (the consumer DBA) is allowed.',
    // Match 'Heros' NOT followed by ' Health' — i.e., bare usage.
    // 'Heros Health' and 'HerosHealth' (CSS class) are allowed.
    pattern: /\bHeros\b(?!\s*Health)(?!\s*['"]\s*:)/,
    allowedInPaths: [
      // Comments explaining the rule are fine.
      /\.test\.ts$/,
    ],
  },

  // ----- customer (as a domain term) -----
  {
    description:
      '"customer" as a domain concept (forbidden; use "tenant" per GLOSSARY v5.2). ' +
      'Permitted in external payment adapter files (customer_id in Stripe/etc. context).',
    // Detect: customer_id, customerName, CustomerRecord etc. as domain-level identifiers.
    // Allow: comments explaining what is forbidden.
    pattern: /\bcustomer(?:_id|Name|Record|Object|Entity)\b/i,
    allowedInPaths: [
      // Payment processor adapters may have customer_id as an external API term.
      /modules\/payment\/.*adapter/,
      /adapters\/payment/,
      /\.test\.ts$/,
    ],
  },

  // ----- refill aliases -----
  {
    description: 'renewal / reorder / re-prescription (forbidden aliases for refill)',
    pattern: /\b(re[\s_-]*prescription|re[\s_-]*order(?!\s+by))\b/i,
    allowedInPaths: [/\.test\.ts$/],
  },

  // ----- interaction_signal aliases -----
  {
    description: '"alert" used as a domain interaction_signal type in code (discouraged in code)',
    // Only flag if it appears to be a type/interface/variable name pattern, not a UI string.
    pattern: /(?:type|interface|const|let|var)\s+\w*[Aa]lert\w*\s*[=:]/,
    allowedInPaths: [
      /\.test\.ts$/,
      // Browser/accessibility alert roles are fine.
      /ui\//,
    ],
  },

  // ----- intake_form aliases -----
  {
    description: 'quiz / survey / questionnaire (forbidden aliases for intake_form)',
    pattern: /\b(quiz|survey|questionnaire)\b(?=\s*[:=({])/i,
    allowedInPaths: [/\.test\.ts$/],
  },

  // ----- protocol_authorized_action aliases -----
  {
    description:
      'auto-approved / automated prescription / AI-prescribed (forbidden aliases for protocol_authorized_action)',
    pattern: /\b(auto[\s_-]*approved|automated[\s_-]*prescription|ai[\s_-]*prescribed)\b/i,
    allowedInPaths: [/\.test\.ts$/],
  },
];

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(import.meta.dirname ?? __dirname, '../../src');

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walkTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function isAllowedPath(filePath: string, allowedInPaths?: RegExp[]): boolean {
  if (!allowedInPaths || allowedInPaths.length === 0) return false;
  const rel = relative(SRC_DIR, filePath);
  return allowedInPaths.some((pat) => pat.test(rel));
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('canonical glossary — forbidden alias static analysis (I-014)', () => {
  const tsFiles = walkTsFiles(SRC_DIR);

  for (const alias of FORBIDDEN_ALIASES) {
    it(`should have zero occurrences of: ${alias.description}`, () => {
      const violations: string[] = [];

      for (const filePath of tsFiles) {
        if (isAllowedPath(filePath, alias.allowedInPaths)) continue;

        const lines = readFileSync(filePath, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';

          // Skip lines with the inline allowlist marker.
          const marker = alias.allowMarker ?? '// GLOSSARY-ALLOW:';
          if (line.includes(marker)) continue;

          // Skip comment lines that are explaining forbidden terms
          // (the linter is documenting forbidden usage, not using it).
          const stripped = line.trimStart();
          if (stripped.startsWith('//') || stripped.startsWith('*')) continue;

          if (alias.pattern.test(line)) {
            const rel = relative(SRC_DIR, filePath);
            violations.push(`  src/${rel}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      if (violations.length > 0) {
        const errorMessage = [
          `I-014 VIOLATION — forbidden alias found in ${violations.length} location(s):`,
          '',
          `Alias: ${alias.description}`,
          '',
          ...violations,
          '',
          'Fix: replace with the canonical glossary term per GLOSSARY v5.2.',
          'If this is a legitimate allowlist context, add // GLOSSARY-ALLOW: <reason> to the line,',
          'or add the file pattern to the alias allowedInPaths array in this test.',
        ].join('\n');
        expect.fail(errorMessage);
      }

      // No violations — pass.
      expect(violations).toHaveLength(0);
    });
  }

  it('should find at least one TypeScript file to scan (smoke check)', () => {
    // Ensures the walker is pointed at the right directory and finds files.
    // An empty src/ would silently pass all alias checks — this guards against that.
    expect(tsFiles.length).toBeGreaterThanOrEqual(1);
  });
});
