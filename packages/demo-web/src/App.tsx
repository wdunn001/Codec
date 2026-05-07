import { useCallback, useMemo, useRef, useState } from 'react';
import {
  PATHS,
  ENCODINGS,
  emptyGrid,
  runAll,
  type Cell,
  type Endpoint,
} from './bench';

const DEFAULTS: Endpoint = {
  url: 'http://192.168.1.88:30002',
  model: 'Qwen/Qwen2.5-0.5B-Instruct',
  prompt: 'Explain entropy in one sentence:',
  maxTokens: 64,
};

function fmtBytes(n?: number): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(2)} MB`;
}

function fmtMs(n?: number): string {
  if (n === undefined) return '—';
  return `${n.toFixed(0)} ms`;
}

function CellView({
  cell,
  baseline,
  isBest,
}: {
  cell: Cell;
  baseline?: number;
  isBest: boolean;
}) {
  if (cell.status === 'pending') return <span className="cell-pending">—</span>;
  if (cell.status === 'running') return <span className="cell-running">running…</span>;
  if (cell.status === 'error')   return <span className="cell-error">{cell.error}</span>;
  const ratio =
    baseline && cell.wireBytes && cell.wireBytes > 0
      ? baseline / cell.wireBytes
      : null;
  const ratioClass =
    ratio === null
      ? 'ratio ratio-baseline'
      : isBest
        ? 'ratio ratio-best'
        : ratio > 1.05
          ? 'ratio ratio-better'
          : 'ratio ratio-baseline';
  return (
    <span className="cell-stack">
      <span className="primary">{fmtBytes(cell.wireBytes)}</span>
      <span className="secondary">
        {cell.tokens ?? 0} tok • {cell.bytesPerToken?.toFixed(1) ?? '?'} B/tok
      </span>
      <span className="secondary">
        {fmtMs(cell.ttfbMs)} TTFB • {fmtMs(cell.totalMs)} total
      </span>
      {ratio !== null && (
        <span className={ratioClass}>{ratio.toFixed(1)}× vs JSON</span>
      )}
    </span>
  );
}

export function App() {
  const [endpoint, setEndpoint] = useState<Endpoint>(DEFAULTS);
  const [grid, setGrid] = useState<Cell[][]>(() => emptyGrid());
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string>('');
  const [error, setError] = useState<string>('');
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => {
      const out = (prev ? prev + '\n' : '') + line;
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      });
      return out;
    });
  }, []);

  const onRun = useCallback(async () => {
    setError('');
    setLog('');
    setGrid(emptyGrid());
    setRunning(true);
    try {
      await runAll(endpoint, setGrid, appendLog);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [endpoint, appendLog]);

  // Find the best (smallest wire) cell per row for highlighting.
  const baselineRow = grid[0]; // JSON-SSE
  const bestPerRow: Array<number | null> = grid.map((row) => {
    let best: number | null = null;
    let bestIdx: number | null = null;
    row.forEach((c, j) => {
      if (c.status === 'done' && c.wireBytes !== undefined) {
        if (best === null || c.wireBytes < best) {
          best = c.wireBytes;
          bestIdx = j;
        }
      }
    });
    return bestIdx;
  });

  // Baseline for ratio = JSON-SSE/identity (top-left cell), once present.
  const jsonBaseline = useMemo(
    () => baselineRow?.[0]?.wireBytes,
    [baselineRow],
  );

  return (
    <div className="app">
      <h1>
        <span>Codec</span> wire-format bench
      </h1>
      <p className="subtitle">
        Same prompt, same model, three wire formats × four compression encodings.
        Numbers are <em>actual bytes received</em> (Performance.encodedBodySize),
        not headers or estimates.
      </p>

      <div className="controls">
        <label>
          server
          <input
            type="text"
            value={endpoint.url}
            onChange={(e) => setEndpoint({ ...endpoint, url: e.target.value })}
            disabled={running}
            spellCheck={false}
          />
        </label>
        <label>
          model
          <input
            type="text"
            value={endpoint.model}
            onChange={(e) => setEndpoint({ ...endpoint, model: e.target.value })}
            disabled={running}
            spellCheck={false}
          />
        </label>
        <label>
          prompt
          <input
            type="text"
            value={endpoint.prompt}
            onChange={(e) => setEndpoint({ ...endpoint, prompt: e.target.value })}
            disabled={running}
          />
        </label>
        <label>
          max_tokens
          <input
            type="number"
            value={endpoint.maxTokens}
            min={1}
            max={2048}
            onChange={(e) =>
              setEndpoint({ ...endpoint, maxTokens: Number(e.target.value) || 64 })
            }
            disabled={running}
          />
        </label>
        <button onClick={onRun} disabled={running}>
          {running ? 'running…' : 'run all 12 cells'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <table className="grid">
        <thead>
          <tr>
            <th>path</th>
            {ENCODINGS.map((e) => (
              <th key={e}>{e}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PATHS.map((p, i) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              {ENCODINGS.map((_e, j) => {
                const cell = grid[i]![j]!;
                const isBest = bestPerRow[i] === j && i > 0;
                const baselineForCell = i === 0 ? undefined : jsonBaseline;
                return (
                  <td key={j}>
                    <CellView cell={cell} baseline={baselineForCell} isBest={isBest} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="legend">
        Ratios are vs JSON-SSE / identity (top-left). Browser auto-decompresses
        gzip / br / zstd; the encoded byte count comes from the Resource Timing API.
        zstd works in Chrome 123+ and Firefox 126+; older browsers fall back to
        identity automatically.
      </div>

      <div className="output" ref={logRef}>
        {log}
      </div>
    </div>
  );
}
