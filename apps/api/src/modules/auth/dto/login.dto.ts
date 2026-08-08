import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { MIN_PASSWORD_LENGTH } from '../password.service';

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email!: string;

  /**
   * PRD §24.1 sets a 12-character minimum. Enforced here so the rule is
   * visible in the OpenAPI spec, but the message deliberately does not say
   * whether the SUBMITTED value was too short for an existing account —
   * AuthService returns one generic failure regardless.
   *
   * Upper bound guards against a long-string DoS on the Argon2id hash.
   */
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  @MaxLength(256)
  password!: string;
}
