import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { APP_NAME } from '../lib/brand';

const PAGE_NAMES: Record<string, string> = {
  '/': 'Job discovery',
  '/login': 'Sign in',
  '/leads': 'Job leads',
  '/search': 'Search jobs',
  '/applications': 'Applications',
  '/profile': 'Your profile',
  '/onboarding': 'Your profile',
  '/settings': 'Settings',
};

export function PageMetadata() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `${PAGE_NAMES[pathname] ?? 'Page not found'} | ${APP_NAME}`;
  }, [pathname]);
  return null;
}
