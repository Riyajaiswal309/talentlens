import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { BreadcrumbProvider, Breadcrumbs } from './Breadcrumbs';
import { RECRUITER_NAVIGATION, type NavigationItem } from './navigation';

/**
 * The recruiter workspace shell (Phase 1 §4.1).
 *
 * Sidebar plus content, which is the layout the IA implies: a recruiter works
 * inside one job for long stretches, so the top-level sections stay visible
 * rather than collapsing into a menu that must be reopened each time.
 *
 * RESPONSIVE BY DISCLOSURE. At `lg` and above the sidebar is permanent; below
 * it becomes an overlay drawer. The two hosts share one `SidebarContent`, so
 * the small screen cannot drift out of step with the large one.
 */
export function RecruiterLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();

  // Navigating closes the drawer. Without this it stays open over the page the
  // user just asked for, which reads as the tap having failed.
  useEffect(() => setDrawerOpen(false), [pathname]);

  // Escape closes it — expected of any overlay, and the only exit for a
  // keyboard user who cannot click the scrim.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  return (
    <BreadcrumbProvider>
      <div className="min-h-screen bg-neutral-100">
        <MobileHeader onOpen={() => setDrawerOpen(true)} />

        {/* Permanent rail, large viewports only. */}
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-neutral-300 bg-neutral-0 lg:flex lg:flex-col">
          <SidebarContent />
        </aside>

        {/*
          MOUNTED ONLY WHILE OPEN. A drawer left in the DOM but pushed
          off-screen keeps its links in the tab order, stranding a keyboard
          user in navigation they cannot see. Unmounting is the simplest
          correct answer and needs no `inert` polyfill (NFR4).
        */}
        {drawerOpen && (
          <>
            <div
              className="fixed inset-0 z-30 bg-neutral-900/40 lg:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <aside className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-neutral-300 bg-neutral-0 lg:hidden">
              <SidebarContent onClose={() => setDrawerOpen(false)} />
            </aside>
          </>
        )}

        <div className="lg:pl-64">
          <main id="main" className="mx-auto max-w-6xl px-4 py-6 lg:px-8 lg:py-8">
            <Breadcrumbs />
            <Outlet />
          </main>
        </div>
      </div>
    </BreadcrumbProvider>
  );
}

function MobileHeader({ onOpen }: { onOpen: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-neutral-300 bg-neutral-0 px-4 lg:hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open navigation"
        className="h-10 rounded-md border border-neutral-300 px-3 text-sm font-semibold text-neutral-900"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <span className="text-base font-semibold text-neutral-900">TalentLens</span>
    </header>
  );
}

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const { user, signOut } = useAuth();

  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-neutral-300 px-4">
        <Link to="/jobs" className="rounded-sm text-base font-semibold text-neutral-900">
          TalentLens
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="h-8 rounded-sm px-2 text-sm text-neutral-500"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>

      <nav aria-label="Recruiter" className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {RECRUITER_NAVIGATION.map((item) => (
            <li key={item.code}>
              <NavigationEntry item={item} />
            </li>
          ))}
        </ul>
      </nav>

      {/* Account area — §4.1's "Account → Profile / sign out". */}
      <div className="border-t border-neutral-300 p-3">
        <div className="px-2 py-1">
          <p className="truncate text-sm font-semibold text-neutral-900" title={user?.email}>
            {user?.email}
          </p>
          <p className="text-xs text-neutral-500">{formatRole(user?.role)}</p>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-2 h-10 w-full rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
        >
          Sign out
        </button>
      </div>
    </>
  );
}

function NavigationEntry({ item }: { item: NavigationItem }) {
  const { pathname } = useLocation();

  /*
   * An unbuilt destination is a disabled <span>, never a link. A link to a
   * route that does not exist would land on the catch-all redirect and look
   * like the app losing the user's click.
   */
  if (!item.to) {
    return (
      <span
        aria-disabled="true"
        className="flex cursor-not-allowed items-center justify-between rounded-sm px-3 py-2 text-sm text-neutral-300"
      >
        <span>{item.label}</span>
        <span className="text-xs uppercase tracking-wide">Later</span>
      </span>
    );
  }

  // Active for the section, not just the exact path, so a nested candidate
  // page still shows Jobs as the section the user is inside.
  const active = item.matchPrefix
    ? pathname === item.matchPrefix || pathname.startsWith(`${item.matchPrefix}/`)
    : false;

  return (
    <NavLink
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center justify-between rounded-sm px-3 py-2 text-sm ${
        active
          ? 'bg-primary-50 font-semibold text-primary-700'
          : 'text-neutral-700 hover:bg-neutral-100'
      }`}
    >
      <span>{item.label}</span>
      <span className="font-mono text-xs text-neutral-500">{item.code}</span>
    </NavLink>
  );
}

/** `HIRING_MANAGER` is not a label; §24.2's role names need casing for display. */
function formatRole(role: string | undefined): string {
  if (!role) return '';
  return role
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
