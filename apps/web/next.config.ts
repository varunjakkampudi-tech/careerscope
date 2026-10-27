import type { NextConfig } from 'next';
import { API_PORT } from '../../packages/shared/src/constants';

// The dev server needs its hot-reload websocket; a deployed build must not
// advertise loopback websocket origins in its policy.
const connectSources =
  process.env.NODE_ENV === 'production'
    ? "'self'"
    : "'self' ws://127.0.0.1:5280 ws://localhost:5280";

// CS-54: production uses build-time SHA-256 hashes for every inline script, so the shipped policy
// has no script `'unsafe-inline'` and static prerendering is kept. `scripts/build-with-csp.mjs` builds
// once with CSP_HASH_DISCOVERY=1 to read the hashes from the generated HTML, then rebuilds with
// CSP_SCRIPT_HASHES until the policy covers every hash. A missing hash blanks the page (React's
// hydration script does not run), and a nonce policy cannot work with static HTML; both are measured
// in docs/decisions/CSP-STRICT-SCRIPT-SRC.md. Compensating controls: HttpOnly SameSite=Strict
// cookies, the API's own `default-src 'none'`, no `dangerouslySetInnerHTML`, React escaping.
// A production build with neither variable set fails instead of shipping `'unsafe-inline'`.
const scriptSource = () => {
  if (process.env.CSP_SCRIPT_HASHES && process.env.NODE_ENV === 'production')
    return `script-src 'self' ${process.env.CSP_SCRIPT_HASHES}; `;
  if (process.env.NEXT_PHASE === 'phase-production-build' && !process.env.CSP_HASH_DISCOVERY)
    throw new Error(
      'CSP_SCRIPT_HASHES is required for a production build; build with "npm run build" (scripts/build-with-csp.mjs).',
    );
  return "script-src 'self' 'unsafe-inline'; ";
};
const nextConfig: NextConfig = {
  // Stable build IDs make the static Flight bootstrap deterministic across
  // the CSP discovery and enforcement passes. Deployments may override this
  // with the exact revision while local builds retain a safe fixed default.
  generateBuildId: async () => process.env.NEXT_BUILD_ID ?? 'careerscope-static',
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `http://127.0.0.1:${API_PORT}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; " +
              scriptSource() +
              "style-src 'self' 'unsafe-inline'; " +
              `img-src 'self' data:; connect-src ${connectSources}; font-src 'self'; object-src 'none'; ` +
              "base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
      // HTML and API responses are never cached; fingerprinted static assets keep Next's own immutable caching.
      {
        source: '/((?!_next/static|_next/image).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
