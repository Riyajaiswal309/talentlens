import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { buttonClass } from '../../components/ui';
import {
  ArrowRightIcon,
  BriefcaseIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  ColumnsIcon,
  LogoMark,
  ShieldIcon,
  SparkIcon,
  UsersIcon,
} from '../../components/icons';

/**
 * The public landing page at `/`.
 *
 * PUBLIC BY DESIGN, and the only route outside the guards besides `/login`. It
 * reads no API and holds no candidate data, so there is nothing here to
 * protect — which is also why it must never grow a data call: adding one would
 * put tenant data on an unauthenticated page.
 *
 * WHAT IT CLAIMS. Every feature below is one this build actually ships, with a
 * single deliberate exception that is labelled as such: AI-assisted scoring
 * states plainly that no model is trained. The product is not sold as more than
 * it is — the same rule the console follows when it refuses to print a number
 * it cannot source.
 */
export function LandingPage() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';

  return (
    <div className="min-h-screen bg-neutral-0">
      <MarketingHeader signedIn={signedIn} />
      <main id="main">
        <Hero signedIn={signedIn} />
        <Features />
        <Governance />
        <ClosingCta signedIn={signedIn} />
      </main>
      <MarketingFooter />
    </div>
  );
}

function MarketingHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200 bg-neutral-0/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2.5 rounded-sm">
          <LogoMark />
          <span className="text-lg font-semibold tracking-tight text-neutral-900">TalentLens</span>
        </Link>

        <nav aria-label="Product" className="hidden items-center gap-8 md:flex">
          <a
            href="#features"
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            Features
          </a>
          <a
            href="#governance"
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            Governance
          </a>
          {/* The public careers site — the one destination here aimed at a
              candidate rather than an employer. */}
          <Link
            to="/careers"
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            Open roles
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          {signedIn ? (
            <Link to="/dashboard" className={buttonClass('primary', 'sm')}>
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className={buttonClass('ghost', 'sm')}>
                Sign in
              </Link>
              <Link to="/login" className={buttonClass('primary', 'sm')}>
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="relative overflow-hidden border-b border-neutral-200">
      {/* Decorative wash. Kept subtle — the brief is professional, not colourful. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_70%_-10%,theme(colors.primary.50),transparent)]"
      />

      <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <span className="inline-flex items-center gap-2 rounded-full bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-700 ring-1 ring-inset ring-primary-200">
              <SparkIcon className="h-3.5 w-3.5" />
              Applicant tracking, built for accountable hiring
            </span>

            <h1 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-neutral-900 sm:text-5xl">
              Hire faster without losing track of <span className="text-primary-700">why</span>.
            </h1>

            <p className="mt-5 max-w-xl text-lg leading-relaxed text-neutral-700">
              TalentLens is a multi-tenant applicant tracking system for recruiting teams. Publish
              roles, move candidates through a structured pipeline, capture scorecards, and read the
              funnel — with every decision attributable to a named human.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={signedIn ? '/dashboard' : '/login'} className={buttonClass('primary')}>
                {signedIn ? 'Go to dashboard' : 'Get started'}
                <ArrowRightIcon />
              </Link>
              <Link to="/careers" className={buttonClass('secondary')}>
                View open roles
              </Link>
            </div>

            <p className="mt-5 text-sm text-neutral-500">
              Four roles · six-stage pipeline · full audit trail
            </p>
          </div>

          {/* An abstract preview, not a screenshot: a fake screenshot would show
              numbers no API produced. Shapes only. */}
          <div className="lg:col-span-6">
            <PipelinePreview />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A stylised pipeline, drawn from static shapes.
 *
 * DELIBERATELY NOT A SCREENSHOT and deliberately not fed by the API — this page
 * is unauthenticated, so any real figure here would be a tenant data leak, and
 * an invented one would be the fabrication the whole project avoids. The column
 * labels are the six real stage names; the cards carry no names or numbers.
 */
function PipelinePreview() {
  const columns = [
    { name: 'Applied', cards: 3 },
    { name: 'Screening', cards: 2 },
    { name: 'Interview', cards: 2 },
    { name: 'Offer', cards: 1 },
  ];

  return (
    <div className="rounded-2xl border border-neutral-200 bg-neutral-0 p-4 shadow-lg">
      <div className="mb-4 flex items-center gap-2 border-b border-neutral-200 pb-3">
        <span className="h-2.5 w-2.5 rounded-full bg-danger-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-success-200" />
        <span className="ml-2 text-xs font-medium text-neutral-500">Pipeline · Engineering</span>
      </div>

      <div className="grid grid-cols-4 gap-2.5">
        {columns.map((column) => (
          <div key={column.name} className="rounded-lg bg-neutral-50 p-2.5">
            <p className="mb-2 truncate text-2xs font-semibold uppercase tracking-wide text-neutral-500">
              {column.name}
            </p>
            <div className="space-y-2">
              {Array.from({ length: column.cards }).map((_, index) => (
                <div
                  key={index}
                  className="rounded-md border border-neutral-200 bg-neutral-0 p-2 shadow-sm"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="h-4 w-4 rounded-full bg-primary-100" />
                    <span className="h-1.5 flex-1 rounded-full bg-neutral-200" />
                  </div>
                  <span className="mt-1.5 block h-1.5 w-2/3 rounded-full bg-neutral-100" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: BriefcaseIcon,
    title: 'Jobs',
    body: 'Create, publish, edit, close and duplicate requisitions. Status transitions are constrained to what the API accepts, so no action is offered that would fail.',
  },
  {
    icon: UsersIcon,
    title: 'Candidate management',
    body: 'Every applicant for a role in one list, with the full application record: details, threaded comments and the reviewer feedback attached to them.',
  },
  {
    icon: ColumnsIcon,
    title: 'Application pipeline',
    body: 'A six-stage board with single and bulk moves. Stages are configurable per job, and terminal stages require explicit human confirmation.',
  },
  {
    icon: CalendarIcon,
    title: 'Interviews',
    body: 'Interviews scheduled against an application, with candidate-facing scheduling links signed by a single-purpose expiring token.',
  },
  {
    icon: SparkIcon,
    title: 'AI-assisted scoring',
    body: 'The scoring seam is built end to end — ranking weights, a fixed six-feature input contract and an explainability requirement. No model is trained in this build, and the interface says so rather than showing a score.',
    caveat: true,
  },
  {
    icon: ChartIcon,
    title: 'Analytics',
    body: 'A conversion funnel with drop-off, median time in stage, time to hire and source of hire. Every value comes from the API; a null renders as a dash, never as zero.',
  },
  {
    icon: ShieldIcon,
    title: 'Role-based security',
    body: 'Four roles enforced server-side. Short-lived tokens, a rotating single-use refresh cookie, and reuse detection that revokes every live session.',
  },
  {
    icon: BuildingIcon,
    title: 'Multi-tenant architecture',
    body: 'Every query is scoped by company, and a record in another tenant returns 404 rather than 403 — so a status code can never confirm that a record exists.',
  },
];

function Features() {
  return (
    <section id="features" className="border-b border-neutral-200 bg-neutral-50 py-20 lg:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
            Everything a recruiting team needs to run a role
          </h2>
          <p className="mt-4 text-base leading-relaxed text-neutral-700">
            Eleven recruiter screens, one API, and a rule that runs through all of it: the system
            ranks and explains, a human decides.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <article
              key={feature.title}
              className="group rounded-lg border border-neutral-200 bg-neutral-0 p-5 shadow-card transition-shadow duration-150 hover:shadow-card-hover"
            >
              <span className="inline-flex rounded-md bg-primary-50 p-2.5 text-primary-700 ring-1 ring-inset ring-primary-100">
                <feature.icon />
              </span>
              <h3 className="mt-4 text-base font-semibold text-neutral-900">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-700">{feature.body}</p>
              {feature.caveat && (
                <p className="mt-3 inline-flex rounded-md bg-info-50 px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-info-700 ring-1 ring-inset ring-info-200">
                  Integration ready · model not trained
                </p>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const RULES = [
  ['No candidate is rejected by AI', 'Terminal stage changes require a human actor.'],
  ['No score without a rationale', 'Enforced at the database level, not by convention.'],
  ['Every override is audited', 'With a reason, written before the response returns.'],
  ['No protected attribute is an input', 'A fixed six-feature allow-list, enforced in code.'],
];

function Governance() {
  return (
    <section id="governance" className="border-b border-neutral-200 py-20 lg:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">
              Built so a hiring decision can always be explained
            </h2>
            <p className="mt-4 text-base leading-relaxed text-neutral-700">
              Screening at volume goes wrong in two ways: it becomes inconsistent, or it becomes
              automated past the point anyone can account for. TalentLens treats that as a
              governance problem. Scoring is advisory, a score cannot exist without a stored
              rationale, and every consequential write lands in an append-only audit log.
            </p>
            <p className="mt-4 text-base leading-relaxed text-neutral-700">
              Where the system has no data, the interface says so — instead of printing a zero that
              would read as a finding.
            </p>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2">
            {RULES.map(([title, body]) => (
              <li
                key={title}
                className="rounded-lg border border-neutral-200 bg-neutral-0 p-4 shadow-card"
              >
                <p className="text-sm font-semibold text-neutral-900">{title}</p>
                <p className="mt-1 text-sm text-neutral-500">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ClosingCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="bg-neutral-900 py-16 lg:py-20">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 sm:px-6 lg:flex-row lg:items-center lg:px-8">
        <div>
          <h2 className="text-2xl font-semibold text-neutral-0 sm:text-3xl">
            Open the recruiter console
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-neutral-300">
            Sign in to see live requisitions, the candidate pipeline and the hiring funnel.
          </p>
        </div>
        <Link
          to={signedIn ? '/dashboard' : '/login'}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-neutral-0 px-5 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100"
        >
          {signedIn ? 'Go to dashboard' : 'Sign in'}
          <ArrowRightIcon />
        </Link>
      </div>
    </section>
  );
}

function MarketingFooter() {
  return (
    <footer className="border-t border-neutral-200 bg-neutral-0 py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex items-center gap-2.5">
          <LogoMark className="h-7 w-7" />
          <span className="text-sm font-semibold text-neutral-900">TalentLens</span>
        </div>
        <p className="text-sm text-neutral-500">
          AI-Powered Recruitment &amp; Applicant Tracking System — final-year project, 2026–27.
        </p>
      </div>
    </footer>
  );
}
