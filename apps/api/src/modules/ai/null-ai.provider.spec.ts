import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuditActorType } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AiModule } from './ai.module';
import { AI_AUDIT_ACTIONS } from './ai-audit-actions';
import { AiScoringPort, type ScoreResult } from './ai-scoring.port';
import { NullAiProvider } from './null-ai.provider';
import { AuditService } from '../../common/audit/audit.service';
import { CommonModule } from '../../common/common.module';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * M2.9 Step 1 — the AI seam (Handoff §G, module table row 10).
 *
 * Two things are worth testing about a null implementation: that it really
 * is null, and that the SEAM around it holds — the port is the only thing
 * consumers can reach, and the not-scored branch is unavoidable.
 */
describe('AI seam (Handoff §G)', () => {
  describe('NullAiProvider', () => {
    let provider: NullAiProvider;

    beforeEach(() => {
      provider = new NullAiProvider();
    });

    it('getScore always returns NotScored', async () => {
      await expect(provider.getScore(randomUUID())).resolves.toEqual({ scored: false });
    });

    it('returns NotScored for every application, not just unknown ones', async () => {
      const results = await Promise.all([
        provider.getScore(randomUUID()),
        provider.getScore(randomUUID()),
        provider.getScore(randomUUID()),
      ]);

      expect(results.every((r) => r.scored === false)).toBe(true);
    });

    it('never reports a score', async () => {
      const result = await provider.getScore(randomUUID());

      // Nothing on the scored branch may be reachable.
      expect(result).not.toHaveProperty('composite');
      expect(result).not.toHaveProperty('rationale');
      expect(result).not.toHaveProperty('modelVersion');
    });

    it('requestParse resolves and does nothing', async () => {
      await expect(provider.requestParse(randomUUID())).resolves.toBeUndefined();
    });

    /**
     * PRD §15.1 — "a degraded or absent AI service must not degrade the
     * recruiter workflow". The absent case is Phase 2's normal state, so
     * neither method may throw.
     */
    it('§15.1: neither method throws when there is no AI service', async () => {
      await expect(provider.getScore('not-even-a-uuid')).resolves.toBeDefined();
      await expect(provider.requestParse('')).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // The seam
  // =========================================================================
  describe('AiModule wiring', () => {
    it('resolves AiScoringPort to the null provider', async () => {
      const moduleRef = await Test.createTestingModule({
        // CommonModule is @Global in the running app; an isolated test
        // module must import it for AiModule's own providers.
        imports: [
          ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
          CommonModule,
          AiModule,
        ],
      }).compile();

      const port = moduleRef.get(AiScoringPort);

      expect(port).toBeInstanceOf(NullAiProvider);
      await expect(port.getScore(randomUUID())).resolves.toEqual({ scored: false });
      await moduleRef.close();
    });

    /**
     * The module exports the PORT only. If the concrete class were exported,
     * a consumer could inject it directly and Phase 3's swap would stop being
     * a one-line change.
     */
    it('does not export the concrete provider', async () => {
      const moduleRef = await Test.createTestingModule({
        // CommonModule is @Global in the running app; an isolated test
        // module must import it for AiModule's own providers.
        imports: [
          ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
          CommonModule,
          AiModule,
        ],
      }).compile();

      // Resolvable inside the module's own injector, but not exported.
      expect(() => moduleRef.get(NullAiProvider, { strict: true })).toThrow();
      await moduleRef.close();
    });
  });

  /**
   * BR-02 — "a score without an explanation may not be surfaced." The
   * database enforces it with NOT NULL; the port enforces it with a required
   * field, so a consumer cannot construct a renderable score without one.
   */
  describe('BR-02 at the type level', () => {
    it('a scored result cannot omit its rationale', () => {
      const scored: ScoreResult = {
        scored: true,
        composite: 0.87,
        modelVersion: 'ranker-v2.3.1',
        overridden: false,
        rationale: {
          summary: 'Strong match on required skills.',
          factors: [{ feature: 'skill_overlap', contribution: 0.31, direction: 'positive' }],
        },
      };

      // @ts-expect-error — BR-02: the scored branch requires a rationale.
      const withoutRationale: ScoreResult = {
        scored: true,
        composite: 0.87,
        modelVersion: 'ranker-v2.3.1',
        overridden: false,
      };

      expect(scored.scored).toBe(true);
      expect(withoutRationale).toBeDefined();
    });

    it('the union forces the not-scored branch to be handled', async () => {
      const result = await new NullAiProvider().getScore(randomUUID());

      // Reaching `composite` without narrowing is a compile error, which is
      // the guarantee Handoff §G asks for.
      const rendered = result.scored ? result.composite : null;

      expect(rendered).toBeNull();
    });
  });

  // =========================================================================
  // score.generated — "hook wired, never fires in P2" (Handoff §I)
  // =========================================================================
  describe('score.generated hook', () => {
    const OWNER_URL =
      process.env.DATABASE_URL ??
      'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';
    const APP_URL =
      process.env.APP_DATABASE_URL ??
      'postgresql://talentlens_app:talentlens_app_dev@localhost:5432/talentlens?schema=public';

    const correlationId = `corr-${randomUUID()}`;

    it('the action name is defined once', () => {
      expect(AI_AUDIT_ACTIONS.SCORE_GENERATED).toBe('score.generated');
      expect(AI_AUDIT_ACTIONS.SCORE_OVERRIDDEN).toBe('score.overridden');
    });

    /** The write path exists — Phase 3 adds a caller, not a mechanism. */
    it('AuditService can persist a score.generated record', async () => {
      const prisma = new PrismaService({
        get: (key: string) => (key === 'APP_DATABASE_URL' ? APP_URL : undefined),
      } as unknown as ConfigService);
      await prisma.$connect();

      const owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
      await owner.$connect();

      try {
        const actor = await prisma.users.findFirst();
        if (!actor) throw new Error('No seeded users found. Run `pnpm prisma:seed` first.');

        const resourceId = randomUUID();
        await new AuditService(prisma).record({
          companyId: actor.companyId,
          actorId: actor.id,
          actorType: AuditActorType.USER,
          action: AI_AUDIT_ACTIONS.SCORE_GENERATED,
          resourceType: 'match_score',
          resourceId,
          correlationId,
        });

        const row = await prisma.auditLog.findFirst({ where: { resourceId } });
        expect(row?.action).toBe('score.generated');
      } finally {
        await owner.auditLog.deleteMany({ where: { correlationId } });
        await owner.$disconnect();
        await prisma.$disconnect();
      }
    });

    /**
     * Decision 6: the hook is defined but NOT invoked in Phase 2. Asserted
     * against the source tree, because "nobody calls it" is exactly the kind
     * of property that decays silently.
     *
     * Two files NAME the action legitimately without emitting it: the
     * constant's own definition, and the audit browser's filter vocabulary,
     * which has to list every action a query may filter on. Emission means
     * passing it to an audit write — `action:` or an @Audit() decorator —
     * which is what the patterns below look for.
     */
    it('no production code emits score.generated', () => {
      const offenders: string[] = [];

      function walk(dir: string): void {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) {
            walk(path);
            continue;
          }
          if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
          // The constant's own definition is where the name is allowed to live.
          if (path.endsWith(join('ai', 'ai-audit-actions.ts'))) continue;
          // The audit browser lists every filterable action by name.
          if (path.endsWith(join('audit', 'audit-actions.ts'))) continue;

          const source = readFileSync(path, 'utf8');
          const emits =
            /action:\s*(['"]score\.generated['"]|AI_AUDIT_ACTIONS\.SCORE_GENERATED)/.test(source) ||
            /@Audit\([^)]*SCORE_GENERATED/.test(source);
          if (emits) offenders.push(path);
        }
      }

      walk(join(__dirname, '..', '..'));

      expect(offenders).toEqual([]);
    });
  });
});
