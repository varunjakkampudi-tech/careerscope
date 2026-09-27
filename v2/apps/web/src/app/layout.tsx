import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Providers from './providers';

// One real, embedded web font for the entire app (CS-13/design-parity work,
// 2026-09-23): the previous `font-family: 'Avenir Next', 'Segoe UI', sans-serif`
// rule named a font CareerScope never actually ships, so every OS silently
// substituted a different local font (San Francisco on macOS, Segoe UI on
// Windows, Arial elsewhere) — not a single inconsistent bug, but every
// machine rendering a different typeface by design. `next/font/google` embeds
// the font file itself, so it is now pixel-identical everywhere.
const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: 'CareerScope | Search Workspace',
  description: 'Private CareerScope search workspace',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
