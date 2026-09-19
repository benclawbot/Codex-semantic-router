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

export function renderRecord(record, { output = 'plain', route = null, emitClassification = false } = {}) {
  if (output === 'jsonl') return JSON.stringify(recordWithRoute(record, route ?? { status: 'unclassified' }));
  if (emitClassification && route) {
    const labels = route.labels?.join(',') ?? route.label ?? route.status ?? '-';
    const confidence = route.confidence == null ? '-' : Number(route.confidence).toFixed(3);
    return `${labels}\t${confidence}\t${record.original}`;
  }
  return record.original;
}

export function diagnostic(stderr, message) {
  stderr.write(`[semantic-router] ${message}\n`);
}
