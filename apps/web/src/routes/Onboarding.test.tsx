import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { profileSchema } from '@job-radar/shared';
import { Onboarding } from './Onboarding';

const mocks = vi.hoisted(() => ({ save: vi.fn(), profile: {} }));

vi.mock('../lib/queries', () => ({
  useProfile: () => ({ data: mocks.profile, isLoading: false }),
  useCreateProfile: () => ({ mutate: mocks.save, isPending: false, error: null }),
  useUpdateProfile: () => ({ mutate: mocks.save, isPending: false, error: null }),
  useUploadResume: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useResumes: () => ({ data: [] }),
}));

describe('profile Current CTC editing', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.profile = profileSchema.parse({
      candidate: { fullName: 'Candidate', email: 'candidate@example.com', location: 'Hyderabad' },
      preferences: { titles: ['Engineer'], techStack: ['TypeScript'] },
      application: { currentCtc: '8.1', expectedCtc: '12 LPA' },
    });
    render(
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>,
    );
  });

  it('preserves an existing value when saving without editing it', () => {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(mocks.save.mock.calls[0]?.[0].application.currentCtc).toBe('8.1');
  });

  it('preserves the entered value on blur and repeated saves', () => {
    const input = screen.getByLabelText('Current CTC');
    fireEvent.change(input, { target: { value: '8.1 LPA' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('8.1 LPA');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(input).toHaveValue('8.1 LPA');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    for (const [profile] of mocks.save.mock.calls) {
      expect(profile.application.currentCtc).toBe('8.1 LPA');
      expect(profile.application.expectedCtc).toBe('12 LPA');
    }
  });

  it('preserves input when saving without a preceding blur', () => {
    fireEvent.change(screen.getByLabelText('Current CTC'), { target: { value: '9.1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(mocks.save).toHaveBeenCalledTimes(2);
    for (const [profile] of mocks.save.mock.calls) {
      expect(profile.application.currentCtc).toBe('9.1');
    }
  });
});
