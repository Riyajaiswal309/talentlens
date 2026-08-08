import { jsx as _jsx } from 'react/jsx-runtime';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './index.css';
// PRD §16 — TanStack Query owns server state; Zustand (client-only UI state)
// is introduced in M2.6 when the first stateful screen exists.
const queryClient = new QueryClient();
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');
ReactDOM.createRoot(rootElement).render(
  _jsx(React.StrictMode, {
    children: _jsx(QueryClientProvider, { client: queryClient, children: _jsx(App, {}) }),
  }),
);
