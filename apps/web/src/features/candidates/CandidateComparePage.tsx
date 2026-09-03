import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Chip, Notice } from '../../components/ui';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonText } from '../../components/Skeleton';
import { api } from '../../lib/api-client';
import { JobHeader } from '../jobs/JobHeader';
import { toSkills, useJob } from '../jobs/useJobs';
import { formatStage, useJobCandidates, type JobCandidateResponse } from './useJobCandidates';
import type { ApplicationDetailResponse } from './useApplication';

/** How many candidates fit side by side before the table stops being readable. */
const MAX_COMPARE = 4;

/**
 * Compare shortlisted candidates on one job.
 *
 * EVERY COLUMN IS PERSISTED DATA. The score, its per-feature contributions and
 * the pipeline stage come from `GET /v1/jobs/:id/candidates`; the detected
 * skills come from each application's own parsed profile. Nothing is inferred
 * from a job title, a degree or an employer, and no candidate attribute is
 * synthesised to fill a cell.
 *
 * NO RANKING VERDICT IS OFFERED, and that omission is deliberate. The obvious
 * feature here is "recommended candidate", and it is exactly what BR-01
 * forbids: the system ranks and explains, a human decides. What this screen
 * does instead is put the same facts side by side so the recruiter can see
 * WHY one score differs from another — which is the useful half of a
 * recommendation without the part that makes a hiring decision.
 *
 * THE SCORE'S CEILING IS RESTATED HERE. `baseline-rules-v1` measures one of six
 * features, so 0.30 is the maximum. Two candidates at 0.24 and 0.18 are four
 * and three skills out of five, not "82% vs 60% fit", and a comparison screen
 * is precisely where that misreading would happen.
 */
export function CandidateComparePage() {
  const { jobId } = useParams<{ jobId: string }>();

  const job = useJob(jobId);
  const candidates = useJobCandidates(jobId);
  const [selected, setSelected] = useState<string[]>([]);

  const rows: JobCandidateResponse[] = useMemo(
    () => candidates.data?.pages.flatMap((page) => page.data) ?? [],
    [candidates.data],
  );

  /*
   * The list does not carry parsed skills, so each selected candidate's detail
   * is fetched alongside it. `useQueries` keeps that to one parallel batch that
   * respects the cache — the recruiter has usually opened some of these already.
   */
  const details = useQueries({
    queries: selected.map((applicationId) => ({
      queryKey: ['application', applicationId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<ApplicationDetailResponse>(`/applications/${applicationId}`, { signal }),
    })),
  });

  const required = useMemo(() => toSkills(job.data?.requiredSkills), [job.data?.requiredSkills]);

  function toggle(applicationId: string) {
    setSelected((current) =>
      current.includes(applicationId)
        ? current.filter((id) => id !== applicationId)
        : current.length >= MAX_COMPARE
          ? current
          : [...current, applicationId],
    );
  }

  return (
    <div>
      <JobHeader
        job={job.data}
        loading={job.isPending}
        activeTab="candidates"
        errored={job.isError}
      />

      <div className="mt-6">
        <h2 className="text-lg font-semibold text-neutral-900">Compare candidates</h2>
        <p className="mt-1 max-w-2xl text-sm text-neutral-500">
          Pick up to {MAX_COMPARE} candidates to see their match signals side by side. Every figure
          below is stored data — nothing is estimated.
        </p>
      </div>

      {candidates.isPending && (
        <div className="mt-5">
          <LoadingState label="Loading candidates…">
            <Card>
              <div className="p-5">
                <SkeletonText lines={3} />
              </div>
            </Card>
          </LoadingState>
        </div>
      )}

      {candidates.isError && (
        <div className="mt-5">
          <ErrorState
            error={candidates.error}
            title="Candidates could not be loaded"
            onRetry={() => void candidates.refetch()}
          />
        </div>
      )}

      {candidates.data && rows.length === 0 && (
        <div className="mt-5">
          <EmptyState
            title="No candidates on this job yet"
            description="Once people apply, you can line them up here and compare their match signals."
          />
        </div>
      )}

      {rows.length > 0 && (
        <>
          <Card className="mt-5">
            <CardHeader
              title="Choose candidates"
              description={`${selected.length} of ${MAX_COMPARE} selected`}
            />
            <fieldset className="max-h-64 overflow-y-auto p-3">
              <legend className="sr-only">Candidates to compare</legend>
              <ul className="space-y-1">
                {rows.map((row) => {
                  const checked = selected.includes(row.applicationId);
                  const atLimit = !checked && selected.length >= MAX_COMPARE;
                  return (
                    <li key={row.applicationId}>
                      <label
                        className={`flex items-center gap-2.5 rounded px-2 py-1.5 ${
                          atLimit ? 'opacity-50' : 'cursor-pointer hover:bg-neutral-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={atLimit}
                          onChange={() => toggle(row.applicationId)}
                          className="h-4 w-4 accent-primary-600"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                          {row.candidate.fullName}
                        </span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {formatStage(row.currentStage)}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          </Card>

          {selected.length === 0 ? (
            <div className="mt-5">
              <EmptyState
                title="Nobody selected yet"
                description="Tick two or more candidates above to compare them."
              />
            </div>
          ) : (
            <ComparisonTable
              rows={rows.filter((row) => selected.includes(row.applicationId))}
              details={details}
              required={required}
              jobId={jobId}
            />
          )}
        </>
      )}
    </div>
  );
}

function ComparisonTable({
  rows,
  details,
  required,
  jobId,
}: {
  rows: JobCandidateResponse[];
  details: { data?: ApplicationDetailResponse; isPending: boolean }[];
  required: string[];
  jobId: string | undefined;
}) {
  const byApplication = new Map(
    details.filter((d) => d.data).map((d) => [d.data!.id, d.data!] as const),
  );

  /** The scorer's rule, mirrored exactly so this cannot disagree with the score. */
  const coverageFor = (applicationId: string) => {
    const detail = byApplication.get(applicationId);
    const skills = detail?.resume?.parsedProfile?.skills;
    if (!detail || !skills) return null;

    const held = new Set(skills.map((s) => s.toLowerCase()));
    const matched = required.filter((skill) => held.has(skill.toLowerCase()));
    return {
      matched,
      missing: required.filter((skill) => !held.has(skill.toLowerCase())),
      ratio: required.length === 0 ? null : matched.length / required.length,
    };
  };

  return (
    <div className="mt-5">
      <Card>
        <CardHeader title="Side by side" />
        {/* Wide content scrolls inside its own container rather than pushing
            the page sideways. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Candidate comparison for this job</caption>
            <thead>
              <tr className="border-b border-neutral-200">
                <th scope="col" className="w-40 px-5 py-3 text-left font-semibold text-neutral-700">
                  Signal
                </th>
                {rows.map((row) => (
                  <th
                    key={row.applicationId}
                    scope="col"
                    className="px-5 py-3 text-left font-semibold text-neutral-900"
                  >
                    {jobId ? (
                      <Link
                        to={`/jobs/${jobId}/candidates/${row.applicationId}`}
                        className="hover:underline"
                      >
                        {row.candidate.fullName}
                      </Link>
                    ) : (
                      row.candidate.fullName
                    )}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-neutral-200">
              <Row label="Match score">
                {rows.map((row) => (
                  <Cell key={row.applicationId}>
                    {row.score ? (
                      <span className="font-mono text-base font-semibold text-neutral-900">
                        {row.score.composite.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-neutral-500">No score</span>
                    )}
                    {row.score?.overridden && (
                      <span className="ml-2">
                        <Badge tone="warning">Overridden</Badge>
                      </span>
                    )}
                  </Cell>
                ))}
              </Row>

              <Row label="Required-skill coverage">
                {rows.map((row) => {
                  const coverage = coverageFor(row.applicationId);
                  return (
                    <Cell key={row.applicationId}>
                      {coverage?.ratio == null ? (
                        <span className="text-neutral-500">
                          {required.length === 0 ? 'No required skills set' : 'No resume parsed'}
                        </span>
                      ) : (
                        <>
                          <span className="font-mono text-neutral-900">
                            {Math.round(coverage.ratio * 100)}%
                          </span>
                          <span className="ml-2 text-xs text-neutral-500">
                            {coverage.matched.length}/{required.length}
                          </span>
                        </>
                      )}
                    </Cell>
                  );
                })}
              </Row>

              <Row label="Matched skills">
                {rows.map((row) => {
                  const coverage = coverageFor(row.applicationId);
                  return (
                    <Cell key={row.applicationId}>
                      {!coverage ? (
                        <span className="text-neutral-500">—</span>
                      ) : coverage.matched.length === 0 ? (
                        <span className="text-neutral-500">None detected</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {coverage.matched.map((skill) => (
                            <li key={skill}>
                              <Chip>{skill}</Chip>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Cell>
                  );
                })}
              </Row>

              <Row label="Not detected">
                {rows.map((row) => {
                  const coverage = coverageFor(row.applicationId);
                  return (
                    <Cell key={row.applicationId}>
                      {!coverage ? (
                        <span className="text-neutral-500">—</span>
                      ) : coverage.missing.length === 0 ? (
                        <span className="text-neutral-500">All required skills found</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {coverage.missing.map((skill) => (
                            <li key={skill}>
                              <span className="inline-flex items-center rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
                                {skill}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Cell>
                  );
                })}
              </Row>

              <Row label="Pipeline stage">
                {rows.map((row) => (
                  <Cell key={row.applicationId}>
                    <Badge tone="primary">{formatStage(row.currentStage)}</Badge>
                  </Cell>
                ))}
              </Row>

              <Row label="Resume">
                {rows.map((row) => (
                  <Cell key={row.applicationId}>
                    <span className="text-neutral-700">
                      {row.parseStatus ? formatStage(row.parseStatus) : 'Not uploaded'}
                    </span>
                  </Cell>
                ))}
              </Row>
            </tbody>
          </table>
        </div>

        <div className="border-t border-neutral-200 p-5">
          {/*
            Said on the screen most likely to invite a false reading: a
            comparison naturally reads as a ranking, so the ceiling and the
            "not detected" caveat are restated right where the numbers are.
          */}
          <Notice tone="info" title="How to read these numbers">
            <p>
              Scores come from <span className="font-medium">baseline-rules-v1</span>, a rule-based
              scorer, not a trained model. It measures one of six ranking features — skill overlap —
              so <span className="font-medium">0.30 is the maximum any candidate can score</span>. A
              gap between two scores reflects matched skills and nothing else.
            </p>
            <p className="mt-1">
              &ldquo;Not detected&rdquo; means the term was not found in the resume text. The parser
              recognises a fixed vocabulary, so it is not evidence that a candidate lacks the skill
              — it is a question worth asking them.
            </p>
          </Notice>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="align-top">
      <th scope="row" className="px-5 py-4 text-left font-medium text-neutral-700">
        {label}
      </th>
      {children}
    </tr>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-4">{children}</td>;
}
