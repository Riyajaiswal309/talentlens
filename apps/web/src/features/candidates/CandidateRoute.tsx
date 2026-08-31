import { useAuth } from '../../auth/AuthContext';
import { CandidateDetailPage } from './CandidateDetailPage';
import { HiringManagerCandidatePage } from './HiringManagerCandidatePage';

/**
 * One URL, two screens (RC-06 and HM-03).
 *
 * WHY A DISPATCHER RATHER THAN TWO ROUTES. `/jobs/:jobId/candidates/:id` is the
 * same resource for both personas, and the breadcrumb, the "My reviews" links
 * and every candidate row already point at it. Declaring the path twice under
 * different role gates would not work: React Router matches the FIRST route
 * whose path fits, so a Hiring Manager would land on the recruiter entry and
 * meet `RequireRole`'s refusal instead of their own screen.
 *
 * The two pages are genuinely different reads, not one page with fields hidden.
 * RC-06 is built on `GET /v1/applications/:id`, which excludes HIRING_MANAGER
 * (Handoff row 13); HM-03 assembles the same candidate from the endpoints that
 * role does hold. Choosing between them here keeps that difference in one
 * place instead of scattering role checks through a shared component.
 *
 * NOT A SECURITY BOUNDARY. Pointing a Hiring Manager at RC-06 would simply
 * produce a 403 from the API; this only decides which screen is worth
 * rendering.
 */
export function CandidateRoute() {
  const { user } = useAuth();

  return user?.role === 'HIRING_MANAGER' ? <HiringManagerCandidatePage /> : <CandidateDetailPage />;
}
