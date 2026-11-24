import { describe, expect, it } from 'vitest';
import { Api, ServerError } from '../src/data/api';
import { errorReport, failed } from '../src/data/error-report';

const place = { version: 'abc1234', userAgent: 'Mozilla/5.0 (iPhone)', screen: '/feed' };

// The report is what the user pastes to get help with “Can’t reach the server” or “Couldn’t update the feed.”: it must hold what the sentence hides.
describe('an error’s report', () => {
  it('tells when, where and what failed, down to the browser’s own error', async () => {
    const api = new Api(async () => Promise.reject(new TypeError('Load failed')));
    const failure = await api.stream(987654, 56).catch((error: unknown) => error);

    const report = errorReport(failed(failure, Date.UTC(2026, 10, 24, 9, 30)), place);

    expect(report).toContain('Time: 2026-11-24T09:30:00.000Z');
    expect(report).toContain('App: abc1234');
    expect(report).toContain('Request: GET /api/stream');
    expect(report).toContain('Status: no answer');
    expect(report).toMatch(/^ServerError: Can’t reach the server\. Check your connection and try again\.\n {2}\S/m);
    expect(report).toMatch(/^Caused by:\nTypeError: Load failed$/m);
    expect(report).not.toContain('987654');
  });

  it('shows an unexpected error’s own message, which the app replaces with a general sentence', () => {
    const report = errorReport(failed(new RangeError('Offset is outside the bounds of the DataView')), place);

    expect(report).toMatch(/^RangeError: Offset is outside the bounds of the DataView\n {2}\S/m);
    expect(report).not.toContain('Request:');
  });
});
