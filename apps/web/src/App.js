import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { USER_ROLES, DEFAULT_PIPELINE_STAGES } from '@talentlens/shared-types';
/**
 * M2.1 placeholder shell.
 *
 * This is scaffolding only — it exists to prove the toolchain (React, Vite,
 * Tailwind, TypeScript, workspace imports) is wired end to end. Real screens
 * follow the Phase 1 inventory from M2.6 onward and are NOT designed here.
 */
export function App() {
  return _jsx('main', {
    className: 'min-h-screen bg-neutral-100 p-8 font-sans text-neutral-900',
    children: _jsxs('div', {
      className:
        'mx-auto max-w-2xl rounded-md border border-neutral-300 bg-neutral-0 p-6 shadow-sm',
      children: [
        _jsx('h1', { className: 'text-2xl font-semibold', children: 'TalentLens' }),
        _jsx('p', {
          className: 'mt-1 text-sm text-neutral-700',
          children: 'AI-Powered Recruitment & Applicant Tracking System',
        }),
        _jsxs('div', {
          className: 'mt-6 rounded-sm bg-primary-50 p-4 text-sm',
          children: [
            _jsx('p', {
              className: 'font-semibold text-primary-700',
              children: 'Milestone M2.1 \u2014 workspace scaffold',
            }),
            _jsx('p', {
              className: 'mt-1 text-neutral-700',
              children: 'Toolchain verified. No business features are implemented yet.',
            }),
          ],
        }),
        _jsxs('dl', {
          className: 'mt-6 space-y-3 text-sm',
          children: [
            _jsxs('div', {
              children: [
                _jsx('dt', { className: 'font-semibold', children: 'Roles (PRD \u00A724.2)' }),
                _jsx('dd', { className: 'text-neutral-700', children: USER_ROLES.join(' · ') }),
              ],
            }),
            _jsxs('div', {
              children: [
                _jsx('dt', {
                  className: 'font-semibold',
                  children: 'Default pipeline stages (PRD \u00A714.1)',
                }),
                _jsx('dd', {
                  className: 'text-neutral-700',
                  children: DEFAULT_PIPELINE_STAGES.join(' → '),
                }),
                _jsx('dd', {
                  className: 'mt-1 text-xs text-neutral-500',
                  children: 'Defaults only \u2014 configurable per job (FR5.1, decision B2).',
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  });
}
