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

export function parseInput(text, { format = 'lines', textField = 'text', idField = 'id' } = {}) {
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
  for (let lineNo = 0; lineNo < rawLines.length; lineNo++) {
    const raw = rawLines[lineNo];
    if (!raw.trim()) continue;
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
