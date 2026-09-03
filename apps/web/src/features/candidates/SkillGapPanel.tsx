import { useMemo } from 'react';
import { Card, CardHeader, Chip, Notice } from '../../components/ui';
import { toSkills } from '../jobs/useJobs';

/**
 * Skill gap — which of the job's required skills were found on the resume.
 *
 * THE SAME RULE THE SCORER USES, so the two can never disagree on screen.
 * `baseline-rules-v1` computes `skill_overlap` as
 * `|required ∩ extracted| / |required|`, case-insensitively, and this mirrors
 * that exactly. If the panel said a skill matched while the score said it did
 * not, the recruiter would have no way to tell which was lying.
 *
 * NOTHING HERE IS INFERRED. Both sides are persisted data: `jobs.required_skills`
 * as the recruiter typed them, and `parsed_profiles.skills` as the parser
 * extracted them. No skill is guessed from a job title, a degree or a previous
 * employer.
 *
 * "MISSING" MEANS NOT DETECTED, NOT ABSENT — and the panel says so rather than
 * letting a recruiter read it as a verdict. The parser matches a closed
 * vocabulary against resume text, so a skill the candidate genuinely holds is
 * missing here whenever they phrased it differently or the vocabulary lacks it.
 * Treating that as "does not have the skill" is exactly the automated judgement
 * BR-01 forbids.
 */
export function SkillGapPanel({
  requiredSkills,
  candidateSkills,
  parsed,
}: {
  /** `jobs.required_skills` — Json on the wire. */
  requiredSkills: unknown;
  /** `parsed_profiles.skills`, or null when nothing has been parsed. */
  candidateSkills: string[] | null;
  /** False when no resume has been parsed for this application yet. */
  parsed: boolean;
}) {
  const { required, matched, missing, coverage } = useMemo(() => {
    const req = toSkills(requiredSkills);
    const held = new Set((candidateSkills ?? []).map((s) => s.toLowerCase()));

    // Compared lower-case, displayed as the recruiter typed it.
    const hit = req.filter((skill) => held.has(skill.toLowerCase()));
    const gap = req.filter((skill) => !held.has(skill.toLowerCase()));

    return {
      required: req,
      matched: hit,
      missing: gap,
      coverage: req.length === 0 ? null : hit.length / req.length,
    };
  }, [requiredSkills, candidateSkills]);

  // Nothing to compare against — say which side is missing, not "0 skills".
  if (required.length === 0) {
    return (
      <Card>
        <CardHeader title="Skill match" />
        <div className="p-5">
          <p className="text-sm text-neutral-600">
            This job lists no required skills, so there is nothing to compare the resume against.
            Add required skills to the job to see a match.
          </p>
        </div>
      </Card>
    );
  }

  if (!parsed) {
    return (
      <Card>
        <CardHeader title="Skill match" />
        <div className="p-5">
          <p className="text-sm text-neutral-600">
            No resume has been parsed for this application yet, so no skills have been extracted to
            compare. This is not a statement about the candidate.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Skill match"
        description={`${matched.length} of ${required.length} required skills found on the resume`}
      />

      <div className="p-5">
        {/*
          §8.2's semantic rule: coverage is a magnitude, so it uses the neutral/
          primary ramp. A red bar on a low match would read as a rejection
          recommendation, which BR-01 forbids the system from making.
        */}
        {coverage !== null && (
          <div className="mb-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-neutral-800">Required-skill coverage</span>
              <span className="font-mono text-sm text-neutral-900">
                {Math.round(coverage * 100)}%
              </span>
            </div>
            <div
              className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-neutral-100"
              role="img"
              aria-label={`${matched.length} of ${required.length} required skills matched`}
            >
              <div
                className="h-full rounded-full bg-primary-500"
                style={{ width: `${Math.round(coverage * 100)}%` }}
              />
            </div>
          </div>
        )}

        <section>
          <h3 className="text-sm font-semibold text-neutral-900">
            Found on the resume ({matched.length})
          </h3>
          {matched.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              None of the required skills were detected in the resume text.
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {matched.map((skill) => (
                <li key={skill}>
                  <Chip>{skill}</Chip>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 border-t border-neutral-200 pt-5">
          <h3 className="text-sm font-semibold text-neutral-900">
            Not detected ({missing.length})
          </h3>
          {missing.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              Every required skill was found in the resume text.
            </p>
          ) : (
            <>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {missing.map((skill) => (
                  <li key={skill}>
                    <span className="inline-flex items-center rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
                      {skill}
                    </span>
                  </li>
                ))}
              </ul>

              {/*
                Framed as questions to ASK, never as a conclusion about the
                candidate. The system may direct attention; the judgement stays
                with the interviewer (BR-01).
              */}
              <div className="mt-4">
                <Notice tone="info" title="Suggested interview focus">
                  <p>
                    The resume did not mention{' '}
                    <span className="font-medium">{missing.slice(0, 4).join(', ')}</span>
                    {missing.length > 4 ? ` and ${missing.length - 4} more` : ''}. Worth asking
                    about directly — a skill can be held without appearing in the wording of a
                    resume.
                  </p>
                </Notice>
              </div>
            </>
          )}
        </section>

        <p className="mt-5 border-t border-neutral-200 pt-4 text-xs leading-relaxed text-neutral-500">
          Matched by comparing this job&rsquo;s required skills against the skills the parser
          extracted, using the same rule as the match score. The parser recognises a fixed
          vocabulary of skill names, so &ldquo;not detected&rdquo; means the term was not found in
          the resume text — not that the candidate lacks the skill.
        </p>
      </div>
    </Card>
  );
}
