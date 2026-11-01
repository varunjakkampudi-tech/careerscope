# Design system

The web app keeps the look approved from the owner-supplied design images: a dark sidebar, a light
topbar, stat cards and tabbed lists. This document records the tokens and shared pieces that exist
today so new screens reuse them. It does not propose a redesign.

Source files, all under `apps/web/src`:

- `app/globals.css` and `styles/reset.css` define the base tokens and page-level rules.
- `components/dashboard-shell.module.css` defines the `--dash-*` tokens and the shell layout.
- `styles/surface.module.css` is the shared panel surface.
- `components/ui-states.tsx` and `ui-states.module.css` hold the shared loading, empty and error states.

## Tokens

Tokens are CSS custom properties. Use a token instead of a literal colour or spacing value.

### Dashboard tokens (`--dash-*`)

Defined on `.shell` in `dashboard-shell.module.css`, which wraps every signed-in route. The dark
values apply under `.shell[data-theme='dark']`. These are the primary tokens for new work.

| Group           | Tokens                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Surfaces        | `--dash-canvas`, `--dash-surface`, `--dash-surface-subtle`                                                                 |
| Text            | `--dash-ink`, `--dash-muted`, `--dash-link`, `--dash-on-accent`                                                            |
| Lines and focus | `--dash-border`, `--dash-control-border`, `--dash-focus`                                                                   |
| Accent          | `--dash-accent`, `--dash-accent-hover`                                                                                     |
| Sidebar         | `--dash-sidebar`, `--dash-sidebar-ink`, `--dash-sidebar-muted`, `--dash-sidebar-active`                                    |
| Shape           | `--dash-card-radius` (14px)                                                                                                |
| Spacing         | `--dash-space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 20px, `-6` 24px, `-8` 32px, `-10` 40px, `-12` 48px              |
| Lead status     | `--dash-status-<status>-bg` and `-fg` for `saved`, `applied`, `interviewing`, `offer`, `rejected`, `archived`, `withdrawn` |

### Base and semantic tokens (`:root` in `globals.css`)

| Token              | Light value                       | Dark value                                 | Use                                                                |
| ------------------ | --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `--canvas`         | `#f6f7f9`                         | follows `--dash-canvas` in the dark shell  | Page background (older screens)                                    |
| `--surface`        | `#fff`                            | follows `--dash-surface` in the dark shell | Card background (older screens)                                    |
| `--ink`            | `#111725`                         | follows `--dash-ink` in the dark shell     | Body text (older screens)                                          |
| `--muted`          | `#4a5364`                         | follows `--dash-muted` in the dark shell   | Secondary text (older screens)                                     |
| `--border`         | `#e2e5ec`                         | follows `--dash-border` in the dark shell  | Hairlines (older screens)                                          |
| `--accent`         | `#4055d6`                         | same                                       | Accent (older screens)                                             |
| `--good`           | `#157539`                         | same                                       | Success text and borders                                           |
| `--danger-text`    | `#b3261e`                         | `#f6b3bf`                                  | Error text and icons                                               |
| `--danger-solid`   | `#b42318`                         | same                                       | Solid destructive fills such as the unread badge                   |
| `--on-solid`       | `#fff`                            | same                                       | Text on a solid accent, danger or dark fill                        |
| `--shadow-card`    | `0 2px 8px rgba(13, 18, 36, .04)` | `none`                                     | Resting card elevation                                             |
| `--shadow-popover` | `0 12px 32px rgb(16 19 35 / 18%)` | same                                       | Floating panels                                                    |
| `--font-sans`      | Inter, set by `next/font`         | same                                       | Body font; defined by `app/layout.tsx`, read in `styles/reset.css` |

The older screens (`globals.css`) use `--canvas`, `--surface`, `--ink`, `--muted` and `--border`.
Inside the dark shell these are mapped to the `--dash-*` values, because they have no dark values of
their own. Prefer the `--dash-*` tokens in new CSS modules.

## Shared components

| Component             | File                             | Purpose                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoadingState`        | `components/ui-states.tsx`       | Block or inline loading text with `role="status"`.                                                                                                                                                                                                      |
| `ErrorState`          | `components/ui-states.tsx`       | Block or inline error with `role="alert"`. `title` (block) or `what` (inline) is required, so an error always names what failed. `onRetry` or `action` offers the next step.                                                                            |
| `EmptyState`          | `components/ui-states.tsx`       | Block or inline empty state. `reason` (`nothing-yet`, `filtered`, `awaiting-input`) is required and rendered as `data-empty-reason`.                                                                                                                    |
| `.panel` surface      | `styles/surface.module.css`      | Background, border, radius and text colour for a card. Modules add layout with `composes: panel from '../styles/surface.module.css'`. Used by account security, language preference, notification preferences, matching and interview organizer panels. |
| `BrandLogo`           | `components/brand-logo.tsx`      | Logo and wordmark (default export).                                                                                                                                                                                                                     |
| `MatchEvidence`       | `components/match-evidence.tsx`  | Match score explanation shared by search results and saved leads.                                                                                                                                                                                       |
| Dashboard shell parts | `components/dashboard-shell.tsx` | `DashboardSidebar`, `DashboardMobileNav`, `DashboardTopbar` and the `navKeyForPath` helper.                                                                                                                                                             |

`AuthenticatedShell` (`components/authenticated-shell.tsx`, default export) wraps every signed-in route from
`app/(app)/layout.tsx`. `HeroIllustration` (`components/hero-illustration.tsx`, default export) is the dashboard
and search hero artwork. Every other file in `components/` is a screen-specific view, not a shared component.

A guard, `scripts/tests/design-system-doc.test.ts`, fails when a token or component named in this document no
longer exists, when CSS reads a token that nothing defines (apart from the exceptions listed under
"Found and left as is"), or when a shared component file is missing from the table.

Rules for new screens:

1. Loading, empty and error conditions use `LoadingState`, `EmptyState` and `ErrorState`. Do not
   write a new one-off block.
2. A card or panel composes `.panel` from `surface.module.css` instead of repeating its four
   declarations.
3. Colours come from tokens. A new colour that is used twice becomes a token here first.
4. Status colours for leads come from `--dash-status-*`; render them through `data-status`.
5. Primary buttons use `--dash-accent` with `--on-solid` text. Never reference a token that is not
   defined above: an undefined `var()` without a fallback silently resolves to nothing.

## Audit result

What the audit of `apps/web/src` found and what was changed in this pass.

Changed, behaviour preserving unless noted:

- Added the semantic tokens above and replaced their repeated literals: the error colour with its
  dark override (3 places, the dark rule pairs removed), the destructive badge fill, the success green
  (4 places), white text on solid fills (6 places), the card shadow (3 places) and the popover shadow.
- Replaced five copies of the panel surface with the shared `.panel` composition. Two of them used the
  older base tokens, so their border and text colours move by one unit of one channel in light theme
  (for example border `#e2e5ec` to `#e1e5ee`).
- Mapped the older base tokens to the `--dash-*` values inside the dark shell. Before, the settings
  panels used `--surface` and `--border`, which have no dark value, so they stayed light inside the
  dark shell. This is a dark-theme fix; light theme is unchanged.
- Replaced two references to `--dash-primary`, a token that is defined nowhere. In
  `interview-organizer.module.css` the primary button had no background at all (white text on a
  transparent button), which is a defect fixed by using `--dash-accent`. In `ui-states.module.css`
  the fallback `#2563eb` always applied, a blue that is not the brand accent; it now uses
  `--dash-accent`, so the spinner and the empty-state action link change from `#2563eb` to the brand
  accent. These are the only intentional visible changes.
- Replaced `color: var(--text)` on `.discovery-mode select` in `globals.css`. `--text` is defined nowhere, so
  the declaration was invalid at computed-value time and already resolved to `unset`, which for `color`
  means `inherit`. `color: inherit` states that outcome directly; the rendered colour is unchanged.

Found and left as is, with the reason:

- Bare `<p role="alert">` and `<p role="status">` messages (about 43 sites). Moving them to
  `ErrorState` would require a "what failed" prefix, which changes copy. They remain a candidate for a
  copy-reviewed pass.
- Two button systems (`.btn` in `saved-leads.module.css`, `.primaryButton` in
  `interview-organizer.module.css`) and two retry button styles. Their sizes, radii and focus rules
  differ, so merging them is a visible change.
- Status pills: `.statusBadge` (lead status, tokenised), `.status` in the interview organizer and the
  `.status`, `.count` and chip rules in `globals.css`. They look different by design today.
- Literal colours in `globals.css` for the match and run status text (`#a62424`, `#8a4b00`, `#9c2b22`,
  `#914309`), the stat icon tones and the hero gradient in `dashboard-shell.module.css`, and the SVG
  colours in `hero-illustration.tsx`. Each is used once and has no dark counterpart yet; they become
  tokens when a second use or a dark value appears.
- `var(--surface-subtle, rgba(...))` in `globals.css` references a token that is not defined, so the
  fallback always applies. Left because changing it changes the AI note background.
- A `color="#157539"` prop on a Lucide icon in the dashboard page. It is an SVG presentation
  attribute; replacing it with a token needs a class and was left.
- `--dash-space-8`, `-10` and `-12` are defined but no CSS reads them yet. They stay as the top of the
  documented scale.
- Spacing is mostly literal pixels (about 900 occurrences) alongside `--dash-space-*`. Converting them
  is a large diff with no visible effect and was not attempted.
