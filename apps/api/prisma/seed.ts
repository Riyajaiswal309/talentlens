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
 * Scope is exactly what the M2.2 brief and the Phase 2 Handoff require:
 *   - 1 company
 *   - 4 users, one per PRD §24.2 role
 *   - 1 ai_model_versions row: placeholder-v0
 *   - the 6 default pipeline stages from PRD §14.1
 *
 * Two rows exist only because the four above cannot be created without them:
 *   - 1 job, because pipeline_stages.job_id is NOT NULL (stages belong to a
 *     job, per decision B2 — they are per-job data, not global constants).
 *   - 1 job_assignment, because decision B1's unique (job_id, user_id) pair
 *     needs both to exist for the constraint to be demonstrable.
 *
 * No candidates, applications, resumes, match_scores or audit_logs are seeded.
 * Those are written by application features that do not exist yet.
 *
 * Idempotent: safe to re-run.
 */
import { PrismaClient, UserRole, JobStatus } from '@prisma/client';
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
  for (const stage of DEFAULT_STAGES) {
    await prisma.pipelineStage.upsert({
      where: { jobId_name: { jobId: job.id, name: stage.name } },
      update: { position: stage.position, isTerminal: stage.isTerminal },
      create: { jobId: job.id, ...stage },
    });
  }
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
