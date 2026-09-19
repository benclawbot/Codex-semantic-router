export class InputParseError extends Error {}

export function getPath(object, path) {
  if (!path) return undefined;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = object;
  for (const part of parts) {
    if (cur == null || (typeof cur !== 'object' && !Array.isArray(cur))) return undefined;
    cur = cur[part];
  }
  return cur;
}

function inferLinePath(text) {
  const withLineNumber = String(text).match(/^(.+?):\d+(?::\d+)?:/);
  if (withLineNumber?.[1]) return withLineNumber[1].trim();
  const windows = String(text).match(/^([A-Za-z]:[\\/][^:]+)(?::|$)/);
  if (windows?.[1]) return windows[1].trim();
  const head = String(text).split(':', 1)[0]?.trim();
  if (!head) return null;
  if (head.startsWith('.') || head.includes('/') || head.includes('\\') || /\.[A-Za-z0-9]{1,8}$/.test(head)) return head;
  return null;
}

function diagnosticFor(stderr) {
  return (msg) => { if (stderr?.write) stderr.write(`[semantic-router] ${msg}\n`); };
}

export function parseInput(text, { format = 'lines', textField = 'text', idField = 'id', stderr } = {}) {
  const diag = diagnosticFor(stderr);
  const rawLines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  if (format === 'lines') {
    return rawLines.map((line, index) => ({
      index,
      id: String(index),
      text: line,
      original: line,
      object: null,
      blank: line.trim() === '',
      path: inferLinePath(line)
    }));
  }
  if (format !== 'jsonl') throw new InputParseError(`unsupported input format: ${format}`);
  const out = [];
  let blankSkipped = 0;
  for (let lineNo = 0; lineNo < rawLines.length; lineNo++) {
    const raw = rawLines[lineNo];
    if (!raw.trim()) { blankSkipped++; continue; }
    let object;
    try { object = JSON.parse(raw); }
    catch (error) { throw new InputParseError(`invalid JSONL on line ${lineNo + 1}: ${error.message}`); }
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new InputParseError(`JSONL line ${lineNo + 1} must be an object`);
    const value = getPath(object, textField);
    if (typeof value !== 'string') throw new InputParseError(`JSONL line ${lineNo + 1} field ${textField} must be a string`);
    const idValue = getPath(object, idField);
    out.push({
      index: out.length,
      id: idValue == null ? String(out.length) : String(idValue),
      text: value,
      original: raw,
      object,
      blank: value.trim() === '',
      path: typeof object.path === 'string' ? object.path : (typeof object.file === 'string' ? object.file : (typeof object.filename === 'string' ? object.filename : null))
    });
  }
  if (blankSkipped > 0) diag(`jsonl: skipped ${blankSkipped} blank line${blankSkipped === 1 ? '' : 's'}`);
  return out;
}

export function clipText(text, maxChars = 8000) {
  const value = String(text);
  if (value.length <= maxChars) return { text: value, clipped: false };
  const marker = '\n[… locally clipped …]\n';
  const room = Math.max(1, maxChars - marker.length);
  const first = Math.min(Math.floor(room * 0.75), 6000);
  const last = room - first;
  return { text: value.slice(0, first) + marker + value.slice(value.length - last), clipped: true };
}

function recordFromJsonl({ object, raw, lineNo, index, textField, idField }) {
  const value = getPath(object, textField);
  if (typeof value !== 'string') throw new InputParseError(`JSONL line ${lineNo} field ${textField} must be a string`);
  const idValue = getPath(object, idField);
  return {
    index,
    id: idValue == null ? String(index) : String(idValue),
    text: value,
    original: raw,
    object,
    blank: value.trim() === '',
    path: typeof object.path === 'string' ? object.path : (typeof object.file === 'string' ? object.file : (typeof object.filename === 'string' ? object.filename : null))
  };
}

function recordFromLine({ line, index }) {
  return {
    index,
    id: String(index),
    text: line,
    original: line,
    object: null,
    blank: line.trim() === '',
    path: inferLinePath(line)
  };
}

async function* sourceToChunks(source) {
  if (source == null) return;
  if (typeof source === 'string') { yield source; return; }
  if (source[Symbol.asyncIterator]) { yield* source; return; }
  if (source[Symbol.iterator]) { for (const c of source) yield c; return; }
  throw new InputParseError('unsupported input source');
}

export async function* parseLinesStream(source, { stderr } = {}) {
  let buffer = '';
  let index = 0;
  let blankSkipped = 0;
  for await (const chunk of sourceToChunks(source)) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield recordFromLine({ line, index: index++ });
      if (!line.trim()) blankSkipped++;
    }
  }
  if (buffer.length) {
    yield recordFromLine({ line: buffer, index: index++ });
    if (!buffer.trim()) blankSkipped++;
  }
  if (blankSkipped > 0) {
    const diag = (msg) => stderr?.write?.(`[semantic-router] ${msg}\n`);
    diag(`streamed: skipped ${blankSkipped} blank line${blankSkipped === 1 ? '' : 's'}`);
  }
}

export async function* parseJsonlStream(source, { textField = 'text', idField = 'id', stderr } = {}) {
  let buffer = '';
  let lineNo = 0;
  let index = 0;
  let blankSkipped = 0;
  const handleLine = (raw) => {
    if (!raw.trim()) { blankSkipped++; return null; }
    lineNo++;
    let object;
    try { object = JSON.parse(raw); }
    catch (error) { throw new InputParseError(`invalid JSONL on line ${lineNo}: ${error.message}`); }
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new InputParseError(`JSONL line ${lineNo} must be an object`);
    return recordFromJsonl({ object, raw, lineNo, index: index++, textField, idField });
  };
  for await (const chunk of sourceToChunks(source)) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const rec = handleLine(raw);
      if (rec) yield rec;
    }
  }
  if (buffer.length) {
    const rec = handleLine(buffer);
    if (rec) yield rec;
  }
  if (blankSkipped > 0) {
    const diag = (msg) => stderr?.write?.(`[semantic-router] ${msg}\n`);
    diag(`streamed: skipped ${blankSkipped} blank line${blankSkipped === 1 ? '' : 's'}`);
  }
}

export async function* parseStream(source, opts = {}) {
  const format = opts.format || 'lines';
  if (format === 'lines') yield* parseLinesStream(source, opts);
  else if (format === 'jsonl') yield* parseJsonlStream(source, opts);
  else throw new InputParseError(`unsupported input format: ${format}`);
}
