import { ApplicationSource } from '@prisma/client';
import { IsEnum } from 'class-validator';

const SOURCE_VALUES = Object.values(ApplicationSource).join(', ');

/**
 * PATCH /v1/applications/:id/source (FR7.3, amendment B7).
 *
 * REQUIRED here, unlike on submission. A recruiter correcting attribution is
 * asserting a channel; omitting the field would be a request to do nothing,
 * and clearing a source back to "not recorded" is a different operation that
 * no document asks for and this endpoint does not offer.
 */
export class UpdateApplicationSourceDto {
  @IsEnum(ApplicationSource, { message: `source must be one of: ${SOURCE_VALUES}` })
  source!: ApplicationSource;
}
