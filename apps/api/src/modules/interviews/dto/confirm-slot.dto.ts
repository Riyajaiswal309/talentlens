import { IsUUID } from 'class-validator';

/**
 * POST /v1/scheduling/:token/confirm (Handoff Gap 7).
 *
 * The Gap specifies the body as `{ "slotId": "uuid" }` and gives `400` for a
 * malformed `slotId` — which is what the UUID check produces here. Whether the
 * slot is one this token actually offered is a different question with a
 * different answer (Gap 7 rule 2), and the service settles it against the
 * database.
 */
export class ConfirmSlotDto {
  @IsUUID('4', { message: 'slotId must be a valid slot id' })
  slotId!: string;
}
