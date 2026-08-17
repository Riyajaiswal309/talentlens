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
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <h2 className="text-base font-semibold text-neutral-900">Funnel</h2>
      <p className="mt-1 text-sm text-neutral-700">
        How many applications ever reached each stage, out of {totalApplications}{' '}
        {totalApplications === 1 ? 'application' : 'applications'}.
      </p>

      <ol className="mt-4 space-y-3">
        {stages.map((stage) => (
          <li key={stage.name}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-neutral-900">
                {stage.position}. {stage.name}
                {stage.isTerminal && (
                  // Stated, not coloured: a terminal stage is where candidates
                  // stop moving, which is a fact about the pipeline, not a
                  // judgement about the outcome.
                  <span className="ml-2 rounded-sm border border-neutral-300 px-1.5 py-0.5 text-xs font-normal text-neutral-500">
                    Terminal
                  </span>
                )}
              </p>
              <p className="text-sm text-neutral-700">
                <span className="font-mono font-semibold text-neutral-900">{stage.reached}</span>
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
    </section>
  );
}

function Bar({ reached, total, name }: { reached: number; total: number; name: string }) {
  // Guarded: a zero total would make every width NaN. With no applications the
  // track renders empty, which is the honest picture.
  const percent = total > 0 ? Math.round((reached / total) * 100) : 0;

  return (
    <div
      className="mt-1 h-3 w-full overflow-hidden rounded-sm bg-neutral-100"
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
      */}
      <div className="h-full rounded-sm bg-primary-700" style={{ width: `${percent}%` }} />
    </div>
  );
}
