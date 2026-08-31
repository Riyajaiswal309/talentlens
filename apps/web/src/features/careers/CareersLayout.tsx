import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LogoMark } from '../../components/icons';
import { buttonClass } from '../../components/ui';

/**
 * The public careers shell (FR2.4).
 *
 * A SEPARATE SHELL FROM `RecruiterLayout`, deliberately. That layout renders a
 * sidebar of tenant-scoped destinations and an account block reading
 * `useAuth()`; a candidate has neither a session nor any business seeing those
 * links. Reusing it would mean rendering navigation to screens that would
 * refuse them.
 *
 * It keeps the marketing header's shape so the careers site reads as the same
 * product, with one `<main id="main">` per page for the skip target and a
 * single `h1` owned by the page inside it.
 */
export function CareersLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-neutral-0/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 rounded-sm">
            <LogoMark />
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              TalentLens
            </span>
          </Link>

          <nav aria-label="Careers" className="flex items-center gap-2">
            <Link to="/careers" className={buttonClass('ghost', 'sm')}>
              Open roles
            </Link>
            {/*
              The recruiter sign-in, not a candidate one. There is no candidate
              login in this build — an application is submitted without an
              account — so labelling this "Sign in" without qualification would
              invite a candidate to look for credentials they were never given.
            */}
            <Link to="/login" className={buttonClass('secondary', 'sm')}>
              Employer sign in
            </Link>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 lg:py-14">
        {children}
      </main>

      <footer className="border-t border-neutral-200 bg-neutral-0 py-8">
        <div className="mx-auto max-w-5xl px-4 text-sm text-neutral-500 sm:px-6">
          TalentLens — AI-Powered Recruitment &amp; Applicant Tracking System.
        </div>
      </footer>
    </div>
  );
}
