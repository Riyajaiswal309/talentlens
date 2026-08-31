import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Shared presentation primitives.
 *
 * WHY THIS FILE EXISTS. Before it, every screen spelled out its own
 * `rounded-md border border-neutral-300 bg-neutral-0 p-4`, so "a card" meant
 * something slightly different on each page and a token change had to be made
 * in a dozen places. These are presentation only — no data fetching, no
 * business rules — so restyling never risks the behaviour underneath.
 *
 * The palette rules from §8.2 still bind here: score magnitude never uses
 * success/danger (BR-01), and every colour pairing is one Phase 1 verified.
 */

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary-700 text-neutral-0 hover:bg-primary-800 shadow-sm',
  secondary: 'border border-neutral-300 bg-neutral-0 text-neutral-900 hover:bg-neutral-100',
  ghost: 'text-neutral-700 hover:bg-neutral-100',
  danger: 'bg-danger-700 text-neutral-0 hover:opacity-90 shadow-sm',
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
};

/** Class string for a button or a link that should look like one. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]}`;
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = '',
  interactive = false,
  as: As = 'section',
}: {
  children: ReactNode;
  className?: string;
  /** Adds hover elevation. Only for cards that are themselves a link target. */
  interactive?: boolean;
  as?: 'section' | 'div' | 'article' | 'li';
}) {
  return (
    <As
      className={`rounded-lg border border-neutral-200 bg-neutral-0 shadow-card ${
        interactive ? 'transition-shadow duration-150 hover:shadow-card-hover' : ''
      } ${className}`}
    >
      {children}
    </As>
  );
}

/** Card header with an optional right-hand slot for actions or a link. */
export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
  primary: 'bg-primary-50 text-primary-700 ring-primary-200',
  success: 'bg-success-50 text-success-700 ring-success-200',
  warning: 'bg-warning-50 text-warning-700 ring-warning-200',
  danger: 'bg-danger-50 text-danger-700 ring-danger-200',
  info: 'bg-info-50 text-info-700 ring-info-200',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${BADGE_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A small dot used inside badges to carry the tone without relying on colour alone. */
export function Dot({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full bg-current ${className}`} />;
}

/* -------------------------------------------------------------------------- */
/* Page header                                                                 */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  code,
  title,
  description,
  actions,
}: {
  /** The requirement code (RC-01…), kept because it maps the UI to the spec. */
  code?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {code && (
          <p className="mb-1 font-mono text-2xs uppercase tracking-widest text-neutral-400">
            {code}
          </p>
        )}
        <h1 className="text-2xl font-semibold text-neutral-900 sm:text-[1.75rem]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-neutral-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat card                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One KPI.
 *
 * `value` is a string so the caller decides how an absent number reads. A
 * missing value must be passed as "—" with a hint explaining why — never as 0,
 * which would state a measurement that was never taken.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  muted = false,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  icon?: ReactNode;
  /** True when the value is unavailable rather than zero. */
  muted?: boolean;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
          <p
            className={`mt-2 text-3xl font-semibold tabular-nums ${
              muted ? 'text-neutral-300' : 'text-neutral-900'
            }`}
          >
            {value}
          </p>
        </div>
        {icon && (
          <span className="shrink-0 rounded-md bg-primary-50 p-2 text-primary-700">{icon}</span>
        )}
      </div>
      {hint && <p className="mt-2 text-xs leading-relaxed text-neutral-500">{hint}</p>}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/** A labelled value in a definition grid. Nullable fields say so explicitly. */
export function Field({ label, value }: { label: string; value: ReactNode }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className={`mt-1 text-sm ${empty ? 'text-neutral-400' : 'text-neutral-900'}`}>
        {empty ? 'Not recorded' : value}
      </dd>
    </div>
  );
}

/** Skill / keyword chip. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700">
      {children}
    </span>
  );
}

/**
 * An inline notice.
 *
 * `info` is §8.2's designated tone for an AI-disabled notice — deliberately not
 * a warning, because nothing is wrong: the feature is switched off.
 */
export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: ReactNode;
  children: ReactNode;
}) {
  const TONE: Record<BadgeTone, string> = {
    neutral: 'border-neutral-200 bg-neutral-50 text-neutral-700',
    primary: 'border-primary-200 bg-primary-50 text-primary-700',
    success: 'border-success-200 bg-success-50 text-success-700',
    warning: 'border-warning-200 bg-warning-50 text-warning-700',
    danger: 'border-danger-200 bg-danger-50 text-danger-700',
    info: 'border-info-200 bg-info-50 text-info-700',
  };
  return (
    <div className={`rounded-md border px-4 py-3 text-sm ${TONE[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? 'mt-0.5' : undefined}>{children}</div>
    </div>
  );
}

/** Avatar built from initials — no image endpoint exists, so none is implied. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

  const SIZE = {
    sm: 'h-8 w-8 text-xs',
    md: 'h-10 w-10 text-sm',
    lg: 'h-14 w-14 text-lg',
  } as const;

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary-50 font-semibold text-primary-700 ring-1 ring-inset ring-primary-100 ${SIZE[size]}`}
    >
      {initials || '?'}
    </span>
  );
}

/** Link styled as a button. */
export function ButtonLink({
  to,
  children,
  variant = 'primary',
  size = 'md',
}: {
  to: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <Link to={to} className={buttonClass(variant, size)}>
      {children}
    </Link>
  );
}
