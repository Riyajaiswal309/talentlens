import { formatRatio, type FunnelStage } from './useFunnel';

/**
 * The funnel chart (RC-12, FR7.1) — proportional horizontal bars.
 *
 * NO CHARTING LIBRARY, DELIBERATELY. The figure is six bars whose lengths are
 * `reached / totalApplications`; a library would add far more bundle than the
 * arithmetic saves, and §10.3 requires the number to appear alongside the bar
 * anyway, which is most of the work.
 *
 * COLOUR CARRIES NO VERDICT. §8.2 confines magnitude to the neutral/primary
 * ramp and reserves success/danger for semantics — so `Rejected` is not red and
 * `Hired` is not green. Encoding either would make the chart recommend an
 * outcome, which BR-01 forbids the system from doing.
 */
export function FunnelBars({
  stages,
  totalApplications,
}: {
  stages: FunnelStage[];
  totalApplications: number;
}) {
  return (
    <ol className="space-y-4">
      {stages.map((stage) => (
        <li key={stage.name}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
              <span className="font-mono text-xs text-neutral-400">{stage.position}</span>
              {stage.name}
              {stage.isTerminal && (
                // Stated, not coloured: a terminal stage is where candidates
                // stop moving, which is a fact about the pipeline, not a
                // judgement about the outcome.
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-neutral-500">
                  Terminal
                </span>
              )}
            </p>
            <p className="text-sm text-neutral-700">
              <span className="font-mono font-semibold tabular-nums text-neutral-900">
                {stage.reached}
              </span>
              {/* The API's own ratio, never recomputed here. */}
              <span className="ml-2 text-neutral-500">
                {formatRatio(stage.conversionFromStart)} of all
              </span>
            </p>
          </div>

          <Bar reached={stage.reached} total={totalApplications} name={stage.name} />
        </li>
      ))}
    </ol>
  );
}

function Bar({ reached, total, name }: { reached: number; total: number; name: string }) {
  // Guarded: a zero total would make every width NaN. With no applications the
  // track renders empty, which is the honest picture.
  const percent = total > 0 ? Math.round((reached / total) * 100) : 0;

  return (
    <div
      className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-neutral-100"
      /*
       * The bar is a graphic, so it carries the same numbers the text does —
       * a screen reader gets the value rather than an unlabelled box (NFR4).
       */
      role="img"
      aria-label={`${name}: ${reached} of ${total} applications`}
    >
      {/*
        A zero-width div is invisible, which is correct — an empty stage should
        read as empty rather than as a sliver of colour.

        §8.2 — the gradient stays inside the primary ramp. Magnitude never
        borrows success/danger, so the chart cannot imply a verdict (BR-01).
      */}
      <div
        className="h-full rounded-full bg-gradient-to-r from-primary-600 to-primary-700 transition-[width] duration-500 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
