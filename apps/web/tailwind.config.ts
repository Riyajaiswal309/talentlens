import type { Config } from 'tailwindcss';

/**
 * Design tokens from Phase 1 Task 8.
 *
 * Every colour pairing here was verified against WCAG 2.1 AA (PRD NFR4) in
 * Phase 1 §8.2 — the contrast ratio is recorded next to each value.
 *
 * Branding is NOT SPECIFIED IN PRD (Phase 1 NS-02). This palette is derived
 * from the accessibility constraint rather than chosen decoratively, and is
 * intended to be swapped wholesale for institutional branding by editing only
 * this file (Phase 1 decision D11).
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        neutral: {
          0: '#FFFFFF',
          100: '#F3F4F6',
          300: '#D1D5DB',
          500: '#6B7280', // 4.8:1 on white
          700: '#374151', // 10.3:1
          900: '#111827', // 16.1:1
        },
        primary: {
          50: '#EFF6FF',
          600: '#2563EB', // 5.2:1
          700: '#1D4ED8', // 6.3:1
        },
        success: { 700: '#15803D' }, // 5.1:1
        warning: { 700: '#B45309' }, // 4.9:1 — low-confidence flags, Overridden badge
        danger: { 700: '#B91C1C' }, // 6.4:1
        info: { 700: '#0369A1' }, // 5.6:1 — AI-disabled notices
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(17,24,39,.06)',
        md: '0 4px 12px rgba(17,24,39,.08)',
        lg: '0 16px 40px rgba(17,24,39,.16)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
