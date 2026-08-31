import type { Config } from 'tailwindcss';

/**
 * Design tokens from Phase 1 Task 8.
 *
 * Every colour pairing here was verified against WCAG 2.1 AA (PRD NFR4) in
 * Phase 1 §8.2 — the contrast ratio is recorded next to each value. THOSE
 * VALUES ARE NOT CHANGED: `neutral.500/700/900`, `primary.600/700` and the
 * status 700s carry the ratios the audit recorded, so text keeps its verified
 * contrast. The additions below are surface and border shades used for depth,
 * never for text on white.
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
          50: '#FAFAFB', // page ground — surface only
          100: '#F3F4F6',
          200: '#E5E7EB', // hairline borders — surface only
          300: '#D1D5DB',
          400: '#9CA3AF', // muted icons — never body text
          500: '#6B7280', // 4.8:1 on white
          700: '#374151', // 10.3:1
          800: '#1F2937', // sidebar ground — surface only
          900: '#111827', // 16.1:1
          950: '#0B1220', // deepest sidebar ground — surface only
        },
        primary: {
          50: '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          500: '#3B82F6', // decorative only (bars, gradients)
          600: '#2563EB', // 5.2:1
          700: '#1D4ED8', // 6.3:1
          800: '#1E40AF',
        },
        success: { 50: '#F0FDF4', 200: '#BBF7D0', 700: '#15803D' }, // 5.1:1
        warning: { 50: '#FFFBEB', 200: '#FDE68A', 700: '#B45309' }, // 4.9:1
        danger: { 50: '#FEF2F2', 200: '#FECACA', 700: '#B91C1C' }, // 6.4:1
        info: { 50: '#F0F9FF', 200: '#BAE6FD', 700: '#0369A1' }, // 5.6:1
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(17,24,39,.06)',
        md: '0 4px 12px rgba(17,24,39,.08)',
        lg: '0 16px 40px rgba(17,24,39,.16)',
        card: '0 1px 2px rgba(17,24,39,.04), 0 1px 3px rgba(17,24,39,.06)',
        'card-hover': '0 4px 16px rgba(17,24,39,.10)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up .4s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
