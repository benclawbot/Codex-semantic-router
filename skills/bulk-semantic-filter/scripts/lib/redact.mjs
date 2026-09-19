const SECRET_PATTERNS = [
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'dotenv-secret', re: /(?:^|\n)\s*(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*[^\s#]{4,}/ },
  { name: 'credential-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/]+:[^\s@/]+@[^\s]+/i },
  { name: 'authorization-bearer', re: /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{8,}/i },
  { name: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { name: 'ssh-private-key', re: /-----BEGIN OPENSSH PRIVATE KEY-----/i },
  { name: 'credential-assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*['"]?[^\s'";]{8,}/i }
];

function globToRegExp(glob) {
  let pattern = String(glob).replace(/\\/g, '/');
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withMarkers = escaped.replace(/\*\*/g, '§§DOUBLESTAR§§');
  const withSingles = withMarkers.replace(/\*/g, '[^/]*');
  const expanded = withSingles
    .replace(/§§DOUBLESTAR§§\//g, '(?:.*/)?')
    .replace(/§§DOUBLESTAR§§/g, '.*');
  return new RegExp(`(?:^|/)${expanded}(?:$|/)`, 'i');
}

export function isSensitivePath(path, patterns = []) {
  if (!path) return false;
  const normalized = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some((glob) => globToRegExp(glob).test(normalized));
}

export function detectSecret(text, extraPatterns = []) {
  const value = String(text ?? '');
  for (const item of SECRET_PATTERNS) if (item.re.test(value)) return { sensitive: true, reason: item.name };
  for (const raw of extraPatterns) {
    try {
      const re = new RegExp(raw, 'i');
      if (re.test(value)) return { sensitive: true, reason: 'configured-pattern' };
    } catch {
      // Invalid custom patterns are ignored here; configuration validation cannot safely compile every flavor.
    }
  }
  return { sensitive: false, reason: null };
}

export function inspectRecord(record, privacy = {}) {
  if (isSensitivePath(record.path, privacy.sensitive_paths ?? [])) return { sensitive: true, reason: 'sensitive-path' };
  if (privacy.block_probable_secrets === false) return { sensitive: false, reason: null };
  return detectSecret(record.text, privacy.extra_secret_patterns ?? []);
}

export { SECRET_PATTERNS };
