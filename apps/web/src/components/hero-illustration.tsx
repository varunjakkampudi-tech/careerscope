// Hand-built inline illustration matching the owner-supplied Dashboard
// design's "brighter future" hero motif (mountain silhouette + a person
// with a backpack, cursive-style accent line) — an SVG rather than a raster
// image so there is no missing/broken asset dependency and no fabricated
// photo of anyone. Purely decorative (aria-hidden).
export default function HeroIllustration() {
  return (
    <svg
      viewBox="0 0 360 160"
      preserveAspectRatio="xMaxYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="hero-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="360" height="160" fill="url(#hero-sky)" />
      <circle cx="300" cy="34" r="16" fill="#ffffff" opacity="0.22" />
      <path
        d="M0 150 L60 70 L100 105 L150 45 L210 120 L250 80 L300 150 Z"
        fill="#ffffff"
        opacity="0.14"
      />
      <path d="M40 150 L110 55 L160 100 L205 60 L270 150 Z" fill="#ffffff" opacity="0.22" />
      {/* Small figure with a backpack, facing the mountains */}
      <g transform="translate(150 96)" opacity="0.9">
        <circle cx="0" cy="0" r="7" fill="#ffffff" />
        <rect x="-6" y="8" width="12" height="22" rx="4" fill="#ffffff" />
        <rect x="-9" y="10" width="6" height="14" rx="3" fill="#ffffff" opacity="0.85" />
        <line
          x1="-6"
          y1="30"
          x2="-11"
          y2="46"
          stroke="#ffffff"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <line
          x1="6"
          y1="30"
          x2="11"
          y2="46"
          stroke="#ffffff"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
