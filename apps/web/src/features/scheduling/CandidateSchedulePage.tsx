import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CareersLayout } from '../careers/CareersLayout';
import { Card, CardHeader, Notice, buttonClass } from '../../components/ui';
import { ErrorState } from '../../components/ErrorState';
import {
  classifyFailure,
  formatExpiry,
  formatSlot,
  isStaleOffer,
  slotDurationMinutes,
  useConfirmSlot,
  useSchedulingOffer,
  type SchedulingConfirmation,
  type SchedulingFailure,
  type SchedulingOffer,
} from './useScheduling';

/**
 * FR6.2 — the candidate picks their interview time.
 *
 * PUBLIC, AND HOLDS NOTHING TENANT-SCOPED. It renders inside `CareersLayout`
 * rather than `RecruiterLayout` for the reason that layout's own comment gives:
 * the recruiter shell draws tenant-scoped navigation and reads `useAuth()`, and
 * a candidate has neither a session nor any business seeing those links.
 *
 * WHAT IS DELIBERATELY NOT ON SCREEN: the interview id, the application id, the
 * slot ids, the candidate's own record, the job id, any score, any stage, and
 * the scheduling token itself. The server sends the job title, courtesy
 * interviewer labels, the offered windows and an expiry — that is the whole
 * surface, and the page adds nothing to it. `slotId` is used as a form value
 * and a React key but never rendered, because a candidate has no use for a uuid
 * and printing one invites it into a screenshot or a support ticket.
 */
export function CandidateSchedulePage() {
  const { token } = useParams<{ token: string }>();
  const offer = useSchedulingOffer(token);
  const confirm = useConfirmSlot(token);

  const [selected, setSelected] = useState<string | null>(null);

  if (offer.isPending) {
    return (
      <SchedulingShell>
        <Card>
          <div className="px-6 py-16 text-center" aria-busy="true">
            <span className="sr-only">Loading your interview details…</span>
            <div className="mx-auto h-2 w-32 animate-pulse rounded-full bg-neutral-200" />
          </div>
        </Card>
      </SchedulingShell>
    );
  }

  if (offer.isError) {
    return (
      <SchedulingShell>
        <LinkProblem
          failure={classifyFailure(offer.error)}
          error={offer.error}
          onRetry={() => void offer.refetch()}
        />
      </SchedulingShell>
    );
  }

  if (confirm.isSuccess) {
    return (
      <SchedulingShell>
        <Confirmed offer={offer.data} result={confirm.data} />
      </SchedulingShell>
    );
  }

  const failure = confirm.isError ? classifyFailure(confirm.error) : null;

  /*
   * A terminal failure during confirmation replaces the form entirely. Leaving
   * a slot list on screen under a "this link has expired" banner would invite
   * the candidate to keep pressing a button that cannot succeed.
   */
  if (failure && (failure === 'invalid' || failure === 'gone' || failure === 'unknown')) {
    return (
      <SchedulingShell>
        <LinkProblem failure={failure} error={confirm.error} />
      </SchedulingShell>
    );
  }

  return (
    <SchedulingShell>
      <SlotPicker
        offer={offer.data}
        selected={selected}
        onSelect={setSelected}
        onConfirm={() => selected && confirm.mutate(selected)}
        submitting={confirm.isPending}
        failure={failure}
        onRefresh={() => {
          confirm.reset();
          setSelected(null);
          void offer.refetch();
        }}
      />
    </SchedulingShell>
  );
}

function SchedulingShell({ children }: { children: React.ReactNode }) {
  return (
    <CareersLayout>
      <div className="mx-auto max-w-2xl">{children}</div>
    </CareersLayout>
  );
}

/* -------------------------------------------------------------------------- */
/* Slot selection                                                              */
/* -------------------------------------------------------------------------- */

function SlotPicker({
  offer,
  selected,
  onSelect,
  onConfirm,
  submitting,
  failure,
  onRefresh,
}: {
  offer: SchedulingOffer;
  selected: string | null;
  onSelect: (slotId: string) => void;
  onConfirm: () => void;
  submitting: boolean;
  failure: SchedulingFailure | null;
  onRefresh: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
        Choose your interview time
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        You have been invited to interview for{' '}
        <span className="font-medium text-neutral-900">{offer.jobTitle}</span>. Pick one of the
        times below.
      </p>

      {offer.interviewerNames.length > 0 && (
        <p className="mt-1 text-sm text-neutral-600">
          You will be meeting {formatNames(offer.interviewerNames)}.
        </p>
      )}

      {failure && (
        <div className="mt-6">
          <ConfirmProblem
            failure={failure}
            onRefresh={isStaleOffer(failure) ? onRefresh : undefined}
          />
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="Available times" />

        {offer.slots.length === 0 ? (
          /*
           * Reachable only if every offered slot was removed after the link was
           * sent. There is no self-service recovery — the candidate cannot
           * propose a time — so this says who will act, rather than offering a
           * button that does nothing.
           */
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-medium text-neutral-700">No times are on offer</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-600">
              This invitation has no available slots. Your recruiter will be in touch to arrange a
              time with you directly.
            </p>
          </div>
        ) : (
          <>
            <fieldset className="px-6 py-5">
              <legend className="sr-only">Available interview times</legend>
              <ul className="space-y-3">
                {offer.slots.map((slot) => {
                  const minutes = slotDurationMinutes(slot);
                  const isSelected = selected === slot.slotId;
                  return (
                    <li key={slot.slotId}>
                      <label
                        className={`flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 transition ${
                          isSelected
                            ? 'border-primary-500 bg-primary-50 ring-1 ring-primary-500'
                            : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="slot"
                          value={slot.slotId}
                          checked={isSelected}
                          onChange={() => onSelect(slot.slotId)}
                          disabled={submitting}
                          className="mt-1 h-4 w-4 shrink-0 accent-primary-600"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-neutral-900">
                            {formatSlot(slot)}
                          </span>
                          <span className="mt-0.5 block text-xs text-neutral-500">
                            {minutes > 0 && <>{minutes} minutes · </>}
                            {/* Named, because the times above are rendered in
                                the slot's zone rather than the browser's. */}
                            Times shown in {slot.timezone}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-6 py-4">
              <p className="text-xs text-neutral-500">
                This invitation expires on {formatExpiry(offer.expiresAt)}.
              </p>
              <button
                type="button"
                onClick={onConfirm}
                disabled={!selected || submitting}
                className={buttonClass('primary')}
              >
                {submitting ? 'Confirming…' : 'Confirm this time'}
              </button>
            </div>
          </>
        )}
      </Card>

      <p className="mt-4 text-center text-xs text-neutral-500">
        Chosen a time by mistake? Reply to the email from your recruiter and they will re-arrange
        it.
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Success                                                                     */
/* -------------------------------------------------------------------------- */

function Confirmed({ offer, result }: { offer: SchedulingOffer; result: SchedulingConfirmation }) {
  /*
   * The confirmed time is re-rendered from the slot the candidate picked, so it
   * is shown in the SAME timezone the offer used. Formatting `result.scheduledAt`
   * with the browser's zone would be the one place in the flow where the time
   * silently changes.
   */
  const slot = offer.slots.find((candidate) => candidate.startsAt === result.scheduledAt);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
        Your interview is confirmed
      </h1>

      <Card className="mt-6">
        <div className="px-6 py-8 text-center">
          <p className="text-sm text-neutral-600">{offer.jobTitle}</p>
          <p className="mt-2 text-lg font-semibold text-neutral-900">
            {slot ? formatSlot(slot) : new Date(result.scheduledAt).toLocaleString()}
          </p>
          {slot && <p className="mt-1 text-xs text-neutral-500">Times shown in {slot.timezone}</p>}

          {offer.interviewerNames.length > 0 && (
            <p className="mt-4 text-sm text-neutral-600">
              You will be meeting {formatNames(offer.interviewerNames)}.
            </p>
          )}
        </div>
      </Card>

      {/*
        NO CALENDAR CLAIM UNLESS ONE WAS ACTUALLY MADE. `calendarEventId` is
        null whenever no provider is configured, which is the norm in this
        build; FR6.3 counts that as a complete booking. Saying "a calendar
        invitation is on its way" regardless would be the one sentence on this
        page that is not true.
      */}
      <div className="mt-4">
        {result.calendarEventId ? (
          <Notice tone="success" title="Added to the calendar">
            A calendar invitation has been created for this time.
          </Notice>
        ) : (
          <Notice tone="info" title="What happens next">
            Your time is saved. No calendar invitation is sent automatically from this system — your
            recruiter will confirm the meeting details with you.
          </Notice>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Failure states                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A dead link — nothing on this page can recover it.
 *
 * `as="h1"` because this panel becomes the entire document: left at `h2` the
 * page would have no top-level heading at all, which breaks the outline a
 * screen-reader user navigates by.
 */
function LinkProblem({
  failure,
  error,
  onRetry,
}: {
  failure: SchedulingFailure;
  error: unknown;
  onRetry?: () => void;
}) {
  if (failure === 'invalid') {
    return (
      <ErrorState
        as="h1"
        title="This scheduling link is no longer valid"
        error={error}
        // Deliberately no retry: an invalid or expired signature will be
        // invalid on the second press too.
      />
    );
  }

  if (failure === 'gone') {
    return <ErrorState as="h1" title="This interview has already been arranged" error={error} />;
  }

  if (failure === 'unknown') {
    return <ErrorState as="h1" title="We could not find this interview" error={error} />;
  }

  // Network or an unexpected status — the one case where trying again is sensible.
  return <ErrorState as="h1" error={error} onRetry={onRetry} />;
}

/** A recoverable problem raised while confirming; the slot list stays on screen. */
function ConfirmProblem({
  failure,
  onRefresh,
}: {
  failure: SchedulingFailure;
  onRefresh?: () => void;
}) {
  const COPY: Record<string, { tone: 'warning' | 'danger' | 'info'; title: string; body: string }> =
    {
      'slot-taken': {
        tone: 'warning',
        title: 'That time was just taken',
        body: 'Someone confirmed that slot a moment before you did. Refresh the times and choose another.',
      },
      'slot-rejected': {
        tone: 'warning',
        title: 'That time is no longer being offered',
        body: 'The available times have changed since this page loaded. Refresh to see the current list.',
      },
      'calendar-unavailable': {
        tone: 'info',
        title: 'The calendar service is unavailable',
        body: 'Your time could not be booked automatically. Your recruiter will arrange a time with you directly — you do not need to do anything.',
      },
      network: {
        tone: 'danger',
        title: 'We could not confirm that time',
        body: 'Something went wrong reaching the server. Check your connection and try again.',
      },
    };

  const copy = COPY[failure] ?? COPY.network!;

  return (
    <Notice tone={copy.tone} title={copy.title}>
      <p>{copy.body}</p>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="mt-2 text-sm font-medium underline underline-offset-2"
        >
          Refresh available times
        </button>
      )}
    </Notice>
  );
}

/** "Alex", "Alex and Sam", "Alex, Sam and Jo". */
function formatNames(names: string[]): string {
  const clean = names.filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}
