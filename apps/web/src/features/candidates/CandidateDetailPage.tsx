import { PagePlaceholder } from '../../components/PagePlaceholder';

/**
 * RC-06 — Candidate detail.
 *
 * Routed now so the breadcrumb's deepest level is real rather than theoretical
 * (§4.1: `Jobs › {Job} › Candidates › {Candidate}`).
 *
 * TODO(later step): reads `GET /v1/applications/:id`. The route parameter is
 * an APPLICATION id, not a candidate id — a person can apply to several jobs,
 * and the assessment being read belongs to one application. Score override
 * (RC-07), scorecards (RC-13) and scheduling (RC-11) are separate screens and
 * are not part of the agreed scope.
 */
export function CandidateDetailPage() {
  return (
    <PagePlaceholder
      code="RC-06"
      title="Candidate"
      purpose="One candidate's application: profile, stage history, and the rationale behind any score."
      arrivesIn="a later step"
    />
  );
}
