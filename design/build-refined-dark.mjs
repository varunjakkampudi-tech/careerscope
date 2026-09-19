// Builds the Refined Dark public jobs page.
//
// The spec requires the first page of real jobs to be present in the HTML and
// usable before JavaScript runs, so this emits the markup with rows already in
// it rather than shipping a blank shell that fetches on load.

import { readFileSync, writeFileSync } from 'node:fs';

const FIRST_PAGE = 20;

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const raw = JSON.parse(readFileSync('mobile-site/jobs.json', 'utf8'));
const jobs = (Array.isArray(raw) ? raw : (raw.jobs ?? raw.items ?? []))
  .slice()
  .sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const row = (j) => `        <li class="row">
          <span class="cell title"><a class="job" href="${esc(j.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(j.title)}<span class="vh"> — opens in a new tab</span></a></span>
          <span class="cell company"><span class="vh">Company: </span>${esc(j.company)}</span>
          <span class="cell location"><span class="vh">Location: </span>${esc(j.location)}</span>
          <span class="cell source"><span class="vh">Source: </span>${esc(j.source)}</span>
          <time class="cell posted" datetime="${esc(new Date(j.postedAt).toISOString())}">${esc(ago(j.postedAt))}</time>
          <span class="cell act"><button class="save" type="button" aria-pressed="false" data-url="${esc(j.url)}"><span class="vh">Save ${esc(j.title)}</span><svg class="i" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#icon-save-outline"></use></svg></button></span>
        </li>`;

const html = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Latest jobs — ${jobs.length.toLocaleString('en-US')} open roles | CareerScope</title>
    <meta
      name="description"
      content="A continuously updated list of ${jobs.length.toLocaleString('en-US')} open engineering and product roles, gathered from public job sources. Search, filter and save the ones worth reading."
    />
    <link rel="canonical" href="https://careerscope.tech/" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Latest jobs | CareerScope" />
    <meta
      property="og:description"
      content="${jobs.length.toLocaleString('en-US')} open roles, updated daily. Nothing here is an application."
    />
    <meta property="og:url" content="https://careerscope.tech/" />
    <style>
      /* Refined Dark — tokens taken from the approved design spec. */
      :root {
        --bg: #080b10;
        --surface: #0f141a;
        --elevated: #141b22;
        --text: #f4f7fa;
        --text-2: #aeb8c4;
        --accent: #2dd4a5;
        --focus: #7de7cf;
        --border: #586572;
        --hover: #151e26;
        --skeleton-base: #141b22;
        --skeleton-highlight: #1d2730;
        --shadow: 0 1px 0 rgba(255, 255, 255, 0.04), 0 10px 28px rgba(0, 0, 0, 0.18);
        --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
        --r: 4px;
        color-scheme: dark;
      }
      html[data-theme='light'] {
        --bg: #f5f7fa;
        --surface: #ffffff;
        --elevated: #eef2f5;
        --text: #10151b;
        --text-2: #52606d;
        --accent: #0b7f68;
        --focus: #0b7f68;
        --border: #788591;
        --hover: #e9eef2;
        --skeleton-base: #e9eef2;
        --skeleton-highlight: #dde4ea;
        --shadow: 0 1px 0 rgba(16, 21, 27, 0.04), 0 10px 24px rgba(16, 21, 27, 0.06);
        color-scheme: light;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--sans);
        font-size: 16px;
        line-height: 24px;
      }
      .vh {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      .skip {
        position: absolute;
        left: -9999px;
      }
      .skip:focus {
        left: 32px;
        top: 12px;
        z-index: 20;
        background: var(--accent);
        color: var(--bg);
        padding: 8px 12px;
        border-radius: var(--r);
      }
      :focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }
      .shell {
        max-width: 1360px;
        margin: 0 auto;
        padding: 32px;
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--r);
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .topbar {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 12px 20px;
        border-bottom: 1px solid var(--border);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--text);
        text-decoration: none;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .grow {
        flex: 1;
      }

      .head {
        padding: 24px 20px 20px;
      }
      h1 {
        font-size: 32px;
        line-height: 40px;
        font-weight: 700;
        letter-spacing: -0.02em;
        margin: 0;
      }
      .sub {
        color: var(--text-2);
        font-size: 13px;
        line-height: 18px;
        letter-spacing: 0.01em;
        margin: 4px 0 0;
      }
      .sub b {
        color: var(--text);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }

      .bar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
        padding: 0 20px 16px;
      }
      .control {
        min-height: 40px;
        padding: 0 12px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        border-radius: var(--r);
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 14px;
        line-height: 20px;
        font-weight: 500;
        cursor: pointer;
        text-decoration: none;
        transition: background 120ms ease-out;
      }
      .control:hover {
        background: var(--hover);
      }
      .control[aria-pressed='true'] {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--bg);
      }
      .control--quiet {
        border-color: transparent;
        background: transparent;
      }
      .control--quiet:hover {
        background: var(--hover);
      }
      .search {
        position: relative;
        flex: 1 1 280px;
        min-width: 200px;
      }
      .search .i {
        position: absolute;
        left: 10px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-2);
        pointer-events: none;
      }
      .search input {
        width: 100%;
        min-height: 40px;
        padding: 0 12px 0 36px;
        border: 1px solid var(--border);
        border-radius: var(--r);
        background: var(--bg);
        color: var(--text);
        font: inherit;
        font-size: 14px;
      }
      select.control {
        appearance: none;
        padding-right: 28px;
        background-image: none;
      }

      .thead,
      .row {
        display: grid;
        grid-template-columns:
          minmax(260px, 2.9fr) minmax(120px, 1.35fr) minmax(150px, 1.7fr)
          minmax(110px, 1.1fr) 92px 44px;
        align-items: center;
        gap: 12px;
        padding: 0 20px;
      }
      .thead {
        height: 36px;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        color: var(--text-2);
        font-size: 12px;
        line-height: 16px;
        font-weight: 500;
        letter-spacing: 0.02em;
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .row {
        min-height: 52px;
        border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
        transition: background 120ms ease-out;
      }
      .row:hover {
        background: var(--hover);
      }
      .cell {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0;
      }
      .job {
        color: var(--text);
        text-decoration: none;
      }
      .row:hover .job {
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .company,
      .location,
      .source {
        color: var(--text-2);
        font-size: 13px;
        line-height: 18px;
      }
      .posted {
        color: var(--text-2);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .act {
        display: flex;
        justify-content: flex-end;
      }
      .save {
        width: 44px;
        height: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid transparent;
        border-radius: var(--r);
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
      }
      .save:hover {
        background: var(--elevated);
        color: var(--text);
      }
      .save[aria-pressed='true'] {
        color: var(--accent);
      }

      .foot {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px 20px;
      }
      .count {
        color: var(--text-2);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }

      .state {
        padding: 48px 20px;
        text-align: center;
        color: var(--text-2);
      }
      .state svg {
        color: var(--text-2);
      }
      .state h2 {
        font-size: 24px;
        line-height: 32px;
        letter-spacing: -0.01em;
        color: var(--text);
        margin: 16px 0 4px;
      }
      .state p {
        margin: 0 0 16px;
      }
      .state--error {
        border: 1px solid var(--border);
        border-radius: var(--r);
        margin: 20px;
      }

      @keyframes careerscope-skeleton-shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }
      .sk-line {
        height: 12px;
        border-radius: 3px;
        background: linear-gradient(
          90deg,
          var(--skeleton-base) 0%,
          var(--skeleton-highlight) 45%,
          var(--skeleton-base) 100%
        );
        background-size: 200% 100%;
        animation: careerscope-skeleton-shimmer 1200ms ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .sk-line {
          animation: none;
          background: var(--skeleton-highlight);
        }
        .control,
        .row {
          transition: none;
        }
      }

      @media (max-width: 767px) {
        .shell {
          padding: 16px;
        }
        .thead {
          display: none;
        }
        .row {
          grid-template-columns: minmax(0, 1fr) 44px;
          grid-template-rows: auto auto;
          row-gap: 4px;
          min-height: 64px;
          padding: 12px 16px;
          align-items: start;
        }
        .title {
          grid-column: 1;
          grid-row: 1;
          white-space: normal;
        }
        .act {
          grid-column: 2;
          grid-row: 1 / span 2;
          align-items: flex-start;
        }
        .company,
        .location,
        .source,
        .posted {
          display: none;
        }
        .meta {
          grid-column: 1;
          grid-row: 2;
          color: var(--text-2);
          font-size: 13px;
          line-height: 18px;
          white-space: normal;
        }
        .head,
        .bar,
        .foot {
          padding-left: 16px;
          padding-right: 16px;
        }
      }
      @media (min-width: 768px) {
        .meta {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="0"
      height="0"
      style="position: absolute; overflow: hidden"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <symbol id="icon-save-outline" viewBox="0 0 24 24">
          <path
            d="M6.5 4.5A2.5 2.5 0 0 1 9 2h6a2.5 2.5 0 0 1 2.5 2.5V21l-5.5-3.5L6.5 21V4.5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </symbol>
        <symbol id="icon-save-filled" viewBox="0 0 24 24">
          <path
            d="M6.5 4.5A2.5 2.5 0 0 1 9 2h6a2.5 2.5 0 0 1 2.5 2.5V21l-5.5-3.5L6.5 21V4.5Z"
            fill="currentColor"
          />
        </symbol>
        <symbol id="icon-search" viewBox="0 0 24 24">
          <circle
            cx="10.75"
            cy="10.75"
            r="6.75"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            vector-effect="non-scaling-stroke"
          />
          <path
            d="m16 16 4.25 4.25"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </symbol>
        <symbol id="icon-download" viewBox="0 0 24 24">
          <path
            d="M12 3.5v11"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
          <path
            d="m7.75 10.75 4.25 4.25 4.25-4.25"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <path
            d="M4 19.5h16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </symbol>
        <symbol id="icon-sun" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            r="4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            vector-effect="non-scaling-stroke"
          />
          <path
            d="M12 2.5v2M12 19.5v2M4.58 4.58 6 6M18 18l1.42 1.42M2.5 12h2M19.5 12h2M4.58 19.42 6 18M18 6l1.42-1.42"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </symbol>
        <symbol id="icon-moon" viewBox="0 0 24 24">
          <path
            d="M19.25 14.5A7.75 7.75 0 0 1 9.5 4.75a7.25 7.25 0 1 0 9.75 9.75Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </symbol>
      </defs>
    </svg>

    <a class="skip" href="#content">Skip to content</a>
    <div class="shell">
      <div class="panel">
        <header class="topbar">
          <a class="brand" href="/">
            <svg width="20" height="20" viewBox="0 0 56 56" aria-hidden="true" fill="none">
              <path
                fill="currentColor"
                fill-rule="evenodd"
                d="M52 26C52 39.255 41.255 50 28 50C14.745 50 4 39.255 4 26C4 12.745 14.745 2 28 2C38.1 2 46.9 8.15 50.25 17H40.2C37.8 13.75 33.35 11 28 11C19.715 11 13 17.715 13 26C13 34.285 19.715 41 28 41C33.35 41 37.8 38.25 40.2 35H50.25C46.9 43.85 38.1 50 28 50Z"
              />
              <circle cx="39" cy="26" r="4.25" fill="currentColor" />
            </svg>
            CareerScope
          </a>
          <span class="grow"></span>
          <button id="theme" class="control control--quiet" type="button" aria-label="Theme: dark">
            <svg class="i" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <use id="theme-icon" href="#icon-moon"></use>
            </svg>
          </button>
          <a class="control control--quiet" href="./admin.html">Admin login</a>
        </header>

        <main id="content">
          <div class="head">
            <h1>Latest jobs</h1>
            <p class="sub"><b id="total">${jobs.length.toLocaleString('en-US')}</b> roles · newest first · nothing here is an application</p>
          </div>

          <div class="bar">
            <button id="all" class="control" type="button" aria-pressed="true">All jobs</button>
            <button id="saved" class="control" type="button" aria-pressed="false">Saved</button>
            <label class="search">
              <span class="vh">Search jobs, companies or locations</span>
              <svg class="i" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <use href="#icon-search"></use>
              </svg>
              <input id="q" type="search" placeholder="Search jobs, companies or locations" />
            </label>
            <select id="source" class="control" aria-label="Filter by source">
              <option value="">All sources</option>
            </select>
            <button id="clearf" class="control control--quiet" type="button">Clear filters</button>
            <a class="control control--quiet" href="./jobs.json" download>
              <svg class="i" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <use href="#icon-download"></use>
              </svg>
              Download
            </a>
          </div>

          <div class="thead" aria-hidden="true">
            <span>Title</span><span>Company</span><span>Location</span><span>Source</span>
            <span style="text-align: right">Posted</span><span></span>
          </div>

          <div id="list">
            <ul class="rows">
${jobs.slice(0, FIRST_PAGE).map(row).join('\n')}
            </ul>
          </div>

          <div class="foot">
            <button id="more" class="control" type="button">Load more</button>
            <span class="count" id="shown">Showing 1–${FIRST_PAGE} of ${jobs.length.toLocaleString('en-US')}</span>
          </div>
        </main>
      </div>
    </div>
    <p id="live" class="vh" role="status" aria-live="polite"></p>
    <script type="module" src="./refined-dark.js"></script>
  </body>
</html>
`;

writeFileSync('design/home-variants/refined-dark.html', html);
console.log(`wrote refined-dark.html with ${FIRST_PAGE} of ${jobs.length} rows inlined`);
