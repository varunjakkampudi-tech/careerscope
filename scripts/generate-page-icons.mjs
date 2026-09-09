import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  List,
  Search,
  BriefcaseBusiness,
  Settings,
  UserRound,
  Globe,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';

const icons = {
  list: List,
  search: Search,
  briefcase: BriefcaseBusiness,
  settings: Settings,
  user: UserRound,
  globe: Globe,
  lock: LockKeyhole,
  refresh: RefreshCw,
};
for (const [name, icon] of Object.entries(icons)) {
  writeFileSync(
    new URL(`../mobile-site/icon-${name}.svg`, import.meta.url),
    `${renderToStaticMarkup(createElement(icon, { color: '#111725', width: 18, height: 18 }))}\n`,
  );
}
