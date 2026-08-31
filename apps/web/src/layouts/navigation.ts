import type { ComponentType } from 'react';
import {
  CalendarIcon,
  ChartIcon,
  DashboardIcon,
  BriefcaseIcon,
  InboxIcon,
  ShieldIcon,
  UsersIcon,
} from '../components/icons';

/**
 * The recruiter information architecture, verbatim from Phase 1 §4.1.
 *
 * THE WHOLE IA IS LISTED, INCLUDING WHAT IS NOT BUILT. Hiding the unbuilt
 * destinations would misrepresent the product's shape; linking them would
 * promise screens that do not exist. So each entry carries `to` only when it
 * leads somewhere real, and the rest render as plainly disabled.
 *
 * §4.1 also specifies global search and notifications as secondary navigation.
 * Both are omitted rather than stubbed: no endpoint backs either one, so even
 * a disabled control would imply a feature the API cannot serve.
 */
export interface NavigationItem {
  /** Phase 1 screen code. Kept as the stable key and for traceability. */
  code: string;
  label: string;
  /** Absent while the screen is unbuilt — the item renders disabled. */
  to?: string;
  /** Marks the section active for any nested route beneath it. */
  matchPrefix?: string;
  /** Decorative only — every entry also carries its text label (WCAG 1.1.1). */
  icon?: ComponentType<{ className?: string }>;
}

export const RECRUITER_NAVIGATION: readonly NavigationItem[] = [
  {
    code: 'RC-01',
    label: 'Dashboard',
    to: '/dashboard',
    matchPrefix: '/dashboard',
    icon: DashboardIcon,
  },
  { code: 'RC-02', label: 'Jobs', to: '/jobs', matchPrefix: '/jobs', icon: BriefcaseIcon },
  { code: 'RC-14', label: 'Review queue', icon: InboxIcon },
  /*
   * RC-11 stays disabled even though scheduling now works.
   *
   * NOT AN UNBUILT CAPABILITY — a recruiter arranges interviews from the
   * candidate page, where an interview actually belongs. What is missing is a
   * DESTINATION: the API exposes interviews only as
   * `GET /v1/applications/:id/interviews`, with no tenant-wide list, so a
   * top-level screen would have nothing to render. Linking it here would
   * promise a page that cannot be built without a new endpoint.
   */
  { code: 'RC-11', label: 'Interviews', icon: CalendarIcon },
  {
    code: 'RC-12',
    label: 'Analytics',
    to: '/analytics',
    matchPrefix: '/analytics',
    icon: ChartIcon,
  },
];

/**
 * Administrator-only navigation (FR8.1, FR8.3, FR8.4).
 *
 * A SEPARATE LIST, rendered only for ADMIN. Showing these to a Recruiter and
 * disabling them would advertise a surface their role does not have, and
 * linking them would land on `RequireRole`'s refusal — neither is useful. A
 * Recruiter simply never sees the section.
 */
export const ADMIN_NAVIGATION: readonly NavigationItem[] = [
  {
    code: 'FR8.1',
    label: 'Users',
    to: '/admin/users',
    matchPrefix: '/admin/users',
    icon: UsersIcon,
  },
  {
    code: 'FR8.3',
    label: 'Audit log',
    to: '/admin/audit',
    matchPrefix: '/admin/audit',
    icon: ShieldIcon,
  },
];
