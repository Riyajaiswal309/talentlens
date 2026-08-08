import { USER_ROLES, DEFAULT_PIPELINE_STAGES } from '@talentlens/shared-types';

/**
 * M2.1 placeholder shell.
 *
 * This is scaffolding only — it exists to prove the toolchain (React, Vite,
 * Tailwind, TypeScript, workspace imports) is wired end to end. Real screens
 * follow the Phase 1 inventory from M2.6 onward and are NOT designed here.
 */
export function App() {
  return (
    <main className="min-h-screen bg-neutral-100 p-8 font-sans text-neutral-900">
      <div className="mx-auto max-w-2xl rounded-md border border-neutral-300 bg-neutral-0 p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">TalentLens</h1>
        <p className="mt-1 text-sm text-neutral-700">
          AI-Powered Recruitment &amp; Applicant Tracking System
        </p>

        <div className="mt-6 rounded-sm bg-primary-50 p-4 text-sm">
          <p className="font-semibold text-primary-700">Milestone M2.1 — workspace scaffold</p>
          <p className="mt-1 text-neutral-700">
            Toolchain verified. No business features are implemented yet.
          </p>
        </div>

        <dl className="mt-6 space-y-3 text-sm">
          <div>
            <dt className="font-semibold">Roles (PRD §24.2)</dt>
            <dd className="text-neutral-700">{USER_ROLES.join(' · ')}</dd>
          </div>
          <div>
            <dt className="font-semibold">Default pipeline stages (PRD §14.1)</dt>
            <dd className="text-neutral-700">{DEFAULT_PIPELINE_STAGES.join(' → ')}</dd>
            <dd className="mt-1 text-xs text-neutral-500">
              Defaults only — configurable per job (FR5.1, decision B2).
            </dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
