import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import { isApiError } from './lib/problem-details';
import './index.css';

// PRD §16 — TanStack Query owns server state; Zustand (client-only UI state)
// is introduced in M2.6 when the first stateful screen exists.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /*
       * NEVER RETRY WHAT WILL NOT SUCCEED. 401 is already handled one layer
       * down by silent refresh, and 403/404 are settled answers under §24.2
       * and BR-06 — repeating them only delays the error the screen should
       * show. Everything else keeps a single retry for a transient blip.
       */
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Inside the router: the guards it provides use router navigation. */}
        <AuthProvider>
          {/* Outermost of the two so a confirmation survives the navigation
              that a mutation often triggers. */}
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
