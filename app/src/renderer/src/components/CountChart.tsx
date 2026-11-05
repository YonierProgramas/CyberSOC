import type { CountRow } from '../dashboard/present';
import { barHeight } from '../dashboard/present';

export function CountChart({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: readonly CountRow[];
  testId: string;
}) {
  const max = rows.reduce((highest, row) => Math.max(highest, row.count), 0);
  const width = Math.max(rows.length, 1) * 28;
  return (
    <div className="chart-block" data-testid={testId}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} 100`}
        role="img"
        aria-label={title}
        preserveAspectRatio="none"
      >
        <title>{title}</title>
        {rows.map((row, index) => {
          const height = barHeight(row.count, max);
          return (
            <rect
              key={row.key}
              x={index * 28 + 4}
              y={100 - height}
              width={20}
              height={height}
              fill="#73c7da"
            >
              <title>{`${row.label}: ${row.count}`}</title>
            </rect>
          );
        })}
      </svg>
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
              <th scope="row">{row.label}</th>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
