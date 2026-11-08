import type { CountRow } from '../dashboard/present';
import { barHeight } from '../dashboard/present';

const verdictColor: Record<string, string> = {
  CLEAN: 'var(--good)',
  SUSPICIOUS: 'var(--warn)',
  DETECTED: 'var(--bad)',
  NOT_ANALYZED: 'var(--muted)',
  NOT_EVALUATED: 'var(--cyan)',
};

export function CountChart({
  title,
  rows,
  testId,
  variant = 'bars',
}: {
  title: string;
  rows: readonly CountRow[];
  testId: string;
  variant?: 'bars' | 'donut';
}) {
  return (
    <div className="chart-block" data-testid={testId}>
      {variant === 'donut' ? (
        <Donut title={title} rows={rows} />
      ) : (
        <Bars title={title} rows={rows} />
      )}
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Dato</th>
            <th scope="col">Cantidad</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <span
                  className="swatch"
                  data-tone={row.key}
                  aria-hidden="true"
                />
                {row.label}
              </th>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bars({ title, rows }: { title: string; rows: readonly CountRow[] }) {
  const max = rows.reduce((highest, row) => Math.max(highest, row.count), 0);
  const width = Math.max(rows.length, 1) * 36;
  return (
    <div>
      {max === 0 && <p className="hint">Sin movimientos en este periodo.</p>}
      <svg
        className="chart"
        viewBox={`0 0 ${width} 100`}
        role="img"
        aria-label={title}
      >
        <title>{title}</title>
        <line
          x1="0"
          y1="99"
          x2={width}
          y2="99"
          stroke="var(--line)"
          strokeWidth="1"
        />
        {rows.map((row, index) => {
          const height = barHeight(row.count, max);
          return (
            <rect
              key={row.key}
              x={index * 36 + 8}
              y={100 - height}
              width={20}
              height={height}
              rx="2"
              fill="var(--cyan)"
            >
              <title>{`${row.label}: ${row.count}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="chart-labels">
        {rows.map((row) => (
          <span key={row.key} title={`${row.label}: ${row.count}`}>
            {row.label.length > 10 ? row.label.slice(5) : row.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Donut({ title, rows }: { title: string; rows: readonly CountRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="chart-visual">
      <div className="donut-wrap">
        <svg viewBox="0 0 120 120" role="img" aria-label={title}>
          <title>{title}</title>
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="var(--line)"
            strokeWidth="14"
          />
          {total > 0 &&
            rows.map((row) => {
              if (row.count <= 0) return null;
              const length = (row.count / total) * circumference;
              const dash = `${length} ${circumference - length}`;
              const circle = (
                <circle
                  key={row.key}
                  cx="60"
                  cy="60"
                  r={radius}
                  fill="none"
                  stroke={verdictColor[row.key] ?? 'var(--cyan)'}
                  strokeWidth="14"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 60 60)"
                >
                  <title>{`${row.label}: ${row.count}`}</title>
                </circle>
              );
              offset += length;
              return circle;
            })}
        </svg>
        <div className="donut-center">
          <strong>{total}</strong>
          <span>{total === 0 ? 'Sin datos' : 'resultados'}</span>
        </div>
      </div>
      <p className="hint">
        {total === 0
          ? 'No hay resultados en el ámbito elegido.'
          : 'Cada porción usa la cantidad real del resumen. No es un porcentaje de protección.'}
      </p>
    </div>
  );
}
