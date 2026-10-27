'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, X } from 'lucide-react';
import { api } from '../lib/api';
import { ownerKey, useOwner } from '../lib/session';
import { ErrorState, LoadingState } from './ui-states';
import styles from './interview-organizer.module.css';

type InterviewContact = { name: string; role: string | null; email: string | null };
type ChecklistItem = { id: string; label: string; completed: boolean };
type Round = {
  id: string;
  leadId: string;
  title: string;
  startsAt: string;
  timeZone: string;
  format: 'video' | 'phone' | 'onsite' | 'other';
  status: 'scheduled' | 'completed' | 'cancelled';
  contacts: InterviewContact[];
  checklist: ChecklistItem[];
  notes: string;
  reminderAt: string | null;
  resumeUploadIds: string[];
  revision: number;
};
type Resume = { id: string; status: string; contentType: string; createdAt: string };
type Draft = Omit<Round, 'id' | 'leadId' | 'startsAt' | 'reminderAt' | 'revision'> & {
  startsAtLocal: string;
  reminderAtLocal: string;
};
type WriteInput = Omit<Draft, 'startsAtLocal' | 'reminderAtLocal'> & {
  startsAt: string;
  reminderAt: string | null;
};

function localTimeInZone(value: string, timeZone: string): string {
  const instant = new Date(value);
  const fields = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const parts = Object.fromEntries(fields.map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function instantForTimeZone(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Enter a valid date and time.');
  const [, year, month, day, hour, minute] = match;
  const expected = [Number(year), Number(month), Number(day), Number(hour), Number(minute)];
  const target = Date.UTC(expected[0]!, expected[1]! - 1, expected[2]!, expected[3]!, expected[4]!);
  if (new Date(target).toISOString().slice(0, 16) !== value)
    throw new Error('Enter a valid calendar date and time.');

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const candidates = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = target + delta * 60 * 60 * 1000;
    const fields = Object.fromEntries(
      formatter.formatToParts(new Date(sample)).map(({ type, value: part }) => [type, part]),
    );
    const represented = Date.UTC(
      Number(fields.year),
      Number(fields.month) - 1,
      Number(fields.day),
      Number(fields.hour),
      Number(fields.minute),
      Number(fields.second),
    );
    const candidate = target - (represented - sample);
    const check = formatter.formatToParts(new Date(candidate));
    const actual = Object.fromEntries(check.map(({ type, value: part }) => [type, part]));
    if (
      Number(actual.year) === expected[0] &&
      Number(actual.month) === expected[1] &&
      Number(actual.day) === expected[2] &&
      Number(actual.hour) === expected[3] &&
      Number(actual.minute) === expected[4]
    )
      candidates.add(candidate);
  }
  if (candidates.size !== 1)
    throw new Error(
      candidates.size === 0
        ? 'That local time does not exist in the selected time zone. Choose another time.'
        : 'That local time occurs twice in the selected time zone. Choose a different time.',
    );
  return new Date([...candidates][0]!).toISOString();
}

function emptyDraft(): Draft {
  return {
    title: '',
    startsAtLocal: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    format: 'video',
    status: 'scheduled',
    contacts: [],
    checklist: [],
    notes: '',
    reminderAtLocal: '',
    resumeUploadIds: [],
  };
}

function editDraft(round: Round): Draft {
  return {
    title: round.title,
    startsAtLocal: localTimeInZone(round.startsAt, round.timeZone),
    timeZone: round.timeZone,
    format: round.format,
    status: round.status,
    contacts: round.contacts.map((contact) => ({ ...contact })),
    checklist: round.checklist.map((item) => ({ ...item })),
    notes: round.notes,
    reminderAtLocal: round.reminderAt ? localTimeInZone(round.reminderAt, round.timeZone) : '',
    resumeUploadIds: [...round.resumeUploadIds],
  };
}

function displayDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

export default function InterviewOrganizer({ leadId, csrf }: { leadId: string; csrf: string }) {
  const owner = useOwner();
  const cache = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [newChecklistItem, setNewChecklistItem] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const roundsKey = ownerKey(owner, 'interview-rounds', leadId);
  const rounds = useQuery({
    queryKey: roundsKey,
    queryFn: ({ signal }) => api<{ items: Round[] }>(`/leads/${leadId}/interviews`, { signal }),
    enabled: Boolean(owner),
    retry: 1,
  });
  const resumes = useQuery({
    queryKey: ownerKey(owner, 'resumes'),
    queryFn: ({ signal }) => api<{ enabled: boolean; items: Resume[] }>('/resumes', { signal }),
    enabled: Boolean(owner),
    retry: 1,
  });
  const mutation = useMutation({
    mutationFn: (payload: WriteInput) =>
      editing && editing !== 'new'
        ? api<Round>(`/interviews/${editing}`, {
            method: 'PUT',
            headers: { 'x-csrf-token': csrf },
            body: JSON.stringify({
              ...payload,
              revision: rounds.data?.items.find((item) => item.id === editing)?.revision,
            }),
          })
        : api<Round>(`/leads/${leadId}/interviews`, {
            method: 'POST',
            headers: { 'x-csrf-token': csrf },
            body: JSON.stringify(payload),
          }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: roundsKey });
      setEditing(null);
      setDraft(emptyDraft());
      setFormError(null);
    },
  });
  const parsedResumes = useMemo(
    () => (resumes.data?.items ?? []).filter((item) => item.status === 'parsed'),
    [resumes.data?.items],
  );

  function beginEdit(round: Round): void {
    setEditing(round.id);
    setDraft(editDraft(round));
    setFormError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);
    try {
      const startsAt = instantForTimeZone(draft.startsAtLocal, draft.timeZone);
      const reminderAt = draft.reminderAtLocal
        ? instantForTimeZone(draft.reminderAtLocal, draft.timeZone)
        : null;
      if (reminderAt && Date.parse(reminderAt) >= Date.parse(startsAt))
        throw new Error('Reminder time must be before the interview.');
      mutation.mutate({
        title: draft.title,
        startsAt,
        timeZone: draft.timeZone,
        format: draft.format,
        status: draft.status,
        checklist: draft.checklist,
        notes: draft.notes,
        reminderAt,
        resumeUploadIds: draft.resumeUploadIds,
        contacts: draft.contacts.filter((contact) => contact.name.trim()),
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Check the interview details.');
    }
  }

  return (
    <section className={styles.panel} aria-label="Interview organizer">
      <div className={styles.heading}>
        <div>
          <h2>Interview rounds</h2>
          <p>Plan interview details and preparation for this application.</p>
        </div>
        {!editing && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              setDraft(emptyDraft());
              setEditing('new');
            }}
          >
            <Plus size={16} aria-hidden="true" /> Add round
          </button>
        )}
      </div>

      {rounds.isPending ? (
        <LoadingState variant="inline" message="Loading interview rounds…" />
      ) : rounds.error ? (
        <ErrorState
          variant="inline"
          what="Could not load interview rounds."
          detail={rounds.error.message}
        />
      ) : rounds.data?.items.length ? (
        <ol className={styles.roundList}>
          {rounds.data.items.map((round) => (
            <li key={round.id} className={styles.round}>
              <div className={styles.roundHeader}>
                <div>
                  <h3>{round.title}</h3>
                  <p>
                    {displayDate(round.startsAt, round.timeZone)} · {round.timeZone} ·{' '}
                    {round.format}
                  </p>
                </div>
                <span className={styles.status} data-status={round.status}>
                  {round.status}
                </span>
              </div>
              {round.contacts.length > 0 && (
                <p className={styles.detailLine}>
                  Interviewer{round.contacts.length > 1 ? 's' : ''}:{' '}
                  {round.contacts.map((contact) => contact.name).join(', ')}
                </p>
              )}
              {round.checklist.length > 0 && (
                <ul
                  className={styles.checklist}
                  aria-label={`${round.title} preparation checklist`}
                >
                  {round.checklist.map((item) => (
                    <li key={item.id}>
                      {item.completed ? 'Done: ' : 'To do: '}
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
              {round.notes && <p className={styles.notes}>{round.notes}</p>}
              {round.reminderAt && (
                <p className={styles.notice}>
                  Reminder time saved for {displayDate(round.reminderAt, round.timeZone)}. The
                  in-app notification appears at that time; email and push are not sent.
                </p>
              )}
              {round.resumeUploadIds.length > 0 && (
                <p className={styles.detailLine}>
                  {round.resumeUploadIds.length} resume document attached
                </p>
              )}
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => beginEdit(round)}
              >
                Edit round
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>No interview rounds added yet.</p>
      )}

      {editing && (
        <form className={styles.form} onSubmit={submit}>
          <h3>{editing === 'new' ? 'Add interview round' : 'Edit interview round'}</h3>
          <label>
            Round name
            <input
              required
              maxLength={120}
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            Date and time
            <input
              required
              type="datetime-local"
              value={draft.startsAtLocal}
              onChange={(event) => setDraft({ ...draft, startsAtLocal: event.target.value })}
            />
          </label>
          <label>
            Time zone (IANA)
            <input
              required
              maxLength={128}
              value={draft.timeZone}
              onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
            />
          </label>
          <label>
            Format
            <select
              value={draft.format}
              onChange={(event) =>
                setDraft({ ...draft, format: event.target.value as Draft['format'] })
              }
            >
              <option value="video">Video</option>
              <option value="phone">Phone</option>
              <option value="onsite">On-site</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Status
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value as Draft['status'] })
              }
            >
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <fieldset>
            <legend>Interview contacts</legend>
            {draft.contacts.map((contact, index) => (
              <div className={styles.contact} key={index}>
                <label>
                  Name
                  <input
                    maxLength={120}
                    value={contact.name}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        contacts: draft.contacts.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Role
                  <input
                    maxLength={120}
                    value={contact.role ?? ''}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        contacts: draft.contacts.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, role: event.target.value || null }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    maxLength={254}
                    value={contact.email ?? ''}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        contacts: draft.contacts.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, email: event.target.value || null }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Remove contact ${index + 1}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      contacts: draft.contacts.filter((_, itemIndex) => itemIndex !== index),
                    })
                  }
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
            {draft.contacts.length < 10 && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() =>
                  setDraft({
                    ...draft,
                    contacts: [...draft.contacts, { name: '', role: null, email: null }],
                  })
                }
              >
                <Plus size={16} aria-hidden="true" /> Add contact
              </button>
            )}
          </fieldset>
          <fieldset>
            <legend>Preparation checklist</legend>
            {draft.checklist.map((item) => (
              <div className={styles.checkItem} key={item.id}>
                <input
                  type="checkbox"
                  checked={item.completed}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      checklist: draft.checklist.map((entry) =>
                        entry.id === item.id
                          ? { ...entry, completed: event.target.checked }
                          : entry,
                      ),
                    })
                  }
                  aria-label={`Completed: ${item.label}`}
                />
                <span>{item.label}</span>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Remove ${item.label}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      checklist: draft.checklist.filter((entry) => entry.id !== item.id),
                    })
                  }
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
            <div className={styles.inlineAdd}>
              <label className="sr-only" htmlFor={`new-check-${leadId}`}>
                New preparation item
              </label>
              <input
                id={`new-check-${leadId}`}
                maxLength={200}
                value={newChecklistItem}
                onChange={(event) => setNewChecklistItem(event.target.value)}
              />
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={!newChecklistItem.trim() || draft.checklist.length >= 30}
                onClick={() => {
                  setDraft({
                    ...draft,
                    checklist: [
                      ...draft.checklist,
                      { id: crypto.randomUUID(), label: newChecklistItem.trim(), completed: false },
                    ],
                  });
                  setNewChecklistItem('');
                }}
              >
                <Plus size={16} aria-hidden="true" /> Add item
              </button>
            </div>
          </fieldset>
          <label>
            Reminder time (optional)
            <input
              type="datetime-local"
              value={draft.reminderAtLocal}
              onChange={(event) => setDraft({ ...draft, reminderAtLocal: event.target.value })}
            />
          </label>
          <p className={styles.notice}>
            Reminders appear in CareerScope notifications at the selected time. Email and push
            notifications are not sent.
          </p>
          {parsedResumes.length > 0 && (
            <label>
              Attach parsed resume documents
              <select
                multiple
                value={draft.resumeUploadIds}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    resumeUploadIds: Array.from(
                      event.target.selectedOptions,
                      (option) => option.value,
                    ),
                  })
                }
              >
                {parsedResumes.map((resume) => (
                  <option key={resume.id} value={resume.id}>
                    {resume.contentType.includes('pdf') ? 'PDF resume' : 'DOCX resume'} ·{' '}
                    {displayDate(resume.createdAt, draft.timeZone || 'UTC')}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Notes
            <textarea
              maxLength={10000}
              rows={4}
              value={draft.notes}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            />
          </label>
          {(formError || mutation.error) && (
            <ErrorState
              variant="inline"
              what="Could not save this interview round."
              detail={formError ?? mutation.error?.message ?? ''}
            />
          )}
          <div className={styles.formActions}>
            <button type="submit" className={styles.primaryButton} disabled={mutation.isPending}>
              <Save size={16} aria-hidden="true" />
              {mutation.isPending ? 'Saving…' : 'Save round'}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={mutation.isPending}
              onClick={() => {
                setEditing(null);
                setFormError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
