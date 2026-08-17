import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { RequireRole } from './auth/RequireRole';
import { RecruiterLayout } from './layouts/RecruiterLayout';
import { LoginPage } from './features/auth/LoginPage';
import { JobListPage } from './features/jobs/JobListPage';
import { JobDetailPage } from './features/jobs/JobDetailPage';
import { CandidateListPage } from './features/candidates/CandidateListPage';
import { CandidateDetailPage } from './features/candidates/CandidateDetailPage';

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
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<RequireRole />}>
          <Route element={<RecruiterLayout />}>
            <Route path="/jobs" element={<JobListPage />} />
            <Route path="/jobs/:jobId" element={<JobDetailPage />} />
            <Route path="/jobs/:jobId/candidates" element={<CandidateListPage />} />
            {/*
              The parameter is an APPLICATION id, not a person's id: the record
              being read is one candidate's application to THIS job. Named for
              what the URL reads as, documented for what it holds.
            */}
            <Route
              path="/jobs/:jobId/candidates/:applicationId"
              element={<CandidateDetailPage />}
            />
          </Route>
        </Route>
      </Route>

      {/* Unknown paths go to the workspace, which redirects to /login when
          there is no session — so one rule covers both cases. */}
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
