import { useMemo, useState } from 'react';
import { Card, CardHeader, buttonClass } from '../../components/ui';
import { ErrorState } from '../../components/ErrorState';
import { SkeletonText } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { useInterviewers } from '../interviews/useInterviews';
import {
  ASSIGNABLE_ROLES,
  formatRole,
  useAssignToJob,
  useJobAssignments,
  useUnassignFromJob,
  type JobAssignment,
} from './useJobAssignments';

/**
 * §24.2 — the hiring team on this requisition (amendment B12).
 *
 * WHY THIS PANEL EXISTS. `job_assignments` decides which Hiring Managers can
 * open a job at all — and its candidates, scorecards, comments and interviews
 * behind it. Until now the only way to grant that was an API call, which made
 * the Hiring Manager console unreachable without a terminal.
 *
 * ROLE VISIBILITY IS THE ROUTE'S, NOT THIS COMPONENT'S. RC-04 sits in the
 * recruiter gate (`RECRUITER`, `ADMIN`), so a Hiring Manager cannot reach the
 * screen this renders on and needs no branch here. That is a usability layer
 * regardless: `POST`/`DELETE /v1/jobs/:id/assignments` refuse a Hiring Manager
 * with a 403 whatever the client believes, which is the actual boundary.
 *
 * NO MODAL, because this codebase has no dialog primitive and inventing one
 * would mean focus trapping, escape handling and scroll locking for a form
 * with a single field. It opens in place, the way `ScheduleInterviewForm` does
 * inside the interview panel.
 */
export function JobAssignmentsPanel({ jobId }: { jobId: string }) {
  const { notify } = useToast();
  const assignments = useJobAssignments(jobId);
  const assign = useAssignToJob(jobId);
  const unassign = useUnassignFromJob(jobId);

  const [picking, setPicking] = useState(false);

  return (
    <Card className="mt-5">
      <CardHeader
        title="Assigned hiring managers"
        description="They can open this job and review its candidates. Nobody else on the hiring team sees it."
        action={
          !picking && !assignments.isPending && !assignments.isError ? (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className={buttonClass('secondary', 'sm')}
            >
              + Assign hiring manager
            </button>
          ) : undefined
        }
      />

      <div className="p-5">
        {picking && (
          <div className="mb-5 border-b border-neutral-200 pb-5">
            <AssignPicker
              assigned={assignments.data ?? []}
              submitting={assign.isPending}
              error={assign.error}
              onCancel={() => {
                assign.reset();
                setPicking(false);
              }}
              onAssign={(userId, email) =>
                assign.mutate(userId, {
                  onSuccess: () => {
                    notify(`${email} can now review this job.`);
                    setPicking(false);
                  },
                })
              }
            />
          </div>
        )}

        {assignments.isPending && (
          <div role="status" aria-live="polite" aria-busy="true">
            <span className="sr-only">Loading assignments…</span>
            <SkeletonText lines={2} />
          </div>
        )}

        {assignments.isError && (
          <ErrorState
            error={assignments.error}
            title="Assignments could not be loaded"
            onRetry={() => void assignments.refetch()}
          />
        )}

        {assignments.data && assignments.data.length === 0 && !picking && (
          <div className="py-2 text-center">
            <p className="text-sm font-medium text-neutral-700">No hiring managers assigned</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-xs leading-relaxed text-neutral-500">
              Assign someone to let them review this job&rsquo;s candidates and submit scorecards.
              Until then, only recruiters and administrators can see it.
            </p>
            <button
              type="button"
              onClick={() => setPicking(true)}
              className={`${buttonClass('primary', 'sm')} mt-3`}
            >
              + Assign hiring manager
            </button>
          </div>
        )}

        {assignments.data && assignments.data.length > 0 && (
          <ul className="divide-y divide-neutral-200">
            {assignments.data.map((assignment) => (
              <AssignmentRow
                key={assignment.id}
                assignment={assignment}
                removing={unassign.isPending && unassign.variables === assignment.userId}
                onRemove={() => {
                  /*
                   * `window.confirm`, matching RC-04's existing publish, close
                   * and duplicate confirmations on this very screen. Removing
                   * access is exactly the kind of act that should not happen on
                   * a stray click.
                   */
                  const message =
                    `Remove ${assignment.email} from this job?\n\n` +
                    'They will immediately lose access to this job and its candidates.';
                  if (!window.confirm(message)) return;

                  unassign.mutate(assignment.userId, {
                    onSuccess: () => notify(`${assignment.email} no longer has access.`),
                  });
                }}
              />
            ))}
          </ul>
        )}

        {unassign.isError && (
          <div className="mt-4">
            <ErrorState error={unassign.error} title="The assignment was not removed" />
          </div>
        )}
      </div>
    </Card>
  );
}

function AssignmentRow({
  assignment,
  removing,
  onRemove,
}: {
  assignment: JobAssignment;
  removing: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        {/* The email IS the label — `users` holds no display name. */}
        <p className="truncate text-sm font-medium text-neutral-900">{assignment.email}</p>
        <p className="mt-0.5 text-xs text-neutral-500">{formatRole(assignment.role)}</p>
      </div>

      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        className={buttonClass('ghost', 'sm')}
      >
        {removing ? 'Removing…' : 'Remove'}
      </button>
    </li>
  );
}

/**
 * Choose someone to assign.
 *
 * THE LIST IS NARROWED TWICE, for two different reasons. `GET /v1/interviewers`
 * already excludes Candidates server-side; this filters out Recruiters, whom
 * the assignment API refuses with a 400 because they already reach every job
 * and the row would be inert. Anyone already assigned is excluded too — the
 * server answers 409, and offering a name that can only fail is worse than not
 * offering it.
 */
function AssignPicker({
  assigned,
  submitting,
  error,
  onAssign,
  onCancel,
}: {
  assigned: JobAssignment[];
  submitting: boolean;
  error: unknown;
  onAssign: (userId: string, email: string) => void;
  onCancel: () => void;
}) {
  const interviewers = useInterviewers();
  const [selected, setSelected] = useState('');

  const assignedIds = useMemo(() => new Set(assigned.map((a) => a.userId)), [assigned]);

  const eligible = useMemo(
    () =>
      (interviewers.data ?? []).filter(
        (person) =>
          (ASSIGNABLE_ROLES as readonly string[]).includes(person.role) &&
          !assignedIds.has(person.id),
      ),
    [interviewers.data, assignedIds],
  );

  if (interviewers.isPending) {
    return (
      <p className="text-sm text-neutral-500" aria-busy="true">
        Loading colleagues…
      </p>
    );
  }

  if (interviewers.isError) {
    return (
      <ErrorState
        error={interviewers.error}
        title="Colleagues could not be loaded"
        onRetry={() => void interviewers.refetch()}
      />
    );
  }

  if (eligible.length === 0) {
    return (
      <div>
        <p className="text-sm font-medium text-neutral-700">
          {assigned.length > 0 ? 'Everyone eligible is already assigned' : 'No eligible colleagues'}
        </p>
        <p className="mt-1 max-w-[60ch] text-xs leading-relaxed text-neutral-500">
          Only hiring managers and administrators can be assigned to a job. Recruiters already reach
          every job in the company, so assigning one would grant nothing.
        </p>
        <button type="button" onClick={onCancel} className={`${buttonClass('ghost', 'sm')} mt-3`}>
          Close
        </button>
      </div>
    );
  }

  const chosen = eligible.find((person) => person.id === selected);

  return (
    <div>
      <label htmlFor="assign-user" className="block text-sm font-medium text-neutral-800">
        Assign a hiring manager
      </label>
      <select
        id="assign-user"
        value={selected}
        disabled={submitting}
        onChange={(event) => setSelected(event.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
      >
        <option value="">Choose a colleague…</option>
        {eligible.map((person) => (
          <option key={person.id} value={person.id}>
            {person.email} · {formatRole(person.role)}
          </option>
        ))}
      </select>

      <p className="mt-1.5 text-xs text-neutral-500">
        They will be able to open this job, review its candidates and submit scorecards. They cannot
        move candidates between stages.
      </p>

      {error != null && (
        <div className="mt-3">
          <ErrorState error={error} title="The assignment was not created" />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!chosen || submitting}
          onClick={() => chosen && onAssign(chosen.id, chosen.email)}
          className={buttonClass('primary', 'sm')}
        >
          {submitting ? 'Assigning…' : 'Assign'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className={buttonClass('ghost', 'sm')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
