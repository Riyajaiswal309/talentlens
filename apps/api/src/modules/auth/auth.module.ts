import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenStore } from './refresh-token.store';
import { TokenService } from './token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * Authentication (PRD §24.1).
 *
 * Secrets are read per-operation in TokenService rather than registered
 * globally on JwtModule, because access and refresh tokens are signed with
 * DIFFERENT secrets — sharing one would let an access token be replayed as a
 * refresh token.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, RefreshTokenStore, JwtAuthGuard],
  exports: [AuthService, PasswordService, TokenService, JwtAuthGuard, RefreshTokenStore],
})
export class AuthModule {}
