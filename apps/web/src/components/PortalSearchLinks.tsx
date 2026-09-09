import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useProfile } from '../lib/queries';
import { Field, Select, buttonClass } from './ui';

export function PortalSearchLinks() {
  const profile = useProfile();
  const [selectedTitle, setSelectedTitle] = useState('');
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);
  if (!profile.data) return null;

  const { titles, locations, remoteOnly } = profile.data.preferences;
  const title = titles.includes(selectedTitle) ? selectedTitle : (titles[0] ?? 'Software Engineer');
  const location =
    selectedLocation === ''
      ? ''
      : selectedLocation && locations.includes(selectedLocation)
        ? selectedLocation
        : (locations[0] ?? '');
  const linkedin = new URL('https://www.linkedin.com/jobs/search/');
  linkedin.searchParams.set('keywords', title);
  if (location) linkedin.searchParams.set('location', location);
  if (remoteOnly) linkedin.searchParams.set('f_WT', '2');
  const indeed = new URL('https://in.indeed.com/jobs');
  indeed.searchParams.set('q', remoteOnly ? `${title} remote` : title);
  if (location) indeed.searchParams.set('l', location);
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const roleSlug = slug(remoteOnly ? `${title} remote` : title) || 'software-developer';
  const locationSlug = slug(location);
  const naukri = new URL(
    `https://www.naukri.com/${roleSlug}-jobs${locationSlug ? `-in-${locationSlug}` : ''}`,
  );
  const portals = [
    { name: 'Naukri', url: naukri },
    { name: 'LinkedIn', url: linkedin },
    { name: 'Indeed', url: indeed },
  ];

  return (
    <section className="border-y border-border py-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Search on job portals</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Target role" htmlFor="portal-role">
          <Select
            id="portal-role"
            value={title}
            onChange={(event) => setSelectedTitle(event.target.value)}
          >
            {titles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Portal location" htmlFor="portal-location">
          <Select
            id="portal-location"
            value={location}
            onChange={(event) => setSelectedLocation(event.target.value)}
          >
            <option value="">Anywhere</option>
            {locations.map((place) => (
              <option key={place} value={place}>
                {place}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {portals.map((portal) => (
          <a
            key={portal.name}
            href={portal.url.href}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('secondary', 'sm')}
            title={`Open ${portal.name} search in a new tab`}
          >
            <ExternalLink size={14} aria-hidden="true" />
            {portal.name}
          </a>
        ))}
      </div>
    </section>
  );
}
