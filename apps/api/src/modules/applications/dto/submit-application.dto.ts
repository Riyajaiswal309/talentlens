import { ApplicationSource } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** The four approved FR7.3 values, for the 400 message. */
const SOURCE_VALUES = Object.values(ApplicationSource).join(', ');

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

  /**
   * FR7.3 — how the candidate reached this role (Phase 1 CA-02, amended).
   *
   * OPTIONAL, because FR2.1 intake must not be made harder to complete: an
   * omitted value stores NULL and is reported as `notRecorded`, never as
   * `other`. A value outside the closed four is a 400 rather than stored
   * text, which is what makes the analytics dimension countable — the same
   * allow-list enforcement BR-07 uses for model features.
   */
  @IsOptional()
  @IsEnum(ApplicationSource, { message: `source must be one of: ${SOURCE_VALUES}` })
  source?: ApplicationSource;
}
