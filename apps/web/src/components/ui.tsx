/**
 * The primitive components everything else is built from.
 *
 * Deliberately one file rather than a directory of one-component files: these
 * are small, they change together, and having them in one place is what stops a
 * second, subtly different button from being written three screens later.
 *
 * Every colour here is a semantic token from `index.css` — `bg-surface`, not
 * `bg-white`. That is the whole reason dark mode is a variable block instead of
 * a `dark:` variant on every element in the app.
 */

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useId, useState } from 'react';

/** Joins class names, dropping anything falsy. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-ink border-border-strong hover:bg-canvas',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-canvas hover:text-ink',
  danger: 'bg-transparent text-bad border-border-strong hover:bg-bad-soft',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

/**
 * The button's classes, without the button.
 *
 * Exported so a router `<Link>` can look identical to a `<Button>` without
 * either wrapping an anchor in a button (invalid HTML, and it breaks
 * middle-click) or copying the class list into a second place that will drift.
 */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cx(
    'inline-flex items-center justify-center rounded-lg border font-medium',
    'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // `loading` implies disabled, so a slow request cannot be fired twice by
      // an impatient second click.
      disabled={disabled === true || loading}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                              */
/* -------------------------------------------------------------------------- */

const CONTROL_BASE =
  'w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink ' +
  'placeholder:text-faint transition-colors ' +
  'hover:border-border-strong focus:border-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export interface FieldProps {
  label: string;
  /** Explains the field before the user gets it wrong, rather than after. */
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, error, required, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-bad">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL_BASE, 'h-10', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(CONTROL_BASE, 'py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(CONTROL_BASE, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, hint, disabled, className }: CheckboxProps) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2.5 text-sm',
        disabled === true && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-ink">{label}</span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  /** Rendered to the right of the label — usually the formatted value. */
  display?: ReactNode;
  hint?: ReactNode;
  id?: string;
  className?: string;
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  display,
  hint,
  id,
  className,
}: SliderProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const fill = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        {display ? <span className="text-sm tabular-nums text-accent">{display}</span> : null}
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        style={{
          backgroundImage: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${fill}%, var(--color-border) ${fill}%, var(--color-border) 100%)`,
        }}
        className="range-control h-10 w-full cursor-pointer appearance-none accent-accent"
      />
      {hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tag input                                                                  */
/* -------------------------------------------------------------------------- */

export interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Guards the profile schema's array caps before the server has to. */
  max?: number;
  id?: string;
}

/**
 * The control behind target titles, tech stack, locations and the exclusion
 * lists.
 *
 * Comma and Enter both commit, because a user pasting "React, Node, AWS" from
 * their own CV expects three chips and not one. Backspace on an empty input
 * removes the last chip — the standard behaviour of every tag field, and its
 * absence is immediately noticeable.
 */
export function TagInput({ value, onChange, placeholder, max = 120, id }: TagInputProps) {
  const [draft, setDraft] = useState('');

  const commit = (text: string): void => {
    const additions = text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      // Case-insensitive dedupe: "React" and "react" are the same skill, and two
      // chips that look identical are worse than one.
      .filter((part) => !value.some((existing) => existing.toLowerCase() === part.toLowerCase()));

    if (additions.length > 0) onChange([...value, ...additions].slice(0, max));
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cx(
        'flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-border',
        'bg-surface px-2 py-1.5 transition-colors focus-within:border-accent hover:border-border-strong',
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((item) => item !== tag))}
            aria-label={`Remove ${tag}`}
            className="text-accent/70 hover:text-accent"
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        // Committing on blur too, so a value typed and then clicked away from is
        // not silently discarded.
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : ''}
        className="min-w-24 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces + feedback                                                        */
/* -------------------------------------------------------------------------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('rounded-card border border-border bg-surface', className)}>{children}</div>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-canvas text-muted border-border',
  accent: 'bg-accent-soft text-accent border-transparent',
  good: 'bg-good-soft text-good border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  title,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cx('motion-safe-only animate-spin', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

type AlertTone = 'info' | 'warn' | 'bad' | 'good';

const ALERT_TONES: Record<AlertTone, string> = {
  info: 'border-border bg-canvas text-ink',
  warn: 'border-warn/30 bg-warn-soft text-ink',
  bad: 'border-bad/30 bg-bad-soft text-ink',
  good: 'border-good/30 bg-good-soft text-ink',
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      // `alert` only for the tones that actually demand attention — announcing
      // every informational strip interrupts a screen reader mid-sentence.
      role={tone === 'bad' || tone === 'warn' ? 'alert' : undefined}
      className={cx(
        'flex flex-wrap items-start justify-between gap-3 rounded-lg border px-3.5 py-3 text-sm',
        ALERT_TONES[tone],
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center gap-3 px-6 py-16 text-center',
        className,
      )}
    >
      <p className="text-base font-medium text-ink">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx('motion-safe-only animate-pulse rounded-md bg-border', className)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Links + copy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * An outbound link.
 *
 * `noopener` is the point: without it the opened tab gets a handle on this one
 * through `window.opener` and can navigate it somewhere else. `noreferrer` keeps
 * the app's URL out of the destination's logs.
 */
export function ExternalLink({
  href,
  children,
  className,
  title,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cx('text-accent underline-offset-2 hover:underline', className)}
    >
      {children}
    </a>
  );
}

/**
 * Copies a value and says so.
 *
 * The confirmation matters more than it looks: a copy button that does nothing
 * visible is indistinguishable from a copy button that failed, and the user's
 * only recourse is to paste somewhere and check.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access is refused outside a secure context — over plain HTTP
      // on an EC2 box without TLS, for instance. Selecting the text is then the
      // fallback, so failing quietly beats an error the user cannot act on.
    }
  };

  return (
    <Button size="sm" variant="ghost" onClick={() => void copy()} className={className}>
      {copied ? 'Copied' : label}
    </Button>
  );
}
