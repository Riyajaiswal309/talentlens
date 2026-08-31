import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { RequireRole, HIRING_TEAM_ROLES } from './auth/RequireRole';
import { RecruiterLayout } from './layouts/RecruiterLayout';
import { LoginPage } from './features/auth/LoginPage';
import { LandingPage } from './features/marketing/LandingPage';
import { PublicJobsPage } from './features/careers/PublicJobsPage';
import { PublicJobDetailPage } from './features/careers/PublicJobDetailPage';
import { ApplyPage } from './features/careers/ApplyPage';
import { CandidateSchedulePage } from './features/scheduling/CandidateSchedulePage';
import { JobListPage } from './features/jobs/JobListPage';
import { JobDetailPage } from './features/jobs/JobDetailPage';
import { JobCreatePage } from './features/jobs/JobCreatePage';
import { JobEditPage } from './features/jobs/JobEditPage';
import { CandidateListPage } from './features/candidates/CandidateListPage';
import { CandidateRoute } from './features/candidates/CandidateRoute';
import { FunnelPage } from './features/analytics/FunnelPage';
import { PipelineBoard } from './features/pipeline/PipelineBoard';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { RankingWeightsPage } from './features/jobs/RankingWeightsPage';
import { AdminUsersPage } from './features/admin/AdminUsersPage';
import { AuditLogPage } from './features/admin/AuditLogPage';
import { MyReviewsPage } from './features/reviews/MyReviewsPage';
import { RoleLanding } from './auth/RoleLanding';

/**
 * Route table.
 *
 * THREE LAYERS, NESTED, IN THIS ORDER. `RequireAuth` establishes that there is
 * a principal; `RequireRole` asks whether that principal belongs here; only
 * then does `RecruiterLayout` draw the workspace. The order matters twice
 * over — asking about a role before knowing there is a user would tell a
 * signed-out visitor "not available to you" when the honest answer is "sign in
 * first", and rendering the shell before either check would flash a sidebar at
 * someone who is about to be redirected away from it.
 *
 * The URL hierarchy is §4.1's IA read literally, which is what makes the
 * breadcrumb derivable from the path alone:
 *   /jobs → /jobs/:jobId → /jobs/:jobId/candidates → …/:applicationId
 */
export function App() {
  return (
    <Routes>
      {/*
        PUBLIC. The marketing page is the only route besides /login outside the
        guards. It reads no API, so there is no tenant data on it to protect —
        and it must stay that way: a data call here would run unauthenticated.
      */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />

      {/*
        PUBLIC CAREERS (FR2.1, FR2.4). Outside every guard, deliberately: a
        candidate has no account, and `GET /v1/public/jobs` plus
        `POST /v1/applications` are `@Public()` for exactly this flow. These
        routes must never call a tenant-scoped endpoint — there is no session to
        scope them with.
      */}
      <Route path="/careers" element={<PublicJobsPage />} />
      <Route path="/careers/:jobId" element={<PublicJobDetailPage />} />
      <Route path="/careers/:jobId/apply" element={<ApplyPage />} />

      {/*
        PUBLIC SCHEDULING (FR6.2). Outside every guard for the same reason as
        the careers routes, and one more besides: `GET /v1/scheduling/:token`
        and its confirm are `@Public()` because the signed token IS the
        credential. Putting this behind `RequireAuth` would lock out the only
        person it is meant for — a candidate, who has no account in this build.
      */}
      <Route path="/schedule/:token" element={<CandidateSchedulePage />} />

      <Route element={<RequireAuth />}>
        <Route element={<RequireRole />}>
          <Route element={<RecruiterLayout />}>
            {/* RC-01. Tenant-wide, like RC-12 — it summarises every requisition
                rather than sitting inside one. */}
            <Route path="/dashboard" element={<DashboardPage />} />

            {/*
              Declared before `/jobs/:jobId` for readability. React Router v6
              ranks a static segment above a dynamic one regardless of order, so
              `/jobs/new` cannot be swallowed as a job id — but stating it here
              keeps that guarantee visible rather than implicit.
            */}
            <Route path="/jobs/new" element={<JobCreatePage />} />
            <Route path="/jobs/:jobId" element={<JobDetailPage />} />
            <Route path="/jobs/:jobId/edit" element={<JobEditPage />} />

            {/* RC-09. A tab of the job hub, so it sits under the job's path. */}
            <Route path="/jobs/:jobId/pipeline" element={<PipelineBoard />} />
            {/* RC-08. Also a job tab — the weighting is per requisition. */}
            <Route path="/jobs/:jobId/ranking-weights" element={<RankingWeightsPage />} />

            {/* RC-12. Tenant-wide, so it sits beside /jobs rather than under a
                job — the funnel is not scoped to one requisition unless the
                caller filters it to one. */}
            <Route path="/analytics" element={<FunnelPage />} />
          </Route>
        </Route>

        {/*
          THE WHOLE HIRING TEAM (§24.2) — a SIBLING of the recruiter gate so it
          widens the role rather than inheriting RECRUITER|ADMIN.

          These four screens call only endpoints that already name
          HIRING_MANAGER on their `@Roles`, and `GET /v1/jobs` narrows itself to
          the caller's assignments server-side. The route grants nothing: an
          unassigned job is a 404 from `JobAssignmentGuard` whatever this table
          says, and a Hiring Manager who types `/analytics` still meets the
          recruiter gate above.
        */}
        <Route element={<RequireRole allow={HIRING_TEAM_ROLES} />}>
          <Route element={<RecruiterLayout />}>
            <Route path="/my-reviews" element={<MyReviewsPage />} />
            <Route path="/jobs" element={<JobListPage />} />
            <Route path="/jobs/:jobId/candidates" element={<CandidateListPage />} />
            {/*
              The parameter is an APPLICATION id, not a person's id: the record
              being read is one candidate's application to THIS job.

              ONE PATH, TWO SCREENS. `CandidateRoute` picks RC-06 or HM-03 by
              role — declaring the path twice under different gates would let
              the recruiter entry match first and refuse the Hiring Manager.
            */}
            <Route path="/jobs/:jobId/candidates/:applicationId" element={<CandidateRoute />} />
          </Route>
        </Route>

        {/*
          ADMINISTRATOR ONLY (FR8.1) — a SIBLING of the recruiter gate, not a
          child of it, so it narrows the role rather than inheriting
          RECRUITER|ADMIN. Every endpoint these screens call is `@Roles(ADMIN)`,
          so a Recruiter reaching them would meet a 403 on every request;
          refusing at the route states the reason once instead.
        */}
        <Route element={<RequireRole allow={['ADMIN']} />}>
          <Route element={<RecruiterLayout />}>
            <Route path="/admin/users" element={<AdminUsersPage />} />
            <Route path="/admin/audit" element={<AuditLogPage />} />
          </Route>
        </Route>
      </Route>

      {/*
        Unknown paths go to RC-01, the workspace's landing screen. `/` is no
        longer one of them — it now serves the public marketing page above.
        This route sits inside the guards, so a signed-out visitor is forwarded
        on to /login by `RequireAuth` and a Hiring Manager still meets
        `RequireRole`'s refusal: one rule covers both cases, and the redirect
        itself grants nothing.
      */}
      <Route path="*" element={<RoleLanding />} />
    </Routes>
  );
}
