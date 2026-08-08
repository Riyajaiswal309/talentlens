import type { Response } from 'express';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { CORRELATION_ID_HEADER } from '../interceptors/correlation-id.interceptor';
import type { RequestContext } from '../types/authenticated-request';

function makeReqRes(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as RequestContext;
  const res = { setHeader: jest.fn() } as unknown as Response;
  const next = jest.fn();
  return { req, res, next };
}

/**
 * Covers the gap that interceptors alone cannot: NestJS does not run
 * interceptors for unmatched routes, so without this middleware a 404 would
 * carry no correlation id and NFR11 ("every request traceable") would fail.
 */
describe('CorrelationIdMiddleware (NFR11)', () => {
  const middleware = new CorrelationIdMiddleware();

  it('assigns an id before routing so 404s are traceable', () => {
    const { req, res, next } = makeReqRes();

    middleware.use(req, res, next);

    expect(req.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, req.correlationId);
    expect(next).toHaveBeenCalled();
  });

  it('preserves an inbound id', () => {
    const { req, res, next } = makeReqRes({ [CORRELATION_ID_HEADER]: 'upstream-1' });

    middleware.use(req, res, next);

    expect(req.correlationId).toBe('upstream-1');
    expect(next).toHaveBeenCalled();
  });

  it('always calls next so the request is never stalled', () => {
    const { req, res, next } = makeReqRes({ [CORRELATION_ID_HEADER]: '  ' });
    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
