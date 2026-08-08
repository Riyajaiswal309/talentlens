import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * FR2.1 — public candidate application.
 *
 * Resume upload is NOT part of this DTO yet; it arrives in the next M2.7 step.
 * FR2.5 requires submission to succeed independently of parsing, so the
 * application record is meaningful on its own.
 */
export class SubmitApplicationDto {
  @IsUUID('4', { message: 'jobId must be a valid job identifier' })
  jobId!: string;

  @IsString()
  @MinLength(1, { message: 'Full name is required' })
  @MaxLength(200)
  fullName!: string;

  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}
