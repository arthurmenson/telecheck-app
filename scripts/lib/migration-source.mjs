/** Split PostgreSQL source without interpreting semicolons in quoted bodies. */
export function splitSql(source) {
  const statements = [];
  let start = 0;
  let quote = null;
  let blockDepth = 0;
  let lineComment = false;
  let dollar = null;
  let code = '';
  const push = (end) => {
    if (code.trim()) statements.push({ sql: source.slice(start, end), code: code.trim() });
    start = end;
    code = '';
  };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (c === '\n') {
        lineComment = false;
        code += ' ';
      }
      continue;
    }
    if (blockDepth) {
      if (c === '/' && next === '*') {
        blockDepth += 1;
        i += 1;
      } else if (c === '*' && next === '/') {
        blockDepth -= 1;
        i += 1;
      }
      continue;
    }
    if (dollar) {
      if (source.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = null;
      }
      continue;
    }
    if (quote) {
      if (c === quote.char) {
        if (next === quote.char) i += 1;
        else quote = null;
      } else if (c === '\\' && quote.escape) i += 1;
      continue;
    }
    if (c === '-' && next === '-') {
      lineComment = true;
      i += 1;
      code += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      blockDepth = 1;
      i += 1;
      code += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = { char: c, escape: c === "'" && /(?:^|[^a-z0-9_$])e$/i.test(code) };
      code += ' quoted_value ';
      continue;
    }
    if (c === '$') {
      const match = source.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/);
      if (match) {
        dollar = match[0];
        i += dollar.length - 1;
        code += ' quoted_body ';
        continue;
      }
    }
    if (c === ';') push(i + 1);
    else code += c;
  }
  if (quote || dollar || blockDepth) throw new Error('migration_source_unterminated_quote');
  push(source.length);
  return statements;
}

/** The runner owns the sole transaction, including the tracking insert. */
export function transactionalMigrationSource(source) {
  const statements = splitSql(source.replace(/^\uFEFF/, ''));
  const isBegin = (s) => /^(BEGIN|START\s+TRANSACTION)(?:\s+(?:WORK|TRANSACTION))?$/i.test(s.code);
  const isCommit = (s) => /^(COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i.test(s.code);
  if (statements.length && isBegin(statements[0])) {
    if (!isCommit(statements.at(-1))) throw new Error('migration_source_unpaired_transaction');
    statements.shift();
    statements.pop();
  }
  for (const statement of statements) {
    if (
      /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE\s+SAVEPOINT|PREPARE\s+TRANSACTION)\b/i.test(
        statement.code,
      )
    ) {
      throw new Error('migration_source_internal_transaction');
    }
    if (/^\\/.test(statement.code)) throw new Error('migration_source_psql_command');
  }
  if (!statements.length) throw new Error('migration_source_empty');
  return statements.map((s) => s.sql).join('\n');
}
