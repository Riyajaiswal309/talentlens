/**
 * Seed data for local development.
 *
 * RUNS AUTOMATICALLY BEFORE `pnpm test` (the `pretest` script), not only by
 * hand. Three suites — audit.service.spec, null-ai.provider.spec and
 * score-override.spec — need a user and an `ai_model_versions` row to exist,
 * and say so in their own error text ("Run `pnpm prisma:seed` first"). Leaving
 * that as a precondition someone has to remember means the suite passes or
 * fails on the state of the local database rather than on the code, which is
 * exactly what happened once during the Phase 2b closeout.
 *
 * Safe to repeat: every write below is an upsert against a fixed id.
 *
 * PART 1 — the platform baseline the test suite depends on:
 *   - 1 company
 *   - 4 users, one per PRD §24.2 role
 *   - 1 ai_model_versions row: placeholder-v0
 *   - the 6 default pipeline stages from PRD §14.1
 *   - 1 DRAFT job, because pipeline_stages.job_id is NOT NULL (stages belong
 *     to a job, per decision B2 — they are per-job data, not global constants)
 *   - 1 job_assignment, because decision B1's unique (job_id, user_id) pair
 *     needs both to exist for the constraint to be demonstrable
 *
 * PART 2 — a demo dataset, so that a FRESH CLONE is demonstrable the moment
 * `prisma:migrate && prisma:seed` finishes. Before it existed the recruiter
 * console was navigable but empty, and RC-05, RC-06, RC-09, RC-10, RC-12 and
 * RC-13 had nothing to show. It adds one PUBLISHED job with a v4 id, its six
 * stages, and eight candidates spread across the pipeline with the stage
 * history, scorecards and comments a real requisition would have accumulated.
 *
 * WHAT PART 2 DELIBERATELY DOES NOT CREATE:
 *   - No `match_scores`. No model is trained, so a seeded score would be a
 *     fabricated number wearing the authority of a computed one. `aiScoringEnabled`
 *     stays false, which is the FR4.5 unscored path the UI already handles.
 *   - No `resumes` or `parsed_profiles`. An s3_key with no object behind it in
 *     LocalStack is a broken link, and a parsed_profile with no parser is the
 *     same fabrication as a score.
 *   - No `audit_logs`. Those record what actually happened through the API;
 *     writing them here would forge an audit trail.
 *
 * Every `stage_history` row names a real seeded human in `changed_by`, which is
 * what BR-01 requires of a transition — there is no system-actor path.
 *
 * Idempotent: every write is an upsert against a fixed id or unique key, so
 * re-running never duplicates a demo record.
 */
import { PrismaClient, UserRole, JobStatus, ApplicationSource } from '@prisma/client';
import { Algorithm, hash } from '@node-rs/argon2';
import { resolve } from 'node:path';

/*
 * Load the repo-root .env before the client reads DATABASE_URL.
 *
 * The API gets this from ConfigModule (`envFilePath: ['../../.env']`), but a
 * bare `prisma db seed` has no Nest around it and would otherwise only work in
 * a shell that had already sourced the file. Since this now runs as `pretest`,
 * it has to work in a clean shell or it breaks `pnpm test` for everyone.
 *
 * Does not override anything already exported, so CI or a one-off
 * DATABASE_URL=... still wins.
 */
try {
  process.loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // No .env file — fine if the environment is already configured.
}

const prisma = new PrismaClient();

/**
 * Local development password for every seeded account (PRD §24.1 requires a
 * 12-character minimum). Development-only, and never used outside seeding.
 */
const SEED_PASSWORD = 'DevPassword123!';

/** Same Argon2id parameters as PasswordService (OWASP baseline). */
async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

/** PRD §14.1 — the six default stages. Defaults only; FR5.1 allows per-job edits. */
const DEFAULT_STAGES = [
  { name: 'Applied', position: 1, isTerminal: false },
  { name: 'Screening', position: 2, isTerminal: false },
  { name: 'Interview', position: 3, isTerminal: false },
  { name: 'Offer', position: 4, isTerminal: false },
  // BR-01 — terminal stages require explicit human confirmation in the UI.
  { name: 'Hired', position: 5, isTerminal: true },
  { name: 'Rejected', position: 6, isTerminal: true },
];

// ---------------------------------------------------------------------------
// Demo dataset (PART 2)
// ---------------------------------------------------------------------------

/** A genuine v4 UUID — see the note at the upsert for why that matters. */
const DEMO_JOB_ID = '7a1f0c9e-2b34-4d56-8a90-1c2d3e4f5a6b';

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Anchored once per run, so every date in one seeding is consistent with the
 * others. Re-running does not shift them: every demo write is `update: {}`, so
 * the first run's timestamps are what persist.
 */
const SEEDED_AT = Date.now();
const daysAgo = (days: number): Date => new Date(SEEDED_AT - days * DAY_MS);

/**
 * A stable, valid v4 UUID per demo row.
 *
 * Fixed rather than random because idempotency depends on it — `stage_history`
 * and `comments` have no natural unique key, so their id IS the upsert key. A
 * random id would append a fresh copy of the whole thread on every re-run.
 */
function idFor(prefix: string, index: number, step = 0): string {
  const tail = `${index.toString(16).padStart(2, '0')}${step.toString(16).padStart(2, '0')}`;
  return `${prefix}000000-0000-4000-8000-00000000${tail}`;
}

interface DemoApplicant {
  fullName: string;
  email: string;
  phone?: string;
  /** NULL is a real FR7.3 state — "not recorded", never folded into `other`. */
  source: ApplicationSource | null;
  appliedDaysAgo: number;
  /** Transitions AFTER the opening Applied stage, oldest first. */
  path: Array<{ to: string; daysAgo: number }>;
  scorecards?: Array<{ author: 'recruiter' | 'hiringManager'; rating: number; feedback: string }>;
  comments?: Array<{ author: 'recruiter' | 'hiringManager'; body: string }>;
}

/**
 * Eight applicants spread across the six stages.
 *
 * Eight rather than one, because several screens only mean anything with a
 * spread: RC-09's board needs occupied columns, RC-10's bulk bar needs more
 * than one selectable row, and RC-12's funnel needs real drop-off between
 * stages plus one completed hire before it can report a conversion or a
 * time-to-hire at all. One application would render all three technically
 * non-empty and practically undemonstrable.
 *
 * These are ordinary recruiting records — names, channels, stage moves and
 * human-written feedback. Nothing here is model output.
 */
const DEMO_APPLICANTS: DemoApplicant[] = [
  {
    fullName: 'Priya Nair',
    email: 'priya.nair@example.com',
    phone: '+91 98200 41122',
    source: ApplicationSource.career_site,
    appliedDaysAgo: 3,
    path: [],
  },
  {
    fullName: 'Arjun Mehta',
    email: 'arjun.mehta@example.com',
    source: ApplicationSource.job_board,
    appliedDaysAgo: 2,
    path: [],
  },
  {
    fullName: 'Sara Iqbal',
    email: 'sara.iqbal@example.com',
    phone: '+91 99010 77345',
    source: ApplicationSource.referral,
    appliedDaysAgo: 12,
    path: [{ to: 'Screening', daysAgo: 9 }],
    comments: [
      {
        author: 'recruiter',
        body: 'Referred by Meera on the platform team. Moving to screening — availability confirmed for next week.',
      },
    ],
  },
  {
    fullName: 'Daniel Okafor',
    email: 'daniel.okafor@example.com',
    source: ApplicationSource.career_site,
    appliedDaysAgo: 10,
    path: [{ to: 'Screening', daysAgo: 6 }],
    scorecards: [
      {
        author: 'recruiter',
        rating: 3,
        feedback:
          'Solid CRUD and API experience. Less depth on schema design than the role needs, so worth a technical screen before we commit to an interview loop.',
      },
    ],
  },
  {
    fullName: 'Mei Lin Chen',
    email: 'meilin.chen@example.com',
    phone: '+65 8123 4477',
    source: ApplicationSource.career_site,
    appliedDaysAgo: 20,
    path: [
      { to: 'Screening', daysAgo: 17 },
      { to: 'Interview', daysAgo: 12 },
    ],
    scorecards: [
      {
        author: 'recruiter',
        rating: 4,
        feedback:
          'Strong screen. Walked through a migration she ran on a live table without downtime and was candid about what went wrong the first time.',
      },
      {
        author: 'hiringManager',
        rating: 4,
        feedback:
          'Good systems instincts. Pushed back on my framing of the caching question, correctly. Would want a second opinion on frontend depth.',
      },
    ],
    comments: [
      { author: 'hiringManager', body: 'Scheduling the system-design round for Thursday.' },
    ],
  },
  {
    fullName: 'Tomás Rivera',
    email: 'tomas.rivera@example.com',
    source: ApplicationSource.referral,
    appliedDaysAgo: 30,
    path: [
      { to: 'Screening', daysAgo: 27 },
      { to: 'Interview', daysAgo: 22 },
      { to: 'Offer', daysAgo: 14 },
    ],
    scorecards: [
      {
        author: 'hiringManager',
        rating: 5,
        feedback:
          'Best interview in this round. Read the ambiguous requirement as ambiguous and asked, instead of guessing. Recommending an offer.',
      },
    ],
    comments: [{ author: 'recruiter', body: 'Offer sent. Awaiting a response by end of week.' }],
  },
  {
    fullName: 'Aisha Rahman',
    email: 'aisha.rahman@example.com',
    phone: '+91 98453 20918',
    source: ApplicationSource.job_board,
    appliedDaysAgo: 45,
    path: [
      { to: 'Screening', daysAgo: 41 },
      { to: 'Interview', daysAgo: 35 },
      { to: 'Offer', daysAgo: 28 },
      // BR-01 — terminal, and written with a human actor like every other row.
      { to: 'Hired', daysAgo: 21 },
    ],
    scorecards: [
      {
        author: 'recruiter',
        rating: 5,
        feedback:
          'Accepted. Strongest end-to-end candidate we saw for this requisition; onboarding starts next month.',
      },
    ],
  },
  {
    fullName: 'Victor Adeyemi',
    email: 'victor.adeyemi@example.com',
    // Left unrecorded on purpose — see the DemoApplicant.source note.
    source: null,
    appliedDaysAgo: 25,
    path: [
      { to: 'Screening', daysAgo: 21 },
      { to: 'Rejected', daysAgo: 18 },
    ],
    scorecards: [
      {
        author: 'recruiter',
        rating: 2,
        feedback:
          'Experience is mostly in data engineering rather than product work. Not a fit for this role; worth revisiting for a platform opening.',
      },
    ],
  },
];

/**
 * Give one job the six default stages.
 *
 * Extracted because the demo job needs exactly the same axis as the baseline
 * job: `stageOrder()` in the analytics service merges stages by NAME across a
 * company, so a second job whose stage names drifted would split the funnel
 * into parallel rows that mean nothing.
 */
async function seedStages(jobId: string): Promise<void> {
  for (const stage of DEFAULT_STAGES) {
    await prisma.pipelineStage.upsert({
      where: { jobId_name: { jobId, name: stage.name } },
      update: { position: stage.position, isTerminal: stage.isTerminal },
      create: { jobId, ...stage },
    });
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Company
  // -------------------------------------------------------------------------
  const company = await prisma.company.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'TalentLens Demo Company',
      // PRD NFR5 requires a declared operating region but names no value.
      dataRegion: 'local-dev',
    },
  });
  console.log(`  company: ${company.name}`);

  // -------------------------------------------------------------------------
  // Users — one per PRD §24.2 role.
  //
  // Hashed with Argon2id (PRD §24.1) now that M2.4 exists. All four share
  // SEED_PASSWORD for local development only.
  // -------------------------------------------------------------------------
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const users: Array<{ email: string; role: UserRole }> = [
    { email: 'admin@talentlens.local', role: UserRole.ADMIN },
    { email: 'recruiter@talentlens.local', role: UserRole.RECRUITER },
    { email: 'hiring.manager@talentlens.local', role: UserRole.HIRING_MANAGER },
    { email: 'candidate@talentlens.local', role: UserRole.CANDIDATE },
  ];

  const created: Record<string, string> = {};
  for (const u of users) {
    const row = await prisma.users.upsert({
      where: { companyId_email: { companyId: company.id, email: u.email } },
      update: { passwordHash },
      create: { companyId: company.id, email: u.email, role: u.role, passwordHash },
    });
    created[u.role] = row.id;
    console.log(`  user:    ${row.email.padEnd(34)} ${row.role}`);
  }

  // -------------------------------------------------------------------------
  // AI model version — placeholder-v0.
  //
  // Required because match_scores.model_version_id is NOT NULL and references
  // this table (PRD §17.3). Status 'inactive': no model runs in Phase 2.
  // -------------------------------------------------------------------------
  const modelVersion = await prisma.aiModelVersion.upsert({
    where: { modelName_versionTag: { modelName: 'ranker', versionTag: 'placeholder-v0' } },
    update: {},
    create: {
      modelName: 'ranker',
      versionTag: 'placeholder-v0',
      status: 'inactive',
      promotedAt: null,
    },
  });
  console.log(
    `  model:   ${modelVersion.modelName}:${modelVersion.versionTag} (${modelVersion.status})`,
  );

  // -------------------------------------------------------------------------
  // Job — exists so the six pipeline stages have an owner (decision B2).
  // aiScoringEnabled defaults to false, so FR4.5 (unscored list) applies.
  // -------------------------------------------------------------------------
  const recruiterId = created[UserRole.RECRUITER];
  if (!recruiterId) throw new Error('Recruiter user was not created');

  const job = await prisma.job.upsert({
    where: { id: '00000000-0000-0000-0000-000000000010' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000010',
      companyId: company.id,
      createdBy: recruiterId,
      title: 'Senior Backend Engineer',
      department: 'Engineering',
      location: 'Remote',
      employmentType: 'Full-time',
      experienceLevel: 'Senior',
      description: 'Seed job. Exists so the default pipeline stages have an owning job.',
      requiredSkills: ['Python', 'SQL', 'PostgreSQL'],
      status: JobStatus.DRAFT,
    },
  });
  console.log(`  job:     ${job.title}`);

  // -------------------------------------------------------------------------
  // Pipeline stages — DECISION B2.
  // Seeded per job, editable per job. Not a global enum.
  // -------------------------------------------------------------------------
  await seedStages(job.id);
  console.log(`  stages:  ${DEFAULT_STAGES.map((s) => s.name).join(' -> ')}`);

  // -------------------------------------------------------------------------
  // Job assignment — DECISION B1.
  // Gives the Hiring Manager access to this job and nothing else (PRD §24.2).
  // -------------------------------------------------------------------------
  const hmId = created[UserRole.HIRING_MANAGER];
  if (!hmId) throw new Error('Hiring Manager user was not created');

  await prisma.jobAssignment.upsert({
    where: { jobId_userId: { jobId: job.id, userId: hmId } },
    update: {},
    create: { jobId: job.id, userId: hmId },
  });
  console.log(`  assign:  hiring.manager -> ${job.title}`);

  // -------------------------------------------------------------------------
  // PART 2 — the demo dataset.
  // -------------------------------------------------------------------------
  /*
   * A SECOND job rather than a rewrite of the first.
   *
   * The baseline job above stays DRAFT and keeps its readable id: three auth
   * and authorization suites rely on the baseline rows, and RC-02's status
   * filter needs a DRAFT requisition to have anything to filter. This one is
   * PUBLISHED and carries the candidates.
   *
   * ITS ID IS A REAL v4 UUID, which is load-bearing. `SubmitApplicationDto`
   * and `FunnelQueryDto` both validate with `@IsUUID('4')`, so the baseline
   * job's `...0010` id — version nibble 0 — is rejected by POST /v1/applications
   * and by the analytics job filter. A demo job has to pass both.
   */
  const demoJob = await prisma.job.upsert({
    where: { id: DEMO_JOB_ID },
    update: {},
    create: {
      id: DEMO_JOB_ID,
      companyId: company.id,
      createdBy: recruiterId,
      title: 'Full-Stack Engineer',
      department: 'Engineering',
      location: 'Bengaluru (Hybrid)',
      employmentType: 'Full-time',
      experienceLevel: 'Mid',
      description:
        'Build and ship features across the TalentLens web client and its NestJS API. ' +
        'You will own work end to end: schema, endpoint, screen and the tests that keep ' +
        'them honest.\n\n' +
        'We care more about how you reason through a problem than about the exact stack ' +
        'on your CV.',
      requiredSkills: ['TypeScript', 'React', 'NestJS', 'PostgreSQL', 'Prisma'],
      // BR-04 / FR4.5 — no model is trained, so scoring stays off and the
      // console renders its unscored variant. Never seeded true.
      aiScoringEnabled: false,
      status: JobStatus.PUBLISHED,
      publishedAt: daysAgo(50),
    },
  });
  await seedStages(demoJob.id);

  // The Hiring Manager authors a scorecard below, so they must be assigned to
  // this job — PRD §24.2 grants them assigned jobs only.
  await prisma.jobAssignment.upsert({
    where: { jobId_userId: { jobId: demoJob.id, userId: hmId } },
    update: {},
    create: { jobId: demoJob.id, userId: hmId },
  });
  console.log(`  job:     ${demoJob.title} (PUBLISHED, ${DEMO_APPLICANTS.length} applicants)`);

  const authorIds: Record<'recruiter' | 'hiringManager', string> = {
    recruiter: recruiterId,
    hiringManager: hmId,
  };

  for (const [index, applicant] of DEMO_APPLICANTS.entries()) {
    const candidateId = idFor('c1', index);
    const applicationId = idFor('a1', index);
    const appliedAt = daysAgo(applicant.appliedDaysAgo);
    const currentStage = applicant.path.at(-1)?.to ?? 'Applied';

    /*
     * Candidate and login account stay UNLINKED (`userId` left null). The
     * column is nullable by design for exactly this case — a profile created
     * from a public submission, before any account exists. Pointing all eight
     * at the one seeded candidate account is impossible anyway: `user_id` is
     * UNIQUE, so at most one candidate may claim it.
     */
    await prisma.candidate.upsert({
      where: { id: candidateId },
      update: {},
      create: {
        id: candidateId,
        fullName: applicant.fullName,
        email: applicant.email,
        phone: applicant.phone ?? null,
      },
    });

    await prisma.application.upsert({
      where: { id: applicationId },
      update: {},
      create: {
        id: applicationId,
        jobId: demoJob.id,
        candidateId,
        currentStage,
        appliedAt,
        // NULL on one applicant is deliberate: FR7.3 reports it as
        // `notRecorded`, never folded into `other` (D30), and the funnel's
        // source breakdown should demonstrate that distinction.
        source: applicant.source,
      },
    });

    /*
     * Stage history. The first stage has NO row — history is written on
     * transition and creation is not one, which is the assumption
     * `AnalyticsService` makes when it recovers the opening stage from the
     * first transition's `from_stage`. Getting this wrong would not error; it
     * would quietly skew every time-in-stage median on RC-12.
     */
    let fromStage = 'Applied';
    for (const [step, transition] of applicant.path.entries()) {
      await prisma.stageHistory.upsert({
        where: { id: idFor('5b', index, step) },
        update: {},
        create: {
          id: idFor('5b', index, step),
          applicationId,
          fromStage,
          toStage: transition.to,
          // BR-01 — a real human actor on every transition, including the
          // terminal ones. There is no system-actor path to this table.
          changedBy: recruiterId,
          changedAt: daysAgo(transition.daysAgo),
        },
      });
      fromStage = transition.to;
    }

    // FR5.3 — one scorecard per author per application, enforced by a unique
    // constraint, so the author pair is the upsert key.
    for (const scorecard of applicant.scorecards ?? []) {
      await prisma.scorecard.upsert({
        where: {
          applicationId_authorId: { applicationId, authorId: authorIds[scorecard.author] },
        },
        update: {},
        create: {
          applicationId,
          authorId: authorIds[scorecard.author],
          rating: scorecard.rating,
          feedback: scorecard.feedback,
        },
      });
    }

    for (const [step, comment] of (applicant.comments ?? []).entries()) {
      await prisma.comment.upsert({
        where: { id: idFor('cc', index, step) },
        update: {},
        create: {
          id: idFor('cc', index, step),
          applicationId,
          authorId: authorIds[comment.author],
          body: comment.body,
        },
      });
    }
  }

  const placements = new Map<string, number>();
  for (const applicant of DEMO_APPLICANTS) {
    const stage = applicant.path.at(-1)?.to ?? 'Applied';
    placements.set(stage, (placements.get(stage) ?? 0) + 1);
  }
  console.log(
    `  pipeline: ${DEFAULT_STAGES.map((s) => `${s.name} ${placements.get(s.name) ?? 0}`).join(', ')}`,
  );
  console.log(
    `  extras:  ${DEMO_APPLICANTS.reduce((n, a) => n + (a.scorecards?.length ?? 0), 0)} scorecards, ` +
      `${DEMO_APPLICANTS.reduce((n, a) => n + (a.comments?.length ?? 0), 0)} comments, ` +
      `no match_scores (no model is trained)`,
  );

  console.log(`\n  All seeded accounts use password: ${SEED_PASSWORD}`);
}

main()
  .then(async () => {
    console.log('\nSeed complete.');
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
