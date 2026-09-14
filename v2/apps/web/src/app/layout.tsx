import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CareerScope | Search Workspace',
  description: 'Private CareerScope search workspace',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
