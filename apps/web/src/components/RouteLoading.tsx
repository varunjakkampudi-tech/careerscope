import { Spinner } from './ui';

export function RouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-64 items-center justify-center gap-3 p-8 text-sm text-muted"
    >
      <Spinner size={20} />
      <span>Loading page...</span>
    </div>
  );
}
