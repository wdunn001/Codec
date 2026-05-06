/** Tiny formatting helpers. Output is markdown so results paste cleanly into
 *  PRs/issues without ANSI escape pollution. */

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtNs(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)} µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

export function fmtPct(num: number, denom: number): string {
  if (denom === 0) return 'n/a';
  return ((num / denom) * 100).toFixed(1) + '%';
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
  );
  const fmtRow = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join('\n');
}

export function ratio(a: number, b: number, digits = 1): string {
  if (b === 0) return 'n/a';
  const r = a / b;
  return r >= 1 ? `${r.toFixed(digits)}×` : `${(1 / r).toFixed(digits)}× smaller`;
}

export function hr(title?: string): string {
  if (!title) return '─'.repeat(72);
  const pad = 72 - title.length - 2;
  return `── ${title} ${'─'.repeat(Math.max(2, pad))}`;
}
