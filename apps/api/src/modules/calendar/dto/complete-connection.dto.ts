import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The provider's redirect, forwarded by the frontend (FR6.1, D40).
 *
 * THERE IS NO TOKEN FIELD, DELIBERATELY. The only credential-shaped value a
 * caller may send is a one-time authorization code, which is worthless without
 * the server's client secret. Accepting a refresh token here would let anyone
 * bind a credential of their choosing to their own account.
 */
export class CompleteConnectionDto {
  /**
   * The CSRF nonce issued by `/authorize`. Required even on the denial path,
   * because a denial must also prove it belongs to a real request this server
   * started.
   */
  @IsString()
  @MinLength(1, { message: 'state is required' })
  @MaxLength(512)
  state!: string;

  /** Present when the user consented. Absent when `error` is set. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  code?: string;

  /**
   * The provider's refusal, e.g. `access_denied`, passed through unchanged.
   *
   * Bounded and echoed only inside a 400 message, never stored or logged as
   * anything but text.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  error?: string;
}
