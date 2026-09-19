import { createHash } from 'node:crypto';

export class BackendError extends Error {
  constructor(message, { status = null, code = null, rateLimited = false, retryAfterMs = 0, dayLimit = false } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.rateLimited = rateLimited;
    this.retryAfterMs = retryAfterMs;
    this.dayLimit = dayLimit;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function readJsonResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { throw new BackendError(`backend returned non-JSON response (HTTP ${response.status})`, { status: response.status }); }
  return body;
}

export class ClassifierDevBackend {
  constructor({
    endpoint = 'https://classifier.dev/v1/classify',
    tier = 'fast',
    batchSize = 250,
    timeoutMs = 5000,
    maxRetries = 1,
    maxRetryAfterMs = 3000,
    fetchImpl = globalThis.fetch,
    userAgent = 'codex-semantic-router/0.1.0'
  } = {}) {
    this.endpoint = endpoint;
    this.tier = tier;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRetryAfterMs = maxRetryAfterMs;
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
  }

  async #request(payload) {
    const body = JSON.stringify(payload);
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
            'user-agent': this.userAgent,
            'idempotency-key': hash(body)
          },
          body,
          signal: controller.signal
        });
        clearTimeout(timer);
        if (response.ok) return await readJsonResponse(response);
        const parsed = await readJsonResponse(response).catch(() => ({}));
        const code = parsed?.code ?? null;
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          const dayLimit = code === 'rate_limit_day';
          if (attempt < this.maxRetries && retryAfterMs <= this.maxRetryAfterMs) {
            if (retryAfterMs > 0) await sleep(retryAfterMs);
            continue;
          }
          throw new BackendError(parsed?.error ?? 'backend rate limited', { status: 429, code, rateLimited: true, retryAfterMs, dayLimit });
        }
        if ([502, 503, 504].includes(response.status) && attempt < this.maxRetries) {
          lastError = new BackendError(parsed?.error ?? `backend HTTP ${response.status}`, { status: response.status, code });
          continue;
        }
        throw new BackendError(parsed?.error ?? `backend HTTP ${response.status}`, { status: response.status, code });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof BackendError) throw error;
        lastError = new BackendError(error?.name === 'AbortError' ? 'backend request timed out' : `backend request failed: ${error.message}`);
        if (attempt >= this.maxRetries) throw lastError;
      }
    }
    throw lastError ?? new BackendError('backend request failed');
  }

  async #classifyBatches({ inputs, labels, instructions, multi = false, maxLabels }) {
    if (!Array.isArray(inputs) || inputs.length === 0) return { results: [], usage: { classifications: 0 } };
    if (inputs.length > 100000) throw new BackendError('refusing unusually large local classification set');
    const results = [];
    let classifications = 0;
    for (let start = 0; start < inputs.length; start += this.batchSize) {
      const batch = inputs.slice(start, start + this.batchSize);
      const payload = { inputs: batch, labels, instructions, tier: this.tier };
      if (multi) {
        payload.multi = true;
        if (maxLabels != null) payload.max_labels = maxLabels;
        delete payload.tier; // classifier.dev multi-label does not use smart/fast tier selection.
      }
      const body = await this.#request(payload);
      if (!Array.isArray(body.results) || body.results.length !== batch.length) {
        throw new BackendError(`backend result count mismatch: expected ${batch.length}, got ${Array.isArray(body.results) ? body.results.length : 'invalid'}`);
      }
      const allowedLabels = new Set(labels);
      for (const result of body.results) {
        if (!result || typeof result !== 'object') throw new BackendError('backend returned malformed result');
        if (multi) {
          if (!Array.isArray(result.labels) || !result.labels.every((label) => typeof label === 'string' && allowedLabels.has(label)) || (result.scores != null && typeof result.scores !== 'object')) throw new BackendError('backend returned malformed multi-label result');
        } else {
          if (typeof result.label !== 'string' || !allowedLabels.has(result.label)) throw new BackendError('backend returned invalid label');
          if (result.confidence != null && (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1)) throw new BackendError('backend returned invalid confidence');
        }
      }
      results.push(...body.results);
      classifications += batch.length;
    }
    return { results, usage: { classifications } };
  }

  async classify({ inputs, labels, instructions }) {
    return this.#classifyBatches({ inputs, labels, instructions, multi: false });
  }

  async classifyMulti({ inputs, labels, instructions, maxLabels }) {
    return this.#classifyBatches({ inputs, labels, instructions, multi: true, maxLabels });
  }

  async health() {
    const url = new URL('/v1/health', this.endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': this.userAgent }, signal: controller.signal });
      if (!response.ok) throw new BackendError(`health endpoint HTTP ${response.status}`, { status: response.status });
      return await response.json();
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(error?.name === 'AbortError' ? 'health request timed out' : `health request failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class DisabledBackend {
  async classify() { throw new BackendError('remote classifier is disabled'); }
  async classifyMulti() { throw new BackendError('remote classifier is disabled'); }
  async health() { return { ok: false, disabled: true, service: 'classifier.dev' }; }
}
