import type { NextConfig } from 'next';

// The dev server needs its hot-reload websocket; a deployed build must not
// advertise loopback websocket origins in its policy.
const connectSources =
  process.env.NODE_ENV === 'production'
    ? "'self'"
    : "'self' ws://127.0.0.1:5280 ws://localhost:5280";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:5390/api/:path*' }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cache-Control', value: 'no-store' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
              `img-src 'self' data:; connect-src ${connectSources}; font-src 'self'; object-src 'none'; ` +
              "base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
