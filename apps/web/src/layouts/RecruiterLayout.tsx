import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { CloseIcon, LogoMark, LogoutIcon, MenuIcon } from '../components/icons';
import { BreadcrumbProvider, Breadcrumbs } from './Breadcrumbs';
import { ADMIN_NAVIGATION, RECRUITER_NAVIGATION, type NavigationItem } from './navigation';

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
      <div className="min-h-screen bg-neutral-50">
        <MobileHeader onOpen={() => setDrawerOpen(true)} />

        {/* Permanent rail, large viewports only. */}
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col bg-neutral-950 lg:flex">
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
              className="fixed inset-0 z-30 bg-neutral-900/50 backdrop-blur-sm lg:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <aside className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-neutral-950 lg:hidden">
              <SidebarContent onClose={() => setDrawerOpen(false)} />
            </aside>
          </>
        )}

        <div className="lg:pl-64">
          <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
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
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-neutral-200 bg-neutral-0/90 px-4 backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open navigation"
        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-neutral-200 text-neutral-700 transition-colors hover:bg-neutral-100"
      >
        <MenuIcon />
      </button>
      <Link to="/dashboard" className="flex items-center gap-2 rounded-sm">
        <LogoMark className="h-7 w-7" />
        <span className="text-base font-semibold text-neutral-900">TalentLens</span>
      </Link>
    </header>
  );
}

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const { user, signOut } = useAuth();

  return (
    <>
      <div className="flex h-16 items-center justify-between px-5">
        <Link to="/dashboard" className="flex items-center gap-2.5 rounded-sm">
          <LogoMark className="h-8 w-8" />
          <span className="text-base font-semibold tracking-tight text-neutral-0">TalentLens</span>
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-neutral-400 hover:text-neutral-0"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav aria-label="Recruiter" className="flex-1 overflow-y-auto px-3 py-2">
        <p className="px-3 pb-2 pt-3 text-2xs font-semibold uppercase tracking-widest text-neutral-500">
          Workspace
        </p>
        <ul className="space-y-1">
          {RECRUITER_NAVIGATION.map((item) => (
            <li key={item.code}>
              <NavigationEntry item={item} />
            </li>
          ))}
        </ul>

        {/*
          FR8.1 — the administration section exists only for an Administrator.
          Every route behind it is `@Roles(ADMIN)` server-side; showing it to a
          Recruiter would advertise a surface their role cannot use.
        */}
        {user?.role === 'ADMIN' && (
          <>
            <p className="px-3 pb-2 pt-5 text-2xs font-semibold uppercase tracking-widest text-neutral-500">
              Administration
            </p>
            <ul className="space-y-1">
              {ADMIN_NAVIGATION.map((item) => (
                <li key={item.code}>
                  <NavigationEntry item={item} />
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      {/* Account area — §4.1's "Account → Profile / sign out". */}
      <div className="border-t border-neutral-800 p-3">
        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <span
            aria-hidden="true"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-700 text-sm font-semibold text-neutral-0"
          >
            {(user?.email?.[0] ?? '?').toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-0" title={user?.email}>
              {user?.email}
            </p>
            <p className="text-xs text-neutral-400">{formatRole(user?.role)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-1 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-neutral-800 px-4 text-sm font-semibold text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-0"
        >
          <LogoutIcon />
          Sign out
        </button>
      </div>
    </>
  );
}

function NavigationEntry({ item }: { item: NavigationItem }) {
  const { pathname } = useLocation();
  const Icon = item.icon;

  /*
   * An unbuilt destination is a disabled <span>, never a link. A link to a
   * route that does not exist would land on the catch-all redirect and look
   * like the app losing the user's click.
   */
  if (!item.to) {
    return (
      <span
        aria-disabled="true"
        className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-neutral-500"
      >
        {Icon && <Icon className="h-5 w-5 shrink-0 opacity-60" />}
        <span className="flex-1">{item.label}</span>
        <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-2xs uppercase tracking-wide">
          Later
        </span>
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
      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150 ${
        active
          ? 'bg-primary-700 font-semibold text-neutral-0'
          : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-0'
      }`}
    >
      {Icon && <Icon className="h-5 w-5 shrink-0" />}
      <span className="flex-1">{item.label}</span>
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
