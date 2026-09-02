/**
 * check-log-call-sites.test.ts — tests for the Layer 3 structural boundary.
 *
 * The checker is the control that converts "no current log call site
 * carries free text" from an audit assertion into an enforced invariant.
 * A checker that silently stops catching things is worse than no checker,
 * because the invariant still reads as enforced. So the cases below pin
 * both halves: what it MUST catch, and what it must NOT flag.
 *
 * The false-negative cases are the load-bearing ones. Every entry in the
 * "does not flag" group is a real shape that appeared in `src/` and was
 * flagged by an earlier revision of the checker — each one, left
 * unaddressed, is a reason someone switches the check off.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain .mjs script, no type declarations
import { checkFile } from '../../scripts/check-log-call-sites.mjs';

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

/** Write `source` to a temp .ts file and run the checker over it. */
function check(source: string, staticConsts: readonly string[] = []): Violation[] {
  const dir = mkdtempSync(join(tmpdir(), 'logcheck-'));
  const file = join(dir, 'sample.ts');
  writeFileSync(file, source, 'utf8');
  try {
    return checkFile(file, new Set(staticConsts)) as Violation[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rules = (vs: readonly Violation[]): string[] => vs.map((v) => v.rule);

describe('check-log-call-sites — catches the leak shapes', () => {
  it('flags an interpolated message', () => {
    const vs = check('req.log.error(`bad input: ${x}`);');
    expect(rules(vs)).toContain('log-message-must-be-static');
  });

  it('flags an interpolated message even with a merge object present', () => {
    const vs = check('req.log.warn({ turn_id }, `rejected ${reason}`);');
    expect(rules(vs)).toContain('log-message-must-be-static');
  });

  it('flags a request-rooted merge value', () => {
    const vs = check('req.log.info({ note: req.body.message_text }, "x");');
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('flags request data laundered through a local', () => {
    const vs = check('const t = req.body.message_text;\nreq.log.info({ note: t }, "x");');
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('flags request data laundered through a chain of locals', () => {
    const vs = check(
      'const a = req.body;\nconst b = a.message_text;\nreq.log.info({ note: b }, "x");',
    );
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('flags destructured request data', () => {
    // Destructuring is the most natural way to reach for the value, so it
    // must not be a way around the rule.
    const vs = check('const { message_text } = req.body;\nreq.log.info({ message_text }, "x");');
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('flags a spread of request data', () => {
    const vs = check('req.log.info({ ...req.body }, "x");');
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('flags request data re-encoded through identity-ish calls', () => {
    // A call is normally a derivation boundary, which is what keeps the
    // checker usable. These specific calls preserve content, so treating
    // them as derivations would make them laundering tricks.
    for (const expr of [
      'String(req.body.name)',
      'JSON.stringify(req.body)',
      'req.body.name.toString()',
      'req.body.name.trim()',
      'req.body.name.slice(0, 10)',
      'Object.values(req.body).join(",")',
    ]) {
      const vs = check(`req.log.info({ v: ${expr} }, "x");`);
      expect(rules(vs), `not flagged: ${expr}`).toContain('no-request-data-in-logs');
    }
  });

  it('flags request data inside a template literal merge value', () => {
    const vs = check('req.log.info({ v: `id=${req.params.id}` }, "x");');
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('covers every request surface, not just the body', () => {
    for (const root of ['body', 'query', 'params', 'headers', 'raw']) {
      const vs = check(`req.log.info({ v: req.${root}.x }, "y");`);
      expect(rules(vs), `not flagged: req.${root}`).toContain('no-request-data-in-logs');
    }
  });

  it('covers every log level and both request identifiers', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      const vs = check(`request.log.${level}({ v: request.body.x }, "y");`);
      expect(rules(vs), `not flagged at level ${level}`).toContain('no-request-data-in-logs');
    }
  });
});

describe('check-log-call-sites — does not flag legitimate shapes', () => {
  it('accepts a plain string message', () => {
    expect(check('req.log.info({ turn_id }, "turn rejected");')).toEqual([]);
  });

  it('accepts a message split with + across lines', () => {
    // Long messages are conventionally wrapped this way. Every operand is
    // still a literal in the source, so nothing is interpolated.
    expect(check('req.log.warn({ id }, "first half " +\n  "second half");')).toEqual([]);
  });

  it('accepts a message hoisted into a same-file const', () => {
    expect(check('const MSG = "something happened";\nreq.log.warn({ id }, MSG);')).toEqual([]);
  });

  it('accepts a message imported from another module', () => {
    // Resolved by name from the cross-file first pass. A bare identifier
    // cannot interpolate anything at the call site.
    expect(check('req.log.warn({ id }, IMPORTED_MSG);', ['IMPORTED_MSG'])).toEqual([]);
  });

  it('accepts a derived fact — a call is a derivation boundary', () => {
    // This is the shape nearly every correct call site has. If it were
    // flagged, the check would be switched off and nothing enforced.
    for (const source of [
      'const screening = screenInput(rawText, "ai_bound");\nreq.log.warn({ n: screening.hits.length }, "blocked");',
      'const sessionId = asAIChatSessionId(req.body.conversation_id);\nreq.log.warn({ sessionId }, "x");',
      'const crisis = detectCrisis(req.body.message_text);\nreq.log.warn({ crisis }, "x");',
    ]) {
      expect(check(source), `flagged a derivation: ${source}`).toEqual([]);
    }
  });

  it('accepts a no-substitution template literal', () => {
    expect(check('req.log.info({ id }, `a static message`);')).toEqual([]);
  });

  it('accepts a merge object with no message at all', () => {
    expect(check('req.log.info({ id });')).toEqual([]);
  });

  it('ignores non-logger calls that happen to share a method name', () => {
    expect(check('tracker.info({ v: req.body.x });')).toEqual([]);
    expect(check('console.error(`interpolated ${x}`);')).toEqual([]);
  });
});

describe('check-log-call-sites — the opt-out', () => {
  it('honours a reasoned opt-out on the same line', () => {
    const vs = check('req.log.info({ v: req.params.id }, "x"); // pii-log-allow: route id');
    expect(vs).toEqual([]);
  });

  it('honours a reasoned opt-out in the comment block above', () => {
    // The reason rarely fits on one line, so the whole contiguous block
    // above is searched rather than just the line immediately preceding.
    const vs = check(
      [
        'req.log.info(',
        '  // pii-log-allow: this is a route-path id, not free text,',
        '  // and it is the only thing that makes the record useful.',
        '  { v: req.params.id },',
        '  "x",',
        ');',
      ].join('\n'),
    );
    expect(vs).toEqual([]);
  });

  it('does NOT honour an opt-out with no reason', () => {
    // A bare marker is a rubber stamp. Requiring a reason is what keeps
    // each exception reviewable.
    const vs = check('req.log.info({ v: req.body.x }, "y"); // pii-log-allow:');
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });

  it('does NOT let an opt-out leak across a blank line', () => {
    const vs = check(
      [
        '// pii-log-allow: applies to something else',
        '',
        'req.log.info({ v: req.body.x }, "y");',
      ].join('\n'),
    );
    expect(rules(vs)).toContain('no-request-data-in-logs');
  });
});
