import type { MetadataRoute } from 'next';

// The deployed workspace is private. The public marketing/jobs snapshot lives on
// a separate static host and carries its own robots policy.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: '/' }] };
}
