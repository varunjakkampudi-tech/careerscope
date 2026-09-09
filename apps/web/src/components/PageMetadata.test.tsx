import { expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { PageMetadata } from './PageMetadata';

it.each([
  ['/leads?company=Private%20Employer', 'Job leads'],
  ['/settings', 'Settings'],
  ['/profile', 'Your profile'],
  ['/login', 'Sign in'],
  ['/missing', 'Page not found'],
])('uses a privacy-safe title for %s', (route, title) => {
  render(
    <MemoryRouter initialEntries={[route]}>
      <PageMetadata />
    </MemoryRouter>,
  );
  expect(document.title).toBe(`${title} | CareerScope`);
});
