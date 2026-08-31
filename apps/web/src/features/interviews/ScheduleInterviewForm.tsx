import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Notice, buttonClass } from '../../components/ui';
import { ErrorState } from '../../components/ErrorState';
import {
  MAX_INTERVIEWERS,
  MAX_SLOTS,
  SLOT_DURATIONS,
  addMinutesIso,
  formatDateTimeInZone,
  localInputToIso,
  localTimezone,
  nowLocalInputValue,
  useAvailability,
  useCreateInterview,
  useInterviewers,
  type AvailabilityQuery,
  type CreateInterviewInput,
  type CreateInterviewResult,
  type Interviewer,
} from './useInterviews';

type Mode = 'self' | 'manual';

interface SlotDraft {
  /** `datetime-local` value, read in the recruiter's own zone. */
  start: string;
  minutes: number;
}

/**
 * FR6.2 / FR6.3 — arrange an interview for one application.
 *
 * LIVES INSIDE THE CANDIDATE PAGE, not on a route of its own. Scheduling is
 * always *for* a specific application, and there is no endpoint that lists
 * interviews across a tenant — so a top-level "Interviews" screen would have
 * nothing to render. The RC-11 nav item therefore stays disabled; see the note
 * in `navigation.ts`.
 *
 * BOTH SERVER MODES ARE OFFERED because they answer different questions. Self-
 * service (FR6.2) offers windows and lets the candidate choose; manual (FR6.3)
 * books a time the recruiter already agreed. The server rejects a body carrying
 * both, so the mode toggle is the only thing that decides which fields are sent.
 */
export function ScheduleInterviewForm({
  applicationId,
  onDone,
}: {
  applicationId: string;
  onDone: () => void;
}) {
  const timezone = useMemo(() => localTimezone(), []);
  const minStart = useMemo(() => nowLocalInputValue(), []);

  const interviewers = useInterviewers();
  const create = useCreateInterview(applicationId);

  const [mode, setMode] = useState<Mode>('self');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [slots, setSlots] = useState<SlotDraft[]>([{ start: '', minutes: 60 }]);
  const [manualStart, setManualStart] = useState('');
  const [availabilityParams, setAvailabilityParams] = useState<AvailabilityQuery | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const availability = useAvailability(availabilityParams);

  /* ── Derived: the concrete slots that would be sent ────────────────────── */
  const resolvedSlots = useMemo(
    () =>
      slots
        .map((slot) => {
          const startsAt = localInputToIso(slot.start);
          if (!startsAt) return null;
          return { startsAt, endsAt: addMinutesIso(startsAt, slot.minutes), timezone };
        })
        .filter((slot): slot is { startsAt: string; endsAt: string; timezone: string } =>
          Boolean(slot),
        ),
    [slots, timezone],
  );

  const manualIso = localInputToIso(manualStart);

  function toggleInterviewer(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= MAX_INTERVIEWERS
          ? current
          : [...current, id],
    );
  }

  /* ── Availability window: the span the recruiter is actually proposing ─── */
  function checkAvailability() {
    const instants =
      mode === 'self'
        ? resolvedSlots.flatMap((slot) => [slot.startsAt, slot.endsAt])
        : manualIso
          ? [manualIso, addMinutesIso(manualIso, 60)]
          : [];

    if (selectedIds.length === 0 || instants.length === 0) {
      setLocalError('Choose at least one interviewer and one time before checking calendars.');
      return;
    }

    const sorted = [...instants].sort();
    setLocalError(null);
    setAvailabilityParams({
      interviewerIds: selectedIds,
      from: sorted[0]!,
      to: sorted[sorted.length - 1]!,
    });
  }

  function submit() {
    setLocalError(null);

    if (mode === 'self') {
      if (resolvedSlots.length === 0) {
        setLocalError('Add at least one time to offer.');
        return;
      }
      if (resolvedSlots.length > MAX_SLOTS) {
        setLocalError(`Offer at most ${MAX_SLOTS} times.`);
        return;
      }
      const input: CreateInterviewInput = {
        applicationId,
        interviewerIds: selectedIds,
        slots: resolvedSlots,
      };
      create.mutate(input);
      return;
    }

    if (!manualIso) {
      setLocalError('Choose the date and time you have agreed.');
      return;
    }
    const input: CreateInterviewInput = {
      applicationId,
      interviewerIds: selectedIds,
      scheduledAt: manualIso,
      timezone,
    };
    create.mutate(input);
  }

  /* ── Success: the link, or the confirmed manual booking ────────────────── */
  if (create.isSuccess) {
    return <Created result={create.data} timezone={timezone} onDone={onDone} />;
  }

  const busy = create.isPending;

  return (
    <div className="space-y-5">
      <ModeToggle mode={mode} onChange={setMode} disabled={busy} />

      <InterviewerPicker
        query={interviewers}
        selectedIds={selectedIds}
        onToggle={toggleInterviewer}
        disabled={busy}
      />

      {mode === 'self' ? (
        <SlotEditor slots={slots} onChange={setSlots} minStart={minStart} disabled={busy} />
      ) : (
        <div>
          <label htmlFor="manual-start" className="block text-sm font-medium text-neutral-800">
            Agreed date and time
          </label>
          <input
            id="manual-start"
            type="datetime-local"
            value={manualStart}
            min={minStart}
            disabled={busy}
            onChange={(event) => setManualStart(event.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Booked directly — the candidate is not asked to choose. Times are in {timezone}.
          </p>
        </div>
      )}

      <AvailabilityBlock
        query={availability}
        interviewers={interviewers.data ?? []}
        selectedIds={selectedIds}
        onCheck={checkAvailability}
        disabled={busy}
      />

      {localError && (
        <Notice tone="warning" title="Check the form">
          {localError}
        </Notice>
      )}

      {create.isError && (
        <ErrorState error={create.error} title="The interview could not be created" />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={submit} disabled={busy} className={buttonClass('primary')}>
          {busy
            ? 'Creating…'
            : mode === 'self'
              ? 'Create interview and generate link'
              : 'Book this time'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className={buttonClass('ghost', 'sm')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  const OPTIONS: { value: Mode; label: string; hint: string }[] = [
    {
      value: 'self',
      label: 'Let the candidate choose',
      hint: 'Offer times and send a scheduling link (FR6.2).',
    },
    {
      value: 'manual',
      label: 'Book a time directly',
      hint: 'Record a time you have already agreed (FR6.3).',
    },
  ];

  return (
    <fieldset>
      <legend className="text-sm font-medium text-neutral-800">How should this be arranged?</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 ${
              mode === option.value
                ? 'border-primary-500 bg-primary-50 ring-1 ring-primary-500'
                : 'border-neutral-200 hover:bg-neutral-50'
            }`}
          >
            <input
              type="radio"
              name="schedule-mode"
              value={option.value}
              checked={mode === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="mt-0.5 h-4 w-4 accent-primary-600"
            />
            <span>
              <span className="block text-sm font-medium text-neutral-900">{option.label}</span>
              <span className="mt-0.5 block text-xs text-neutral-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function InterviewerPicker({
  query,
  selectedIds,
  onToggle,
  disabled,
}: {
  query: ReturnType<typeof useInterviewers>;
  selectedIds: string[];
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-neutral-800">
        Interviewers{' '}
        <span className="font-normal text-neutral-500">(optional, up to {MAX_INTERVIEWERS})</span>
      </legend>

      {query.isPending && (
        <p className="mt-2 text-sm text-neutral-500" aria-busy="true">
          Loading colleagues…
        </p>
      )}

      {query.isError && (
        <div className="mt-2">
          <ErrorState
            error={query.error}
            title="Interviewers could not be loaded"
            onRetry={() => void query.refetch()}
          />
        </div>
      )}

      {query.data && query.data.length === 0 && (
        <p className="mt-2 text-sm text-neutral-500">
          No colleagues in your organisation can be added to a panel yet.
        </p>
      )}

      {query.data && query.data.length > 0 && (
        <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded-md border border-neutral-200 p-2">
          {query.data.map((person) => {
            const checked = selectedIds.includes(person.id);
            const atLimit = !checked && selectedIds.length >= MAX_INTERVIEWERS;
            return (
              <li key={person.id}>
                <label
                  className={`flex items-center gap-2.5 rounded px-2 py-1.5 ${
                    atLimit ? 'opacity-50' : 'cursor-pointer hover:bg-neutral-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || atLimit}
                    onChange={() => onToggle(person.id)}
                    className="h-4 w-4 accent-primary-600"
                  />
                  {/* The email IS the label — `users` holds no display name. */}
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                    {person.email}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {person.role.replace('_', ' ').toLowerCase()}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

function SlotEditor({
  slots,
  onChange,
  minStart,
  disabled,
}: {
  slots: SlotDraft[];
  onChange: (slots: SlotDraft[]) => void;
  minStart: string;
  disabled: boolean;
}) {
  function update(index: number, patch: Partial<SlotDraft>) {
    onChange(slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  }

  return (
    <fieldset>
      <legend className="text-sm font-medium text-neutral-800">Times to offer</legend>
      <p className="mt-1 text-xs text-neutral-500">
        The candidate picks one of these. Times are in {localTimezone()}.
      </p>

      <ul className="mt-2 space-y-2">
        {slots.map((slot, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              aria-label={`Start of option ${index + 1}`}
              value={slot.start}
              min={minStart}
              disabled={disabled}
              onChange={(event) => update(index, { start: event.target.value })}
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <select
              aria-label={`Length of option ${index + 1}`}
              value={slot.minutes}
              disabled={disabled}
              onChange={(event) => update(index, { minutes: Number(event.target.value) })}
              className="rounded-md border border-neutral-300 px-2 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              {SLOT_DURATIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min
                </option>
              ))}
            </select>
            {slots.length > 1 && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(slots.filter((_, i) => i !== index))}
                className={buttonClass('ghost', 'sm')}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {slots.length < MAX_SLOTS && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...slots, { start: '', minutes: 60 }])}
          className={`${buttonClass('secondary', 'sm')} mt-2`}
        >
          Add another time
        </button>
      )}
    </fieldset>
  );
}

/**
 * FR6.1 — free/busy, and the honest absence of it.
 *
 * THREE OUTCOMES, RENDERED DIFFERENTLY. Busy blocks are shown when a provider
 * answered; `notConnected` names the people whose calendars could not be read
 * and is a reportable state, not a failure; a 503 means a configured provider
 * did not answer. Nothing here ever synthesises a free schedule — an
 * unanswered calendar is reported as unknown, never as "available".
 */
function AvailabilityBlock({
  query,
  interviewers,
  selectedIds,
  onCheck,
  disabled,
}: {
  query: ReturnType<typeof useAvailability>;
  interviewers: Interviewer[];
  selectedIds: string[];
  onCheck: () => void;
  disabled: boolean;
}) {
  const emailFor = (id: string) => interviewers.find((p) => p.id === id)?.email ?? id;

  return (
    <div className="rounded-md border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-800">Calendar availability</p>
        <button
          type="button"
          onClick={onCheck}
          disabled={disabled || selectedIds.length === 0}
          className={buttonClass('secondary', 'sm')}
        >
          Check calendars
        </button>
      </div>

      {query.isFetching && (
        <p className="mt-2 text-sm text-neutral-500" aria-busy="true">
          Reading calendars…
        </p>
      )}

      {query.isError && (
        <div className="mt-3">
          {/*
            A 503 is the one availability failure with a specific meaning: a
            provider IS configured and did not answer. Everything else falls
            through to the standard panel.
          */}
          <ErrorState error={query.error} title="Availability could not be read" />
          <p className="mt-2 text-xs text-neutral-500">
            You can still offer times or book directly — scheduling does not depend on this.
          </p>
        </div>
      )}

      {query.data && !query.isFetching && (
        <div className="mt-3 space-y-3">
          {query.data.availability.length > 0 && (
            <ul className="space-y-1.5">
              {query.data.availability.map((entry) => (
                <li key={entry.email} className="text-sm">
                  <span className="font-medium text-neutral-800">{entry.email}</span>
                  {entry.busy.length === 0 ? (
                    <span className="ml-2 text-success-700">free in this window</span>
                  ) : (
                    <ul className="ml-4 mt-0.5 list-disc text-xs text-neutral-600">
                      {entry.busy.map((block, index) => (
                        <li key={index}>
                          busy {formatDateTimeInZone(block.startsAt, null)} –{' '}
                          {formatDateTimeInZone(block.endsAt, null)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          {query.data.notConnected.length > 0 && (
            <Notice tone="info" title="No calendar data for some interviewers">
              {/*
                THE TWO CAUSES ARE NOT DISTINGUISHABLE FROM HERE, so neither is
                asserted. The response says who could not be answered for; it
                does not say whether a provider is configured on the server, and
                an empty `availability` list looks identical whether no provider
                exists or one exists that nobody has linked. Naming a cause we
                cannot observe would be a guess presented as fact.
              */}
              <p>
                {query.data.notConnected.map(emailFor).join(', ')} —{' '}
                {query.data.availability.length === 0
                  ? 'no free/busy information is available for anyone in this window. Either no calendar is connected for these people, or no provider is configured on this server.'
                  : 'these calendars are not connected, so their availability is unknown.'}
              </p>
              <p className="mt-1">
                This is not an error. Offer times or book directly and confirm with them yourself —
                availability is never guessed.
              </p>
              {/* The one actionable thing a recruiter can do about their OWN
                  calendar, from the screen where the gap becomes visible. */}
              <p className="mt-1">
                <Link to="/settings/calendar" className="font-medium underline underline-offset-2">
                  Manage your own calendar connection
                </Link>
              </p>
            </Notice>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* After creation                                                              */
/* -------------------------------------------------------------------------- */

function Created({
  result,
  timezone,
  onDone,
}: {
  result: CreateInterviewResult;
  timezone: string;
  onDone: () => void;
}) {
  if (!result.schedulingToken) {
    // Manual path — there is no link, because the time is already fixed.
    return (
      <div className="space-y-4">
        <Notice tone="success" title="Interview booked">
          {result.scheduledAt
            ? `${formatDateTimeInZone(result.scheduledAt, result.timezone ?? timezone)} (${
                result.timezone ?? timezone
              })`
            : 'The time has been recorded.'}
        </Notice>
        {/* FR6.3 — a null event id is a COMPLETE booking, not a partial one. */}
        {!result.calendarEventId && (
          <Notice tone="info" title="No calendar invitation was created">
            No calendar provider is connected, so nothing was added to anyone’s calendar and no
            invitation was sent. Tell the candidate and the panel yourself.
          </Notice>
        )}
        <button type="button" onClick={onDone} className={buttonClass('primary', 'sm')}>
          Done
        </button>
      </div>
    );
  }

  return (
    <SchedulingLink token={result.schedulingToken} expiresAt={result.expiresAt} onDone={onDone} />
  );
}

/**
 * The self-service link (FR6.2).
 *
 * COPYING IS THE DELIVERY MECHANISM, and the page says so plainly. There is no
 * mailer anywhere in this build, so the link reaches the candidate only if the
 * recruiter sends it. Implying otherwise — "an invitation is on its way" —
 * would be the one sentence here that is false, and the candidate would wait
 * for an email that never arrives.
 */
function SchedulingLink({
  token,
  expiresAt,
  onDone,
}: {
  token: string;
  expiresAt?: string;
  onDone: () => void;
}) {
  const url = `${window.location.origin}/schedule/${token}`;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access can be refused outright; the field below is selectable
      // so the recruiter is never left without a way to get the link.
      setCopyFailed(true);
    }
  }

  return (
    <div className="space-y-4">
      <Notice tone="success" title="Interview created">
        Send this link to the candidate so they can choose one of the times you offered.
      </Notice>

      <div>
        <label htmlFor="scheduling-link" className="block text-sm font-medium text-neutral-800">
          Scheduling link
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id="scheduling-link"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700"
          />
          <button type="button" onClick={() => void copy()} className={buttonClass('secondary')}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        {copyFailed && (
          <p className="mt-1 text-xs text-danger-700">
            Your browser refused clipboard access — select the link above and copy it manually.
          </p>
        )}
        {expiresAt && (
          <p className="mt-1.5 text-xs text-neutral-500">
            Expires {formatDateTimeInZone(expiresAt, null)} — the link stops working after the last
            time you offered.
          </p>
        )}
      </div>

      <Notice tone="warning" title="You must send this link yourself">
        This system does not send email. Nothing has been delivered to the candidate — copy the link
        above into your own email or messaging tool.
      </Notice>

      <button type="button" onClick={onDone} className={buttonClass('primary', 'sm')}>
        Done
      </button>
    </div>
  );
}
