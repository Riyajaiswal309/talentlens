import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where the NestJS API listens. Overridable for a deployment that moves it,
 * but never baked into the client bundle — see the proxy note below.
 */
const API_ORIGIN = process.env.VITE_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,

    /*
     * THE API IS PROXIED, NOT CALLED CROSS-ORIGIN. This is load-bearing, not
     * convenience.
     *
     * `apps/api/src/main.ts` never calls `app.enableCors()`, so the API sends
     * no `Access-Control-Allow-Origin` and answers a preflight `OPTIONS` with
     * 404. A browser on :5173 calling :3000 directly would be blocked on every
     * request.
     *
     * The refresh token makes it stricter still: `POST /v1/auth/login` sets it
     * as `HttpOnly; SameSite=Strict; Path=/v1/auth`, and `SameSite=Strict`
     * means the browser would never attach it to a cross-site request — so
     * `POST /v1/auth/refresh` could not work cross-origin even with CORS
     * enabled.
     *
     * Proxying makes every call same-origin from the browser's point of view,
     * which satisfies both constraints without touching the backend. The
     * client therefore uses ROOT-RELATIVE paths (`/v1/...`) and no base URL —
     * see `src/lib/api-client.ts`.
     */
    proxy: {
      '/v1': {
        target: API_ORIGIN,
        changeOrigin: false,
      },
    },
  },
});
