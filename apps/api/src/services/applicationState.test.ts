import { describe, expect, it } from 'vitest';
import { applicationRunSchema, canTransitionApplication } from './applicationState.js';

describe('application state transitions', () => {
  it('requires a portal check for legacy failed records without outcome metadata', () => {
    const legacy = {
      id: 'old-run',
      leadId: 'lead',
      status: 'failed',
      createdAt: '2026-09-09',
      updatedAt: '2026-09-09',
      events: [],
      currentUrl: null,
      question: null,
      confirmation: null,
    };
    expect(applicationRunSchema.parse(legacy)).toMatchObject({
      outcomeUnknown: true,
      retryOf: null,
    });
    expect(applicationRunSchema.parse({ ...legacy, outcomeUnknown: false }).outcomeUnknown).toBe(
      false,
    );
  });
  it('requires a review state before submission', () => {
    expect(canTransitionApplication('running', 'submitted')).toBe(false);
    expect(canTransitionApplication('running', 'submitting')).toBe(false);
    expect(canTransitionApplication('running', 'ready')).toBe(true);
    expect(canTransitionApplication('ready', 'submitting')).toBe(true);
    expect(canTransitionApplication('submitting', 'submitted')).toBe(true);
  });

  it('supports a user-input pause without permitting submission', () => {
    expect(canTransitionApplication('running', 'needs_input')).toBe(true);
    expect(canTransitionApplication('needs_input', 'running')).toBe(true);
    expect(canTransitionApplication('needs_input', 'submitting')).toBe(false);
  });

  it('does not silently retry terminal or uncertain submission states', () => {
    expect(canTransitionApplication('submitted', 'running')).toBe(false);
    expect(canTransitionApplication('failed', 'running')).toBe(false);
    expect(canTransitionApplication('submitting', 'running')).toBe(false);
    expect(canTransitionApplication('cancelled', 'submitted')).toBe(false);
  });
});
