/**
 * Job status and AI-scoring badges (Table 5.1 — RC-02 displays "status" and
 * "AI status").
 *
 * COLOUR IS RESTRAINED ON PURPOSE. §8.2's semantic rule forbids encoding
 * magnitude in success/danger, and while a job status is not a score, CLOSED
 * is not a failure either — a filled role is the successful outcome. So CLOSED
 * is muted rather than red, and only PUBLISHED, which means "live and
 * accepting applications", carries success/700.
 */
export function JobStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'PUBLISHED'
      ? 'border-success-700 text-success-700'
      : status === 'DRAFT'
        ? 'border-neutral-300 text-neutral-700'
        : 'border-neutral-300 text-neutral-500';

  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-semibold ${tone}`}
    >
      {label(status)}
    </span>
  );
}

/**
 * FR4.5 / BR-04 — whether this job is scored, shown read-only.
 *
 * info/700 is §8.2's designated colour for "AI-disabled notices", and the
 * disabled case is the one worth stating: every seeded job has scoring off, so
 * a recruiter needs to know the candidate list is unranked rather than
 * assuming the ranking is simply poor.
 */
export function AiScoringBadge({ enabled }: { enabled: boolean }) {
  if (enabled) {
    return (
      <span className="inline-flex items-center rounded-sm border border-neutral-300 px-2 py-0.5 text-xs font-semibold text-neutral-700">
        AI scoring on
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-sm border border-info-700 px-2 py-0.5 text-xs font-semibold text-info-700">
      AI scoring off
    </span>
  );
}

/** `HIRING_MANAGER`-style constants are not display text. */
function label(status: string): string {
  if (!status) return '';
  return status[0]! + status.slice(1).toLowerCase();
}
