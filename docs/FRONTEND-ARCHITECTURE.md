# Frontend Architecture

Two frontends exist. Know which one you are in.

|           | V1                                     | V2 (deployed)                   |
| --------- | -------------------------------------- | ------------------------------- |
| Location  | `apps/web`                             | `v2/apps/web`                   |
| Framework | React 18 + Vite, React Router          | Next.js 16 App Router, React 19 |
| Routes    | 10                                     | **1**                           |
| Serves    | GitHub Pages artifact, local workspace | `https://careerscope.tech`      |

---

## V2 — what is actually there

```
v2/apps/web/src/
├── app/
│   ├── layout.tsx        root layout
│   ├── page.tsx          the entire application
│   ├── globals.css
│   └── robots.ts         generated robots.txt
├── components/
│   ├── account-form.tsx
│   ├── account-security.tsx
│   ├── profile-editor.tsx
│   ├── resume-panel.tsx
│   ├── match-evidence.tsx
│   ├── saved-leads.tsx
│   └── preparation-panel.tsx
└── lib/
    └── api.ts            every API call goes through here
```

That is the whole frontend. One route, seven components, one API client.

State is local to components and lifted into `page.tsx` where it is shared.
There is no Redux, no Zustand, no React Query, and no global store. For a
single-page, single-owner workspace this is proportionate; it stops being
proportionate the moment real routing is introduced.

## The API client

`lib/api.ts` is the only place that talks to the API. Anything it must get right:

- **CSRF.** Every mutating request carries `x-csrf-token` from the session.
  A request without it is a 403 — the server does not make exceptions.
- **Origin.** The browser sends it; the server requires it to match exactly.
- **Credentials.** The session cookie is `Path=/api`, `HttpOnly`,
  `Secure`, `SameSite=Strict`. JavaScript cannot read it and must not try.
- **Revisions.** Profile and lead writes carry a revision. A 409 means
  "reload before saving", not "retry".
- **507** means resume storage is full — a real, expected state with a real
  message, not a generic failure.

## Server-sent events

Search progress uses `EventSource` against `/api/searches/:id/events`.

The contract the client must honour:

- Track the last received `sequence` and send it as `Last-Event-ID` on
  reconnect, so the server can resume rather than replay from zero.
- Close the stream on unmount. The server aborts open streams on `preClose`,
  but a leaked client-side `EventSource` will keep reconnecting.
- Treat a reconnect gap as "resync", not "lost".

## Rendering

Next.js App Router with a server-rendered root layout. There is no static
generation of authenticated content and there must not be: every response
carries `Cache-Control: no-store`, and the workspace is private.

`robots.ts` generates `robots.txt`. The authenticated workspace is not for
indexing.

## Accessibility

Current automated state: axe clean for WCAG 2.0/2.1 A and AA, accessibility-tree
assertions passing, keyboard-only traversal working, and correct reflow at 320,
390 and 1440 px across Chromium, Firefox and WebKit.

Rules for new UI:

- Every control has an accessible name. Icon-only buttons need a label.
- Errors are associated with their field and announced.
- Async regions announce via a live region — a spinner alone tells a screen
  reader nothing.
- Dialogs trap focus, restore it on close, and close on Escape.
- Focus indicators are never removed.
- No information carried by colour alone.
- Reflow at 320 px without horizontal scrolling.

None of this substitutes for a screen-reader test. See
[KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).

## The CSP constraint

The deployed CSP allows `'unsafe-inline'` for scripts and styles, and nothing
else off-origin: no `unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`,
`connect-src 'self'`.

Practically: no CDN fonts, no third-party analytics, no external images, no
remote script tags. A dependency that injects one will be blocked in production
and will usually work fine in development — check before adopting it.

## Before adding a page

The single-route structure is the next phase's main work. Two things to settle
first, because getting them wrong is expensive:

1. **The API may not support it.** There are no company, market, skills, alert
   or admin endpoints, and `CollectedJob` has no salary, tech stack, employment
   type or remote flag. Building a page for data that does not exist means
   inventing it. Do not.
2. **Auth is a session cookie scoped to `/api`.** Route protection is a client
   concern against `GET /api/session`; there is no middleware-level gate today.

See [FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md).

---

## V1 frontend

React Router SPA under `apps/web`, with routes for `/jobs`, `/login`,
`/workspace`, `/onboarding`, `/profile`, `/search`, `/leads`, `/settings` and
`/applications`. It backs the GitHub Pages artifact and the mobile site.

It is not deployed at `careerscope.tech` and is not the target of new product
work, but it is not dead — the Pages pipeline, the encrypted admin snapshot and
the mobile site all depend on it.
