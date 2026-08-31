import { useState } from 'react';
import { Card, CardHeader, buttonClass } from '../../components/ui';
import { CalendarIcon } from '../../components/icons';
import { ErrorState } from '../../components/ErrorState';
import { SkeletonText } from '../../components/Skeleton';
import { ScheduleInterviewForm } from '../interviews/ScheduleInterviewForm';
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
              <li
                key={interview.id}
                className="border-t border-neutral-200 pt-4 first:border-0 first:pt-0"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0 rounded-md bg-primary-50 p-1.5 text-primary-700">
                    <CalendarIcon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-neutral-900">
                      {formatStage(interview.status)}
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-700">
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
                    {!interview.calendarEventId && interview.scheduledAt && (
                      <p className="mt-1 text-xs text-neutral-500">
                        Arranged without a calendar invite.
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
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
