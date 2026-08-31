import { useId, useState, type KeyboardEvent } from 'react';

/** `CreateJobDto`: at most 100 skills, each at most 80 characters. */
export const MAX_SKILLS = 100;
export const MAX_SKILL_LENGTH = 80;

/**
 * The skill tag input Table 5.1 specifies for RC-03.
 *
 * A TAG INPUT RATHER THAN A COMMA-SEPARATED TEXT FIELD, because the API stores
 * `requiredSkills` as an array with a per-item length limit — a single text box
 * would hide which entry broke the 80-character bound and would silently make
 * "Python, SQL" one skill if the recruiter forgot a space convention.
 */
export function SkillsInput({
  value,
  onChange,
  error,
}: {
  value: string[];
  onChange: (skills: string[]) => void;
  error?: string;
}) {
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  function add() {
    const skill = draft.trim();
    if (!skill) return;
    // Case-insensitive de-duplication: "Python" and "python" are one skill to
    // a reader, and storing both would render two identical-looking chips.
    if (value.some((existing) => existing.toLowerCase() === skill.toLowerCase())) {
      setDraft('');
      return;
    }
    if (value.length >= MAX_SKILLS) return;
    onChange([...value, skill]);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter and comma both commit. Enter must not submit the surrounding form
    // — a half-typed skill would otherwise save the job.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
      return;
    }
    // Backspace on an empty box removes the last chip, which is what every
    // token input does and saves reaching for the mouse.
    if (event.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  const tooLong = draft.trim().length > MAX_SKILL_LENGTH;
  const full = value.length >= MAX_SKILLS;

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-sm font-semibold text-neutral-900">
        Required skills
      </label>

      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1">
          {value.map((skill) => (
            <li
              key={skill}
              className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
            >
              {skill}
              <button
                type="button"
                onClick={() => onChange(value.filter((item) => item !== skill))}
                // The chip text alone would make every button read "✕".
                aria-label={`Remove ${skill}`}
                className="rounded-full px-1 text-neutral-500 hover:text-neutral-900"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          // Committing on blur too, so a typed skill is not lost by clicking
          // Save instead of pressing Enter.
          onBlur={add}
          disabled={full}
          aria-describedby={error ? errorId : hintId}
          aria-invalid={error || tooLong ? true : undefined}
          placeholder={full ? `Maximum ${MAX_SKILLS} skills` : 'Type a skill and press Enter'}
          className={`h-10 w-72 rounded-sm border px-3 text-sm text-neutral-900 disabled:bg-neutral-100 ${
            error || tooLong ? 'border-danger-700' : 'border-neutral-300'
          }`}
        />
        <button
          type="button"
          onClick={add}
          disabled={full || !draft.trim() || tooLong}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-40"
        >
          Add
        </button>
      </div>

      <p id={hintId} className="mt-1 text-xs text-neutral-500">
        {value.length} of {MAX_SKILLS}. Each skill may be up to {MAX_SKILL_LENGTH} characters.
      </p>

      {tooLong && (
        <p className="mt-1 text-sm text-danger-700">
          A skill must be {MAX_SKILL_LENGTH} characters or fewer.
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
