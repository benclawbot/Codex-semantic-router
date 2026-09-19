export function routeMeta(result, { clipped = false, status = 'classified', emitScores = false } = {}) {
  const route = { status };
  if (result?.label !== undefined) route.label = result.label;
  if (result?.labels !== undefined) route.labels = result.labels;
  if (result?.confidence !== undefined) route.confidence = result.confidence;
  if (clipped) route.clipped = true;
  if (emitScores && result?.scores) route.scores = result.scores;
  return route;
}

export function recordWithRoute(record, route) {
  if (record.object) return { ...record.object, route };
  return { id: record.id, text: record.text, route };
}

function plainHeader(route) {
  if (!route) return null;
  if (route.label) return { label: route.label, confidence: route.confidence, status: route.status || 'classified' };
  if (route.labels) return { label: route.labels.join(','), confidence: route.confidence, status: route.status || 'classified' };
  if (route.status && route.status !== 'classified') return { label: route.status, confidence: null, status: route.status };
  return null;
}

export function renderRecord(record, { output = 'plain', route = null, emitClassification = false, command = null, explain = false } = {}) {
  if (output === 'jsonl') return JSON.stringify(recordWithRoute(record, route ?? { status: 'unclassified' }));
  const header = emitClassification || (command && command !== 'filter' && command !== 'count') || explain;
  if (header) {
    const h = plainHeader(route) ?? { label: '-', confidence: null, status: 'unclassified' };
    const confidence = h.confidence == null ? '-' : Number(h.confidence).toFixed(3);
    if (explain && route) {
      const bits = [`status=${h.status}`, `label=${h.label}`];
      if (route.clipped) bits.push('clipped=1');
      return `${bits.join(' ')}\t${record.original}`;
    }
    return `${h.label}\t${confidence}\t${record.original}`;
  }
  return record.original;
}

export function diagnostic(stderr, message) {
  stderr.write(`[semantic-router] ${message}\n`);
}

export function writeLine(stdout, line) {
  if (line == null) return;
  stdout.write(line + '\n');
}
