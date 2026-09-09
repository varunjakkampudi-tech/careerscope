/**
 * The last line of defence.
 *
 * React unmounts the entire tree when a render throws, so without this a single
 * bad field in one lead blanks the whole page with no indication of why. This
 * catches it, shows what happened, and offers the two things that actually help:
 * go back to a working screen, or reload.
 *
 * A class component because `componentDidCatch` has no hook equivalent — this is
 * the one place React still requires one.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Card } from './ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the useful half — it names the component that threw,
    // which the error's own stack usually does not.
    console.error('Render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-20">
        <Card className="flex flex-col gap-3 p-6">
          <h1 className="text-lg font-semibold text-ink">Something broke while rendering</h1>
          <p className="text-sm text-muted">
            This is a bug in the app rather than a problem with your data — nothing has been lost.
          </p>
          <pre className="text-wrap-anywhere max-h-40 overflow-auto rounded-lg bg-canvas p-3 font-mono text-xs text-muted">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          </div>
        </Card>
      </div>
    );
  }
}
