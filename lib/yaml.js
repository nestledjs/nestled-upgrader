function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === '"' || char === "'") && line[i - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (char === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  // Double-quoted scalars must be UNESCAPED here, symmetrically with formatScalar()'s
  // JSON.stringify(). Without this the round-trip is asymmetric — read leaves `\n` as the two
  // literal characters, write re-escapes the backslash — so every read-modify-write cycle doubles
  // every backslash (`\n` -> `\\n` -> `\\\\n` -> ...), progressively corrupting `notes:` fields in
  // .nestled/upgrade-log.yaml. JSON's string grammar is a subset of YAML's double-quoted style for
  // everything this tool emits, so JSON.parse is the exact inverse of JSON.stringify. Fall back to
  // a plain slice for hand-written YAML using escapes JSON rejects (e.g. \x41).
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  // Single-quoted YAML has no backslash escapes; the only escape is '' for a literal quote.
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function preprocess(source) {
  const raw = source.replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (let index = 0; index < raw.length; index += 1) {
    const noComment = stripComment(raw[index]);
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^ */)[0].length;
    const content = noComment.trimEnd().slice(indent);
    lines.push({ indent, content, line: index + 1 });
  }
  return lines;
}

function parseBlock(lines, state, indent) {
  if (state.index >= lines.length) return {};
  if (lines[state.index].indent < indent) return {};
  return lines[state.index].content.startsWith('- ') ? parseSequence(lines, state, indent) : parseMapping(lines, state, indent);
}

function parseSequence(lines, state, indent) {
  const result = [];
  while (state.index < lines.length) {
    const line = lines[state.index];
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.content.startsWith('- ')) {
      throw new Error(`Invalid YAML sequence at line ${line.line}`);
    }
    const rest = line.content.slice(2).trim();
    state.index += 1;
    if (!rest) {
      result.push(parseBlock(lines, state, indent + 2));
      continue;
    }
    const keyValue = rest.match(/^([^:]+):(?:\s+(.+)|\s*)$/);
    if (keyValue) {
      const item = {};
      const key = keyValue[1].trim();
      const value = (keyValue[2] || '').trim();
      item[key] = value ? parseScalar(value) : parseBlock(lines, state, indent + 2);
      while (state.index < lines.length && lines[state.index].indent === indent + 2 && !lines[state.index].content.startsWith('- ')) {
        parseMappingEntry(lines, state, indent + 2, item);
      }
      result.push(item);
    } else {
      const chunks = [rest];
      while (state.index < lines.length && lines[state.index].indent > indent) {
        chunks.push(lines[state.index].content.trim());
        state.index += 1;
      }
      result.push(parseScalar(chunks.join(' ')));
    }
  }
  return result;
}

function parseMappingEntry(lines, state, indent, target) {
  const line = lines[state.index];
  if (line.indent !== indent) throw new Error(`Invalid YAML indentation at line ${line.line}`);
  const match = line.content.match(/^([^:]+):(.*)$/);
  if (!match) throw new Error(`Invalid YAML mapping at line ${line.line}`);
  const key = match[1].trim();
  const rawValue = match[2].trim();
  state.index += 1;
  // Block scalars, with optional chomping indicator: `>`/`|` plus `-` (strip) or `+` (keep).
  // Previously only bare `>`/`|` matched, so a `notes: >-` entry fell through to parseBlock() and
  // threw "Unexpected YAML indentation" — hand-written upgrade-log entries using the common `>-`
  // form crashed the tool. Trailing newlines are not emitted for any variant (the existing
  // behavior), which already matches `-`; the indicator is accepted and folding is unchanged.
  const blockScalar = rawValue.match(/^([>|])[-+]?$/);
  if (blockScalar) {
    const chunks = [];
    while (state.index < lines.length && lines[state.index].indent > indent) {
      chunks.push(lines[state.index].content.trim());
      state.index += 1;
    }
    target[key] = blockScalar[1] === '>' ? chunks.join(' ') : chunks.join('\n');
  } else if (rawValue) {
    target[key] = parseScalar(rawValue);
  } else {
    target[key] = parseBlock(lines, state, indent + 2);
  }
}

function parseMapping(lines, state, indent) {
  const result = {};
  while (state.index < lines.length) {
    const line = lines[state.index];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`Unexpected YAML indentation at line ${line.line}`);
    if (line.content.startsWith('- ')) break;
    parseMappingEntry(lines, state, indent, result);
  }
  return result;
}

export function parseYaml(source) {
  const lines = preprocess(source);
  if (lines.length === 0) return {};
  const state = { index: 0 };
  return parseBlock(lines, state, lines[0].indent);
}

// A plain (unquoted) YAML scalar may not START with an indicator character — a leading `@`, `*`,
// `!`, `&`, `%`, `` ` ``, `|`, `>`, quote or flow character changes the meaning or is reserved.
// Emitting such a value unquoted produces a file our own lenient parser happily reads back but
// STRICT YAML parsers reject (e.g. `reason: @nestledjs/generators ...` -> BAD_SCALAR_START), which
// broke third-party tooling reading .nestled/upgrade-log.yaml. Over-quoting is always safe here;
// under-quoting is the bug.
const RESERVED_SCALAR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function needsQuoting(value) {
  return value === ''
    || /[:#\n]|^\s|\s$|^(true|false|null|\[\]|\{\})$/.test(value)
    || RESERVED_SCALAR_START.test(value);
}

function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  return needsQuoting(text) ? JSON.stringify(text) : text;
}

export function stringifyYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    return value.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) return `${pad}- {}\n`;
        const [firstKey, firstValue] = entries[0];
        const rest = Object.fromEntries(entries.slice(1));
        const first = scalarOrNested(firstKey, firstValue, indent, true);
        const remaining = Object.keys(rest).length ? stringifyYaml(rest, indent + 2) : '';
        return `${pad}- ${first}${remaining}`;
      }
      return `${pad}- ${formatScalar(item)}\n`;
    }).join('');
  }
  if (!value || typeof value !== 'object') return `${formatScalar(value)}\n`;
  return Object.entries(value).map(([key, item]) => `${pad}${scalarOrNested(key, item, indent, false)}`).join('');
}

function scalarOrNested(key, value, indent, inlineKey) {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []\n`;
    return `${key}:\n${stringifyYaml(value, indent + 2)}`;
  }
  if (value && typeof value === 'object') {
    return `${key}:\n${stringifyYaml(value, indent + 2)}`;
  }
  const prefix = inlineKey ? '' : '';
  return `${prefix}${key}: ${formatScalar(value)}\n`;
}
