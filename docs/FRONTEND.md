# Frontend

The web client is the Next.js App Router application in `apps/web`. Routes use
React Server Components by default and client components only for interaction.
TanStack Query is the server-state layer; typed API helpers preserve CSRF,
same-origin credentials, revision handling and SSE cleanup.

The single web client is responsive for desktop, tablet and mobile and uses
the existing CSS modules/tokens. Brand images served by the app live in
`apps/web/public/brand`.
