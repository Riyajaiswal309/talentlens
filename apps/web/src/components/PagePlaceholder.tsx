/**
 * A screen that exists in the route table but is not built yet.
 *
 * DELIBERATELY NOT A MOCK-UP. It shows no rows, no scores and no counts —
 * because anything it displayed would be invented, and an invented screen is
 * indistinguishable from a finished one until someone checks the data. Naming
 * the Phase 1 screen code and the step that will build it keeps the gap
 * visible to anyone reading the app, including in a demo.
 */
export function PagePlaceholder({
  code,
  title,
  purpose,
  arrivesIn,
}: {
  /** Phase 1 Table 5.1 screen code, e.g. `RC-04`. */
  code: string;
  title: string;
  /** What the finished screen will do, from the inventory. */
  purpose: string;
  arrivesIn: string;
}) {
  return (
    <div>
      <div className="mb-6">
        <p className="font-mono text-xs text-neutral-500">{code}</p>
        <h1 className="text-2xl font-semibold text-neutral-900">{title}</h1>
      </div>

      <div className="rounded-md border border-neutral-300 bg-neutral-0 px-6 py-12 text-center">
        <h2 className="text-base font-semibold text-neutral-900">Not built yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-700">{purpose}</p>
        <p className="mx-auto mt-3 max-w-md text-sm text-neutral-500">
          Arrives in {arrivesIn}. Nothing is displayed here until it reads real data from the API.
        </p>
      </div>
    </div>
  );
}
