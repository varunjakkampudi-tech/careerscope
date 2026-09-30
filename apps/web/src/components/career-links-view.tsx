'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { EmptyState } from './ui-states';

const careerResources = [
  { name: 'Remote OK', category: 'Job sources', url: 'https://remoteok.com/' },
  { name: 'Himalayas', category: 'Job sources', url: 'https://himalayas.app/jobs' },
  { name: 'Microsoft Careers', category: 'Company careers', url: 'https://careers.microsoft.com/' },
  {
    name: 'Google Careers',
    category: 'Company careers',
    url: 'https://www.google.com/about/careers/applications/',
  },
  { name: 'Amazon Jobs', category: 'Company careers', url: 'https://www.amazon.jobs/' },
  {
    name: 'Harvard Resume Resources',
    category: 'Preparation',
    url: 'https://careerservices.fas.harvard.edu/channels/create-a-resume-cv-or-cover-letter/',
  },
  { name: 'Microsoft Learn', category: 'Learning', url: 'https://learn.microsoft.com/training/' },
  { name: 'MDN Web Docs', category: 'Learning', url: 'https://developer.mozilla.org/' },
];

export default function CareerLinksView() {
  const [resourceFilter, setResourceFilter] = useState('');
  const filtered = careerResources.filter((resource) =>
    `${resource.name} ${resource.category}`.toLowerCase().includes(resourceFilter.toLowerCase()),
  );
  return (
    <section className="results career-overview">
      <p className="eyebrow">Resources</p>
      <h1>Career Links</h1>
      {/* CS-39 AC3 requires the "static/curated scope" be EXPLICIT. Everything
          else in that criterion was already satisfied — the list is a
          module-level constant with no fetch and no inference, and every link
          carries rel="noopener noreferrer" — but nothing on screen told the
          owner what they were looking at. A list of eight links under a heading
          reading "Resources" could reasonably be read as personalised, ranked,
          or kept current. It is none of those: it is hand-picked and fixed
          until someone edits this file. Saying so is the same honesty rule that
          makes the preparation screen report its real AI capability rather than
          a hardcoded caption. */}
      <p className="muted">
        A fixed, hand-picked list that ships with CareerScope. Not personalised, not ranked, and not
        checked for freshness — these open on the provider&apos;s own site in a new tab.
      </p>
      <label className="resource-filter">
        Find resources
        <input
          type="search"
          value={resourceFilter}
          onChange={(event) => setResourceFilter(event.target.value)}
          placeholder="Name or category"
        />
      </label>
      <ul className="resource-list">
        {filtered.map((resource) => (
          <li key={resource.url}>
            <a href={resource.url} target="_blank" rel="noopener noreferrer">
              <span>
                <strong>{resource.name}</strong>
                <small>{resource.category}</small>
              </span>
              <ExternalLink size={18} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && (
        // This list is a fixed module-level constant, so it is never empty on
        // its own: the only way to see nothing here is the search box above.
        // Saying "No resources found." left that ambiguous — the message now
        // names the filter and the way back to the full list (AC3).
        <EmptyState
          variant="inline"
          announce
          reason="filtered"
          message={`No resources match “${resourceFilter}”. Clear the search box above to see all ${careerResources.length} resources.`}
        />
      )}
    </section>
  );
}
