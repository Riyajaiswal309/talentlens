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
  /** Phase 1 screen code, shown in the sidebar so the build maps to the doc. */
  code: string;
  label: string;
  /** Absent while the screen is unbuilt — the item renders disabled. */
  to?: string;
  /** Marks the section active for any nested route beneath it. */
  matchPrefix?: string;
}

export const RECRUITER_NAVIGATION: readonly NavigationItem[] = [
  { code: 'RC-01', label: 'Dashboard', to: '/dashboard', matchPrefix: '/dashboard' },
  { code: 'RC-02', label: 'Jobs', to: '/jobs', matchPrefix: '/jobs' },
  { code: 'RC-14', label: 'Review queue' },
  { code: 'RC-11', label: 'Interviews' },
  { code: 'RC-12', label: 'Analytics', to: '/analytics', matchPrefix: '/analytics' },
];
