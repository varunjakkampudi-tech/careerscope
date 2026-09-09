import { Compass } from 'lucide-react';
import { APP_NAME } from '../lib/brand';

export function Brand() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2" role="img" aria-label={APP_NAME}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#0d8377] text-white">
        <Compass size={24} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span
        className="whitespace-nowrap text-lg leading-none font-semibold tracking-normal text-ink"
        translate="no"
        aria-hidden="true"
      >
        Career<span className="font-normal text-match-fill">Scope</span>
      </span>
    </span>
  );
}