import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { CORRELATION_ID_HEADER, CorrelationIdInterceptor } from './correlation-id.interceptor';
import type { RequestContext } from '../types/authenticated-request';

function makeContext(headers: Record<string, string> = {}) {
  const request = { headers } as unknown as RequestContext;
  const response = { setHeader: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of('ok') };
  return { request, response, context, next };
}

describe('CorrelationIdInterceptor (NFR11)', () => {
  const interceptor = new CorrelationIdInterceptor();

  it('generates a correlation id when none is supplied', (done) => {
    const { request, response, context, next } = makeContext();

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(response.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, request.correlationId);
      done();
    });
  });

  it('propagates an inbound correlation id so a trace stays joined', (done) => {
    const { request, response, context, next } = makeContext({
      [CORRELATION_ID_HEADER]: 'upstream-trace-123',
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.correlationId).toBe('upstream-trace-123');
      expect(response.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'upstream-trace-123');
      done();
    });
  });

  it('ignores a blank inbound header and generates one instead', (done) => {
    const { request, context, next } = makeContext({ [CORRELATION_ID_HEADER]: '   ' });

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.correlationId).toBeDefined();
      expect(request.correlationId?.trim()).not.toBe('');
      done();
    });
  });
});
