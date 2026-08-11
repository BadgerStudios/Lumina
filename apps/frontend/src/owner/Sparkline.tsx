/**
 * Inline-SVG sparkline and bar chart. No charting library on purpose — these render a single series
 * of ~30 points, which is a handful of lines of path maths, and pulling in a chart dependency would
 * add far more bundle weight than the whole owner app.
 *
 * `currentColor` throughout so a chart takes its colour from whatever text colour the surrounding
 * card sets, which keeps the theme in one place instead of hardcoding hex values per chart.
 */

interface SparklineProps {
  values: number[];
  height?: number;
  className?: string;
  /** Fills the area under the line. Reads better for cumulative-feeling metrics like bandwidth. */
  filled?: boolean;
}

export function Sparkline({ values, height = 40, className, filled = true }: SparklineProps) {
  if (values.length === 0) return <div style={{ height }} />;

  const width = 100;
  const max = Math.max(...values, 1);
  // A flat all-zero series should sit on the baseline rather than through the middle, which is what
  // dividing by a max of 1 achieves.
  const points = values.map((v, i) => {
    const x = values.length === 1 ? width : (i / (values.length - 1)) * width;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const linePath = `M ${points.join(" L ")}`;
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: "100%", height }}
      role="img"
      aria-label={`Trend chart, latest value ${values[values.length - 1]}`}
    >
      {filled && <path d={areaPath} fill="currentColor" opacity={0.15} />}
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Discrete daily counts read better as bars than as a continuous line — a line implies values
 * between the days, which for "downloads on the 4th" is meaningless. */
export function MiniBars({ values, height = 40, className }: { values: number[]; height?: number; className?: string }) {
  if (values.length === 0) return <div style={{ height }} />;
  const max = Math.max(...values, 1);
  const gap = 1;
  const barWidth = Math.max(0.5, (100 - gap * (values.length - 1)) / values.length);

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: "100%", height }}
      role="img"
      aria-label={`Daily counts, latest ${values[values.length - 1]}`}
    >
      {values.map((v, i) => {
        const h = (v / max) * (height - 2);
        return (
          <rect
            key={i}
            x={i * (barWidth + gap)}
            // Zero-height bars are still drawn as a 1px stub so an empty day reads as "no activity"
            // rather than as missing data.
            y={height - Math.max(h, 1)}
            width={barWidth}
            height={Math.max(h, 1)}
            fill="currentColor"
            opacity={v === 0 ? 0.2 : 0.9}
          />
        );
      })}
    </svg>
  );
}
