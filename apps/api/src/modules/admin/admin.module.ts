import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AiScoringController } from './ai-scoring.controller';
import { AiScoringAdminService } from './ai-scoring.service';
import { AuthModule } from '../auth/auth.module';

/**
 * PRD §15.3 `AdminModule` — FR8.1, FR8.2, FR8.4.
 *
 * AuthModule is imported for RefreshTokenStore: FR8.4 revocation must use the
 * same key layout that issuance uses, and sharing the store is the only way
 * to guarantee that.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AiScoringController],
  providers: [AdminUsersService, AiScoringAdminService],
})
export class AdminModule {}
