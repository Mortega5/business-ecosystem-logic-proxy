import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from './domain-error';

const UNEXPECTED = 'Unexpected error. The error has been notified to the administrators.';

/** Answers every error with the `{ error: message }` body the frontend already understands. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger(ErrorFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const res = host.switchToHttp().getResponse<Response>();
        if (res.headersSent) {
            res.end();
            return;
        }

        if (exception instanceof DomainError) {
            res.status(exception.status).json({ error: exception.message });
            return;
        }

        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            if (status < 500) {
                res.status(status).json({ error: exception.message });
                return;
            }
            // Thrown on purpose with its own body, such as the answer of a failing health check
            const body = exception.getResponse();
            res.status(status).json(typeof body === 'string' ? { error: body } : body);
            return;
        }

        this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
        res.status(500).json({ error: UNEXPECTED });
    }
}
