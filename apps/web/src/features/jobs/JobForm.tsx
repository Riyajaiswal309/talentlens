import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ErrorState } from '../../components/ErrorState';
import { MAX_SKILL_LENGTH, MAX_SKILLS, SkillsInput } from './SkillsInput';
import type { JobInput } from './useJobMutations';

/**
 * Field bounds, copied from `CreateJobDto`.
 *
 * Mirrored so a value that the API will reject is caught before the request —
 * §10.5 wants the problem named at the field, and a server 400 arrives as one
 * joined sentence at the top of the form instead.
 */
const LIMITS = {
  title: 200,
  department: 120,
  location: 200,
  employmentType: 60,
  experienceLevel: 60,
  description: 20_000,
} as const;

export interface JobFormValues {
  title: string;
  department: string;
  location: string;
  employmentType: string;
  experienceLevel: string;
  description: string;
  requiredSkills: string[];
}

export const EMPTY_JOB_FORM: JobFormValues = {
  title: '',
  department: '',
  location: '',
  employmentType: '',
  experienceLevel: '',
  description: '',
  requiredSkills: [],
};

/**
 * Trim, then drop what is empty.
 *
 * `''` AND `undefined` ARE DIFFERENT TO THE API. On PATCH, `department: ''`
 * writes an empty string into a nullable column, while omitting the key leaves
 * the stored value alone (`jobs.service.ts` checks `!== undefined` per field).
 * An untouched optional input must therefore send nothing at all.
 */
export function toJobInput(values: JobFormValues): JobInput {
  const text = (value: string) => {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    title: values.title.trim(),
    department: text(values.department),
    location: text(values.location),
    employmentType: text(values.employmentType),
    experienceLevel: text(values.experienceLevel),
    description: text(values.description),
    requiredSkills: values.requiredSkills.length > 0 ? values.requiredSkills : undefined,
  };
}

type FieldErrors = Partial<Record<keyof JobFormValues, string>>;

function validate(values: JobFormValues): FieldErrors {
  const errors: FieldErrors = {};

  if (!values.title.trim()) errors.title = 'Title is required';
  else if (values.title.trim().length > LIMITS.title)
    errors.title = `Title must be ${LIMITS.title} characters or fewer`;

  for (const field of ['department', 'location', 'employmentType', 'experienceLevel'] as const) {
    if (values[field].trim().length > LIMITS[field]) {
      errors[field] = `Must be ${LIMITS[field]} characters or fewer`;
    }
  }

  if (values.description.trim().length > LIMITS.description) {
    errors.description = `Description must be ${LIMITS.description} characters or fewer`;
  }

  if (values.requiredSkills.length > MAX_SKILLS) {
    errors.requiredSkills = `At most ${MAX_SKILLS} skills`;
  } else if (values.requiredSkills.some((skill) => skill.length > MAX_SKILL_LENGTH)) {
    errors.requiredSkills = `Each skill must be ${MAX_SKILL_LENGTH} characters or fewer`;
  }

  return errors;
}

/**
 * RC-03 — the job form, shared by create and edit (Table 5.1 names one screen
 * for both).
 *
 * PIPELINE STAGE CONFIGURATION IS ABSENT. Table 5.1 lists it, but `CreateJobDto`
 * has no stages field and no endpoint accepts one — `jobs.service.create` seeds
 * the six §14.1 defaults itself, inside the same transaction. A control here
 * would either post a field the API rejects or edit nothing, so the section is
 * declared as unavailable instead of simulated.
 *
 * FR1.3 "Duplicate as template" is likewise out: `POST /v1/jobs/:id/duplicate`
 * exists, but it is a separate action on an existing job, not part of this form.
 */
export function JobForm({
  initialValues,
  submitLabel,
  onSubmit,
  onCancel,
  pending,
  error,
  extraSection,
}: {
  initialValues: JobFormValues;
  submitLabel: string;
  onSubmit: (values: JobFormValues) => void;
  onCancel: () => void;
  pending: boolean;
  /** The failed request, rendered verbatim from its problem document. */
  error: unknown;
  /** Edit adds a status section here; create has none. */
  extraSection?: ReactNode;
}) {
  const [values, setValues] = useState<JobFormValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const titleId = useId();
  const departmentId = useId();
  const locationId = useId();
  const employmentTypeId = useId();
  const experienceLevelId = useId();
  const descriptionId = useId();

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues],
  );

  /*
   * Table 5.1's unsaved-changes guard. `beforeunload` is the only hook the
   * browser gives for a reload or a closed tab; in-app navigation is guarded by
   * the Cancel handler below. Registered only while dirty, so a pristine form
   * never interrupts anyone.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function set<K extends keyof JobFormValues>(field: K, value: JobFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    // Clear a field's error as soon as it is edited; re-validated on submit.
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);

    const errors = validate(values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    onSubmit(values);
  }

  function handleCancel() {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    onCancel();
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/*
        The server's own sentence. §23.1 joins every ValidationPipe message into
        one `detail`, so this is where a bound we failed to mirror shows up.
      */}
      {error != null && <ErrorState error={error} title="This job could not be saved" />}

      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Role</h2>
        <div className="mt-3 space-y-4">
          <Text
            id={titleId}
            label="Title"
            required
            value={values.title}
            maxLength={LIMITS.title}
            error={fieldErrors.title}
            onChange={(value) => set('title', value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              id={departmentId}
              label="Department"
              value={values.department}
              maxLength={LIMITS.department}
              error={fieldErrors.department}
              onChange={(value) => set('department', value)}
            />
            <Text
              id={locationId}
              label="Location"
              value={values.location}
              maxLength={LIMITS.location}
              error={fieldErrors.location}
              onChange={(value) => set('location', value)}
            />
            <Text
              id={employmentTypeId}
              label="Employment type"
              value={values.employmentType}
              maxLength={LIMITS.employmentType}
              error={fieldErrors.employmentType}
              onChange={(value) => set('employmentType', value)}
            />
            <Text
              id={experienceLevelId}
              label="Experience level"
              value={values.experienceLevel}
              maxLength={LIMITS.experienceLevel}
              error={fieldErrors.experienceLevel}
              onChange={(value) => set('experienceLevel', value)}
            />
          </div>
        </div>
      </section>

      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Requirements</h2>
        <div className="mt-3">
          <SkillsInput
            value={values.requiredSkills}
            onChange={(skills) => set('requiredSkills', skills)}
            error={fieldErrors.requiredSkills}
          />
        </div>
      </section>

      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Description</h2>
        <div className="mt-3">
          <label
            htmlFor={descriptionId}
            className="mb-1 block text-sm font-semibold text-neutral-900"
          >
            Description
          </label>
          <textarea
            id={descriptionId}
            rows={8}
            value={values.description}
            onChange={(event) => set('description', event.target.value)}
            aria-invalid={fieldErrors.description ? true : undefined}
            className={`w-full rounded-sm border px-3 py-2 text-sm text-neutral-900 ${
              fieldErrors.description ? 'border-danger-700' : 'border-neutral-300'
            }`}
          />
          <p className="mt-1 text-xs text-neutral-500">
            {values.description.length} of {LIMITS.description.toLocaleString()} characters.
          </p>
          {fieldErrors.description && (
            <p className="mt-1 text-sm text-danger-700">{fieldErrors.description}</p>
          )}
        </div>
      </section>

      {/*
        Stated, not simulated — see the component header. Rendering nothing at
        all would leave a reader wondering whether stages were forgotten.
      */}
      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">
          Pipeline stages <span className="text-xs uppercase text-neutral-500">Later</span>
        </h2>
        <p className="mt-2 text-sm text-neutral-700">
          Every new job is created with the six default stages — Applied, Screening, Interview,
          Offer, Hired, Rejected. Editing them per job needs an endpoint the API does not expose
          yet, so this section is read-only for now.
        </p>
      </section>

      {extraSection}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          aria-disabled={pending}
          className="h-10 rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600 disabled:opacity-40"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
        >
          Cancel
        </button>
        {submitted && Object.keys(fieldErrors).length > 0 && (
          <p role="alert" className="text-sm text-danger-700">
            Check the highlighted fields.
          </p>
        )}
      </div>
    </form>
  );
}

/** One text input, carrying the label/error wiring §8.7 requires. */
function Text({
  id,
  label,
  value,
  onChange,
  maxLength,
  error,
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  error?: string;
  required?: boolean;
}) {
  const errorId = `${id}-error`;

  return (
    <div>
      {/* Label above the field, always visible — §10.4 forbids the placeholder
          standing in for it. */}
      <label htmlFor={id} className="mb-1 block text-sm font-semibold text-neutral-900">
        {label} {required && <span className="font-normal text-neutral-500">(Required)</span>}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // The browser bound matches the DTO, so the field cannot exceed it by
        // typing; validate() still runs for pasted values and trimming.
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`h-10 w-full rounded-sm border px-3 text-sm text-neutral-900 ${
          error ? 'border-danger-700' : 'border-neutral-300'
        }`}
      />
      {error && (
        <p id={errorId} className="mt-1 text-sm text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
