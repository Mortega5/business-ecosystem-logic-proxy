import { Logger } from '@nestjs/common';
import { sanitizeUrl } from '../logging/pino-options';
import { currentRequestId } from '../logging/request-id';

const logger = new Logger('OutboundFetch');

/**
 * `fetch` for the services the proxy calls that are not one of the configured upstreams (the payment gateway, the
 * compliance and file services, analytics): it passes on the id of the request being served and writes down how the call
 * went. The answer is given as it is, with its body unread, so a stream can still be passed on; a failure is thrown again.
 */
export const outboundFetch = async (target: string, url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const requestId = currentRequestId();
    const headers = new Headers(init.headers);
    if (requestId !== undefined && !headers.has('x-request-id')) {
        headers.set('x-request-id', requestId);
    }
    const logged = { target, method: init.method ?? 'GET', url: sanitizeUrl(url.toString()) };
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    try {
        const response = await fetch(url, { ...init, headers });
        const fields = { ...logged, statusCode: response.status, durationMs: elapsed() };
        if (response.status >= 500) {
            logger.warn(fields, 'outbound request completed');
        } else if (response.status >= 400) {
            logger.log(fields, 'outbound request completed');
        } else {
            logger.debug(fields, 'outbound request completed');
        }
        return response;
    } catch (error) {
        logger.error({ ...logged, durationMs: elapsed(), err: error }, 'outbound request failed');
        throw error;
    }
};
