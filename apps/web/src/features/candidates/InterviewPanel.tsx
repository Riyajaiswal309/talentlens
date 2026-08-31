import { useState } from 'react';
import { Badge, Card, CardHeader, Notice, buttonClass } from '../../components/ui';
import { CalendarIcon } from '../../components/icons';
import { ErrorState } from '../../components/ErrorState';
import { SkeletonText } from '../../components/Skeleton';
import { ScheduleInterviewForm } from '../interviews/ScheduleInterviewForm';
import { useCancelInterview } from '../interviews/useInterviews';
import { formatStage } from './useJobCandidates';
import type { InterviewResponse } from './useApplication';

/**
 * Interviews for this application, and the control that arranges one (RC-11).
 *
 * SCHEDULING LIVES HERE RATHER THAN ON ITS OWN ROUTE. An interview is always
 * *for* an application, and no endpoint lists interviews across a tenant — a
 * top-level screen would have nothing to show. The form is opened in place so
 * the recruiter keeps the candidate's record in view while choosing times.
 *
 * ROLE IS ALREADY SETTLED BY THE ROUTER. This page sits behind `RequireRole`
 * with its default `RECRUITER_APP_ROLES` (Recruiter and Admin) — exactly the
 * roles `POST /v1/interviews` and `GET /v1/interviewers` allow — so no
 * additional role check is needed or attempted here.
 */
export function InterviewPanel({
  applicationId,
  query,
  readOnly = false,
}: {
  applicationId?: string;
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data: InterviewResponse[] | undefined;
    refetch: () => void;
  };
  /**
   * Hides the scheduling form (FR6.2/FR6.3).
   *
   * `POST /v1/interviews` is Recruiter and Admin only. Amendment D26 is
   * explicit that a Hiring Manager "may read interviews on an assigned job but
   * not create one", so the panel still lists what is arranged and simply
   * offers no way to arrange more.
   */
  readOnly?: boolean;
}) {
  const [scheduling, setScheduling] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Interviews"
        action={
          // Only when the list has something in it — an empty panel carries its
          // own call to action below, and two identical buttons is one too many.
          !readOnly &&
          !scheduling &&
          !query.isPending &&
          !query.isError &&
          (query.data?.length ?? 0) > 0 ? (
            <button
              type="button"
              onClick={() => setScheduling(true)}
              className={buttonClass('secondary', 'sm')}
            >
              Schedule interview
            </button>
          ) : undefined
        }
      />
      <div className="p-5">
        {scheduling && applicationId && (
          <div className="mb-5 border-b border-neutral-200 pb-5">
            <ScheduleInterviewForm
              applicationId={applicationId}
              onDone={() => setScheduling(false)}
            />
          </div>
        )}

        {query.isPending && (
          <div role="status" aria-live="polite" aria-busy="true">
            <span className="sr-only">Loading interviews…</span>
            <SkeletonText lines={2} />
          </div>
        )}

        {query.isError && (
          <ErrorState
            error={query.error}
            title="Interviews could not be loaded"
            onRetry={() => query.refetch()}
          />
        )}

        {!query.isPending && !query.isError && (query.data?.length ?? 0) === 0 && (
          <div className="flex flex-col items-center py-4 text-center">
            <span className="rounded-full bg-neutral-100 p-3 text-neutral-400">
              <CalendarIcon />
            </span>
            <p className="mt-3 text-sm font-medium text-neutral-700">No interviews arranged yet</p>
            <p className="mt-1 max-w-[34ch] text-xs leading-relaxed text-neutral-500">
              {readOnly
                ? 'The recruiter on this job arranges interviews.'
                : 'Offer the candidate a choice of times, or record a time you have already agreed.'}
            </p>
            {!readOnly && !scheduling && (
              <button
                type="button"
                onClick={() => setScheduling(true)}
                className={`${buttonClass('primary', 'sm')} mt-3`}
              >
                Schedule interview
              </button>
            )}
          </div>
        )}

        {query.data && query.data.length > 0 && (
          <ul className="space-y-4">
            {query.data.map((interview) => (
              <InterviewRow
                key={interview.id}
                interview={interview}
                applicationId={applicationId}
                readOnly={readOnly}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/**
 * One interview, and the only action that applies to it.
 *
 * CANCELLING IS BEHIND A CONFIRMATION because it is not locally reversible:
 * there is no un-cancel route, and the candidate's scheduling link stops
 * working the moment it commits. A confirm step is the cheapest way to keep a
 * misclick from withdrawing a booked interview.
 */
function InterviewRow({
  interview,
  applicationId,
  readOnly,
}: {
  interview: InterviewResponse;
  applicationId?: string;
  readOnly: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancel = useCancelInterview(applicationId);

  const isCancelled = interview.status === 'CANCELLED';
  // D26 — a Hiring Manager reads interviews but does not call one off.
  const canCancel = !readOnly && !isCancelled;

  return (
    <li className="border-t border-neutral-200 pt-4 first:border-0 first:pt-0">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 shrink-0 rounded-md p-1.5 ${
            isCancelled ? 'bg-neutral-100 text-neutral-400' : 'bg-primary-50 text-primary-700'
          }`}
        >
          <CalendarIcon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={`text-sm font-semibold ${
                isCancelled ? 'text-neutral-500' : 'text-neutral-900'
              }`}
            >
              {formatStage(interview.status)}
            </p>
            {isCancelled && <Badge tone="neutral">Cancelled</Badge>}
          </div>

          <p
            className={`mt-0.5 text-sm ${
              isCancelled ? 'text-neutral-500 line-through' : 'text-neutral-700'
            }`}
          >
            {interview.scheduledAt
              ? `${formatDateTime(interview.scheduledAt)}${
                  interview.timezone ? ` (${interview.timezone})` : ''
                }`
              : // PENDING_SELECTION: the candidate has not chosen yet
                // (FR6.2), so there is no time to show.
                `Awaiting the candidate's choice — ${interview.slots.length} slot(s) offered`}
          </p>

          {interview.interviewers.length > 0 && (
            <p className="mt-1 break-words text-xs text-neutral-500">
              {interview.interviewers.map((person) => person.email).join(', ')}
            </p>
          )}

          {/* FR6.3 — null means it was arranged without a calendar
              provider, which is a complete interview, not a failure. */}
          {!interview.calendarEventId && interview.scheduledAt && !isCancelled && (
            <p className="mt-1 text-xs text-neutral-500">Arranged without a calendar invite.</p>
          )}

          {/*
            Said only where it is true. An interview that reached a provider has
            an event id, and this system cannot delete it — the provider
            abstraction has no delete — so the invitation has to be withdrawn by
            hand. Silence here would imply it was cleaned up.
          */}
          {isCancelled && interview.calendarEventId && (
            <p className="mt-1.5 text-xs text-warning-700">
              A calendar invitation was created for this interview and has NOT been withdrawn —
              cancel it in your calendar as well.
            </p>
          )}

          {canCancel && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={`${buttonClass('ghost', 'sm')} mt-2`}
            >
              Cancel interview
            </button>
          )}

          {canCancel && confirming && (
            <div className="mt-3">
              <Notice tone="warning" title="Cancel this interview?">
                <p>
                  {interview.status === 'PENDING_SELECTION'
                    ? 'The scheduling link you sent the candidate will stop working immediately.'
                    : 'The booked time will be withdrawn. This cannot be undone here.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => cancel.mutate(interview.id)}
                    disabled={cancel.isPending}
                    className={buttonClass('danger', 'sm')}
                  >
                    {cancel.isPending ? 'Cancelling…' : 'Yes, cancel it'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={cancel.isPending}
                    className={buttonClass('ghost', 'sm')}
                  >
                    Keep it
                  </button>
                </div>
              </Notice>
            </div>
          )}

          {cancel.isError && (
            <div className="mt-3">
              <ErrorState error={cancel.error} title="The interview was not cancelled" />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
