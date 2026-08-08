import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';

/**
 * Replaces multer's terse upload errors with candidate-facing copy.
 *
 * `@nestjs/platform-express` intercepts MulterError itself and rethrows it as
 * an HttpException carrying multer's own message — so the STATUS is already
 * right by the time anything here runs, but the body reads "File too large",
 * which states the problem without the fix. Phase 1 §10.5 requires both, and
 * CA-02 lists "too large" as a recovery-bearing error state.
 *
 * Keyed on those messages because that is the only thing multer's original
 * error code survives as. Anything unrecognised passes through untouched.
 */
const REWRITES: Record<string, () => HttpException> = {
  'File too large': () => new PayloadTooLargeException('Your resume must be 10 MB or smaller'),
  'Unexpected field': () =>
    new BadRequestException('Send the resume in a single field named "resume"'),
  'Too many files': () => new BadRequestException('Attach one resume file, not several'),
};

@Catch()
export class UploadExceptionFilter extends ProblemDetailsFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(this.rewrite(exception), host);
  }

  private rewrite(exception: unknown): unknown {
    if (exception instanceof HttpException) {
      const rewrite = REWRITES[exception.message];
      if (rewrite) {
        return rewrite();
      }
    }

    return exception;
  }
}
