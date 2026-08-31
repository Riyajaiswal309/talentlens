import { Badge, Dot, type BadgeTone } from '../../components/ui';

/**
 * Job status and AI-scoring badges (Table 5.1 — RC-02 displays "status" and
 * "AI status").
 *
 * COLOUR IS RESTRAINED ON PURPOSE. §8.2's semantic rule forbids encoding
 * magnitude in success/danger, and while a job status is not a score, CLOSED
 * is not a failure either — a filled role is the successful outcome. So CLOSED
 * is muted rather than red, and only PUBLISHED, which means "live and
 * accepting applications", carries success/700.
 *
 * The dot is decorative; the word beside it carries the meaning, so status is
 * never conveyed by colour alone (WCAG 1.4.1).
 */
export function JobStatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === 'PUBLISHED' ? 'success' : status === 'DRAFT' ? 'neutral' : 'neutral';

  return (
    <Badge tone={tone} className={status === 'CLOSED' ? 'opacity-70' : undefined}>
      <Dot />
      {label(status)}
    </Badge>
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
  return enabled ? (
    <Badge tone="neutral">AI scoring on</Badge>
  ) : (
    <Badge tone="info">AI scoring off</Badge>
  );
}

/** `HIRING_MANAGER`-style constants are not display text. */
function label(status: string): string {
  if (!status) return '';
  return status[0]! + status.slice(1).toLowerCase();
}
