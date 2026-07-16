import { createHash } from 'node:crypto';

export function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function deterministicId(prefix, ...parts) {
  return `${prefix}:${sha256(parts.map(String).join('\u0000')).slice(0, 16)}`;
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function compareLocations(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.start_line - right.start_line ||
    (left.start_column ?? 0) - (right.start_column ?? 0) ||
    left.end_line - right.end_line ||
    (left.end_column ?? 0) - (right.end_column ?? 0)
  );
}

export function compareLocated(left, right) {
  const leftLocation = left.location ?? { path: '', start_line: 0, end_line: 0 };
  const rightLocation = right.location ?? { path: '', start_line: 0, end_line: 0 };
  return (
    compareLocations(leftLocation, rightLocation) ||
    String(left.kind ?? left.operation ?? '').localeCompare(String(right.kind ?? right.operation ?? '')) ||
    String(left.id ?? '').localeCompare(String(right.id ?? ''))
  );
}