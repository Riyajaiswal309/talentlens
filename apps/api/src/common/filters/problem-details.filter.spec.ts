import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ProblemDetailsFilter, type ProblemDetails } from './problem-details.filter';
import type { RequestContext } from '../types/authenticated-request';

function makeHost(url = '/v1/jobs', correlationId = 'corr-abc') {
  const json = jest.fn();
  const setHeader = jest.fn().mockReturnValue({ json });
  const type = jest.fn().mockReturnValue({ setHeader });
  const status = jest.fn().mockReturnValue({ type });
  const response = { status, type, setHeader, json };

  const request = { url, method: 'POST', correlationId } as unknown as RequestContext;

  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  return { host, status, type, json };
}

function bodyOf(json: jest.Mock): ProblemDetails {
  return json.mock.calls[0]?.[0] as ProblemDetails;
}

describe('ProblemDetailsFilter (RFC 7807, PRD §23.1)', () => {
  const filter = new ProblemDetailsFilter();

  it('emits all five required RFC 7807 members', () => {
    const { host, json } = makeHost();
    filter.catch(new NotFoundException('Job not found'), host);

    const body = bodyOf(json);
    expect(body).toEqual(
      expect.objectContaining({
        type: 'about:blank',
        title: 'Not Found',
        status: HttpStatus.NOT_FOUND,
        detail: 'Job not found',
        instance: '/v1/jobs',
      }),
    );
  });

  it('sets the application/problem+json content type', () => {
    const { host, type } = makeHost();
    filter.catch(new ForbiddenException('Insufficient permissions'), host);
    expect(type).toHaveBeenCalledWith('application/problem+json');
  });

  it('carries the correlation id so a failure can be traced (NFR11)', () => {
    const { host, json } = makeHost('/v1/jobs', 'corr-xyz');
    filter.catch(new ForbiddenException(), host);
    expect(bodyOf(json).correlationId).toBe('corr-xyz');
  });

  it('joins ValidationPipe messages instead of dropping them', () => {
    const { host, json } = makeHost();
    filter.catch(
      new BadRequestException({
        message: ['title must be a string', 'department should not be empty'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      host,
    );

    const body = bodyOf(json);
    expect(body.detail).toContain('title must be a string');
    expect(body.detail).toContain('department should not be empty');
  });

  it('returns 500 without leaking internals for an unexpected error', () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error('connection string password=hunter2'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = bodyOf(json);
    expect(body.detail).not.toContain('hunter2');
    expect(body.detail).toContain('correlation ID');
  });
});
