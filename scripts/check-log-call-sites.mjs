#!/usr/bin/env node
/**
 * check-log-call-sites.mjs — Layer 3 structural boundary (Sprint 1.2a).
 *
 * Enforces at BUILD TIME that user-controlled free text never reaches the
 * logging path, so Layer 3's regex screen is not the only thing standing
 * between a request body and the log destination.
 *
 * ## Why this exists as a build-time check and not more runtime screening
 *
 * Layer 3 (`src/lib/pii-screener/log-redaction.ts`) screens the serialized
 * log line for STRUCTURED identifiers — SSN, email, phone, card, MRN,
 * Ghana Card, context-bound passport. It deliberately does not run NER, so
 * it cannot detect an unstructured value like a person's name or a street
 * address. That exclusion is a ratified decision in
 * `docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md` §Layer 3, on two grounds:
 * synchronous model inference per log record is not viable on a hot path,
 * and PERSON/GPE/ORG classes would fire on the operational vocabulary logs
 * are made of (tenant identifiers, role names, provider names, module
 * names), destroying the correlation an incident depends on.
 *
 * The residual that leaves is a log call site that puts caller-shaped free
 * text into a record. Codex raised exactly this against Sprint 1.2a. The
 * Sprint 1.2a log-surface audit found no current call site does it — but
 * that was an ASSERTION about a moment in time, not an invariant. This
 * script converts it into one.
 *
 * A build-time boundary is the right instrument because the vector is a
 * FUTURE call site. A deterministic check fails the build when someone
 * writes the unsafe line; a runtime classifier only maybe catches the value
 * after it has already been constructed. Prevention beats detection when
 * prevention is decidable, and for these two rules it is.
 *
 * ## Rules
 *
 * 1. **The log MESSAGE must be a static string.** A template literal with
 *    substitutions or a `+` concatenation can interpolate anything —
 *    `log.error(\`bad input: ${x}\`)` is the canonical leak. Structured
 *    context belongs in the merge object, where it is subject to rule 2
 *    and to Layer 3's per-value screening.
 *
 * 2. **No merge-object value may be rooted in request-controlled data.**
 *    `req.body`, `req.query`, `req.params`, `req.headers` and `req.raw` are
 *    caller-shaped by definition. Taint propagates through local variable
 *    declarations and assignments, so destructuring into a local does not
 *    launder it.
 *
 * ## Deliberate non-goals
 *
 * This is not a general taint analysis and does not claim to be. It cannot
 * follow a value through a function call, and it does not inspect what a
 * third-party dependency logs on its own. Those remain covered only by
 * Layer 3's structured screen. The rules here are the two that are both
 * decidable from the syntax and responsible for the realistic leak shapes.
 *
 * Usage: node scripts/check-log-call-sites.mjs [--json]
 * Exit 0 = clean, 1 = violations found, 2 = internal error.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');

/** Logger method names that accept (mergeObject?, message). */
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** Identifiers that denote a Fastify request in this codebase. */
const REQUEST_IDENTIFIERS = new Set(['req', 'request']);

/** Properties of a request whose contents are caller-shaped. */
const TAINTED_REQUEST_PROPS = new Set(['body', 'query', 'params', 'headers', 'raw']);

/**
 * Calls that PRESERVE their input's content rather than deriving a new
 * fact from it. Taint crosses these; it does not cross any other call.
 *
 * A function call is normally a derivation boundary — that is the whole
 * shape of a safe log site. `screenInput(text)` yields hit counts and
 * pattern ids, `asAIChatSessionId(id)` yields an id, `detectCrisis(text)`
 * yields a boolean. Propagating taint through those flags every correct
 * call site and the check gets switched off, which protects nothing.
 *
 * But a handful of calls are pure re-encodings, and treating them as
 * derivations would make `String(req.body.name)` a laundering trick.
 * Those are enumerated here.
 */
const CONTENT_PRESERVING_CALLS = new Set([
  'String',
  'stringify',
  'toString',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'substring',
  'substr',
  'toLowerCase',
  'toUpperCase',
  'normalize',
  'padStart',
  'padEnd',
  'concat',
  'replace',
  'replaceAll',
  'join',
  'at',
  'charAt',
  'values',
  'entries',
]);

/** Opt-out marker; must carry a reason. */
const ALLOW_PATTERN = /pii-log-allow:\s*\S/;

/**
 * Collect every .ts file under src/, excluding test files (tests assert on
 * redaction behaviour and legitimately construct PII-shaped literals).
 */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Is this call expression a logger call? Matches `<expr>.log.<method>(...)`
 * and `<expr>.#log.<method>(...)` and a bare `log.<method>(...)`.
 *
 * Returns the method name, or null.
 */
function loggerMethodName(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name;
  if (!ts.isIdentifier(method) || !LOG_METHODS.has(method.text)) return null;

  // The receiver must be something named `log` — `req.log`, `this.#log`,
  // `app.log`, or a bare `log`.
  const receiver = callee.expression;
  const receiverName = ts.isPropertyAccessExpression(receiver)
    ? receiver.name.text
    : ts.isIdentifier(receiver)
      ? receiver.text
      : null;
  if (receiverName === 'log') return method.text;

  // Private field receiver: `this.#log`.
  if (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isPrivateIdentifier(receiver.name) &&
    receiver.name.text === '#log'
  ) {
    return method.text;
  }
  return null;
}

/**
 * Does this expression read from request-controlled data, given the set of
 * already-tainted local identifiers?
 */
function isTainted(node, taintedLocals) {
  let found = false;
  const visit = (n) => {
    if (found) return;

    // A call is a derivation boundary unless it is a pure re-encoding.
    // Its ARGUMENTS are not walked, so `screenInput(rawText).hits.length`
    // is clean while `String(req.body.name)` still taints.
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
          ? callee.name.text
          : null;
      if (calleeName !== null && CONTENT_PRESERVING_CALLS.has(calleeName)) {
        // Re-encoding: taint flows from the receiver and the arguments.
        if (ts.isPropertyAccessExpression(callee)) visit(callee.expression);
        for (const arg of n.arguments) visit(arg);
      }
      return;
    }

    if (ts.isPropertyAccessExpression(n)) {
      const objName = ts.isIdentifier(n.expression) ? n.expression.text : null;
      if (
        objName !== null &&
        REQUEST_IDENTIFIERS.has(objName) &&
        ts.isIdentifier(n.name) &&
        TAINTED_REQUEST_PROPS.has(n.name.text)
      ) {
        found = true;
        return;
      }
    }

    if (ts.isIdentifier(n) && taintedLocals.has(n.text)) {
      found = true;
      return;
    }

    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Compute the set of local identifiers tainted by request-controlled data,
 * to a fixed point so that `const a = req.body; const b = a;` taints both.
 *
 * Binding names in a destructuring pattern are all tainted when the
 * initializer is tainted, which is what stops
 * `const { message_text } = req.body` from laundering the value.
 */
function computeTaintedLocals(sourceFile) {
  const tainted = new Set();
  let changed = true;

  const addBindingNames = (name) => {
    if (ts.isIdentifier(name)) {
      if (!tainted.has(name.text)) {
        tainted.add(name.text);
        changed = true;
      }
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingNames(element.name);
      }
    }
  };

  while (changed) {
    changed = false;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        if (isTainted(node.initializer, tainted)) addBindingNames(node.name);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isTainted(node.right, tainted)
      ) {
        if (!tainted.has(node.left.text)) {
          tainted.add(node.left.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return tainted;
}

/**
 * Collect module-level `const NAME = <static string>` bindings.
 *
 * Long log messages are routinely hoisted into a named constant so the
 * same wording can be asserted in a test. That is still a static string,
 * so the identifier has to resolve rather than be flagged.
 */
function collectStaticStringConsts(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isStaticString(node.initializer, names)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/**
 * A static string: a plain literal, a template with no substitutions, a
 * `+` chain whose every operand is itself static, or an identifier bound
 * to one of those.
 *
 * The `+` chain matters because a message too long for one line is
 * conventionally split with `+`, and that is not interpolation — every
 * operand is still a literal in the source.
 */
function isStaticString(node, staticConsts = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isIdentifier(node)) return staticConsts.has(node.text);
  if (ts.isParenthesizedExpression(node)) return isStaticString(node.expression, staticConsts);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      isStaticString(node.left, staticConsts) && isStaticString(node.right, staticConsts)
    );
  }
  return false;
}

function checkFile(filePath, externalStaticConsts = new Set()) {
  const text = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true);
  const taintedLocals = computeTaintedLocals(sourceFile);
  const staticConsts = new Set([
    ...externalStaticConsts,
    ...collectStaticStringConsts(sourceFile),
  ]);
  const violations = [];

  const lines = text.split(/\r?\n/);

  /**
   * An opt-out is honoured when `// pii-log-allow: <reason>` sits on the
   * flagged line or the line above it. The reason is mandatory, so every
   * exception is self-documenting and greppable in review.
   *
   * This exists because the alternative is worse: a check with no escape
   * hatch that flags legitimate code (a route-param id is genuinely worth
   * logging) gets switched off wholesale, and then nothing is enforced.
   */
  const isAllowed = (lineNumber) => {
    if (ALLOW_PATTERN.test(lines[lineNumber - 1] ?? '')) return true;
    // Walk the whole contiguous comment block immediately above. A reason
    // worth writing rarely fits on one line, and requiring the marker to
    // land on the last line of the block would be an arbitrary trap.
    for (let i = lineNumber - 2; i >= 0; i--) {
      const line = (lines[i] ?? '').trim();
      if (line === '') break;
      if (!line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*')) break;
      if (ALLOW_PATTERN.test(line)) return true;
    }
    return false;
  };

  const report = (node, rule, detail) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const lineNumber = line + 1;
    if (isAllowed(lineNumber)) return;
    violations.push({
      file: relative(REPO_ROOT, filePath).split(sep).join('/'),
      line: lineNumber,
      rule,
      detail,
    });
  };

  const visit = (node) => {
    const method = loggerMethodName(node);
    if (method !== null) {
      const args = node.arguments;

      // The message is the last argument when there are two, the only one
      // when there is one. pino also accepts a bare merge object with no
      // message, which is fine.
      const messageArg = args.length >= 2 ? args[1] : args.length === 1 ? args[0] : undefined;
      if (
        messageArg !== undefined &&
        !ts.isObjectLiteralExpression(messageArg) &&
        !isStaticString(messageArg, staticConsts)
      ) {
        report(
          messageArg,
          'log-message-must-be-static',
          `\`log.${method}\` message is not a static string. An interpolated message can carry ` +
            'caller-shaped free text, which Layer 3 cannot detect when it is a name or an ' +
            'address. Put the dynamic part in the merge object instead.',
        );
      }

      // Rule 2 applies to the merge object (first argument, when the call
      // has a message after it, or a lone object argument).
      const mergeArg =
        args.length >= 2 && ts.isObjectLiteralExpression(args[0])
          ? args[0]
          : args.length === 1 && ts.isObjectLiteralExpression(args[0])
            ? args[0]
            : undefined;
      if (mergeArg !== undefined) {
        for (const prop of mergeArg.properties) {
          if (ts.isPropertyAssignment(prop) && isTainted(prop.initializer, taintedLocals)) {
            report(
              prop,
              'no-request-data-in-logs',
              `\`log.${method}\` merge value \`${prop.name.getText(sourceFile)}\` is rooted in ` +
                'request-controlled data (req.body / query / params / headers / raw). Log a ' +
                'derived non-PHI fact instead — an id, a count, a status, a pattern-id list.',
            );
          }
          // `{ ...req.body }` and shorthand `{ message_text }` where the
          // local is tainted are the same leak in different clothing.
          if (ts.isSpreadAssignment(prop) && isTainted(prop.expression, taintedLocals)) {
            report(prop, 'no-request-data-in-logs', `\`log.${method}\` spreads request data.`);
          }
          if (
            ts.isShorthandPropertyAssignment(prop) &&
            taintedLocals.has(prop.name.text)
          ) {
            report(
              prop,
              'no-request-data-in-logs',
              `\`log.${method}\` merge value \`${prop.name.text}\` is a local carrying ` +
                'request-controlled data.',
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function main() {
  const asJson = process.argv.includes('--json');
  const files = collectSourceFiles(SRC_ROOT);

  // First pass: every static-string const name in the tree.
  //
  // A long log message is often hoisted into an exported constant so the
  // same wording can be asserted in a test, then imported at the call
  // site. Resolving only same-file consts flags those. Matching is by
  // NAME across files rather than by real import resolution: a bare
  // identifier cannot interpolate anything AT the call site, so the only
  // thing being established here is that the name denotes a message
  // constant somewhere, which is what the rule actually cares about.
  const staticConstNames = new Set();
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    );
    for (const name of collectStaticStringConsts(sf)) staticConstNames.add(name);
  }

  const violations = files.flatMap((file) => checkFile(file, staticConstNames));

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ scanned: files.length, violations }, null, 2)}\n`);
  } else if (violations.length === 0) {
    process.stdout.write(`check-log-call-sites: OK (${files.length} files scanned)\n`);
  } else {
    process.stdout.write(
      `check-log-call-sites: ${violations.length} violation(s) in ${files.length} files scanned\n\n`,
    );
    for (const v of violations) {
      process.stdout.write(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.detail}\n\n`);
    }
    process.stdout.write(
      'These rules exist because Layer 3 screens STRUCTURED identifiers only and cannot\n' +
        'detect a name or an address. See docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md.\n',
    );
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}

try {
  main();
} catch (err) {
  process.stderr.write(`check-log-call-sites: internal error: ${String(err)}\n`);
  process.exitCode = 2;
}

export { checkFile, computeTaintedLocals, isTainted, loggerMethodName };
