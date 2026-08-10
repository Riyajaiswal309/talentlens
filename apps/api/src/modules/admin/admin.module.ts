import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AiScoringController } from './ai-scoring.controller';
import { CandidateErasureController } from './candidate-erasure.controller';
import { CandidateErasureService } from './candidate-erasure.service';
import { AiScoringAdminService } from './ai-scoring.service';
import { AuthModule } from '../auth/auth.module';
import { CalendarModule } from '../calendar/calendar.module';

/**
 * PRD §15.3 `AdminModule` — FR8.1, FR8.2, FR8.4, and the BR-05 erasure
 * routine, which is an administrative action with no other home.
 *
 * AuthModule is imported for RefreshTokenStore: FR8.4 revocation must use the
 * same key layout that issuance uses, and sharing the store is the only way
 * to guarantee that.
 *
 * CalendarModule is imported because FR6.1 D45 extends FR8.4: revoking a
 * user's sessions must also drop their calendar connections. Declared as a
 * real import rather than relying on an ambient @Global() — the dependency is
 * genuine and specific to this module, and stating it keeps every test
 * harness that mounts AdminModule working without extra wiring.
 */
@Module({
  imports: [AuthModule, CalendarModule],
  controllers: [AdminUsersController, AiScoringController, CandidateErasureController],
  providers: [AdminUsersService, AiScoringAdminService, CandidateErasureService],
})
export class AdminModule {}
