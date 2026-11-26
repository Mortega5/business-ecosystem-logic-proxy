import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from './metrics.service';

/**
 * Serves the metrics on a port of their own, which is not published anywhere. It closes last, after the main server drained, so
 * the final values can still be scraped. If it cannot listen it says so and the service goes on without metrics.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
    private server: Server | undefined;

    constructor(
        private readonly config: AppConfigService,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(MetricsServer.name);
    }

    async onApplicationBootstrap(): Promise<void> {
        const { enabled, host, port, path } = this.config.metrics;
        if (!enabled) {
            return;
        }
        const server = createServer((req, res) => {
            void this.answer(req.method, req.url, path, res);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen({ port, ...(host === undefined ? {} : { host }) }, resolve);
            });
        } catch (error) {
            this.logger.error({ err: error, port }, 'The metrics server could not listen, there will be no metrics');
            return;
        }
        server.on('error', (error) => this.logger.error({ err: error }, 'The metrics server failed'));
        this.server = server;
        this.logger.info({ port, path }, 'Metrics listening');
    }

    async onApplicationShutdown(): Promise<void> {
        const server = this.server;
        if (server === undefined) {
            return;
        }
        this.server = undefined;
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }

    private async answer(
        method: string | undefined,
        url: string | undefined,
        path: string,
        res: ServerResponse
    ): Promise<void> {
        if ((url ?? '').split('?')[0] !== path) {
            res.writeHead(404).end();
            return;
        }
        if (method !== 'GET' && method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' }).end();
            return;
        }
        try {
            const body = await this.metrics.render();
            res.writeHead(200, { 'content-type': this.metrics.contentType() }).end(method === 'HEAD' ? undefined : body);
        } catch (error) {
            this.logger.error({ err: error }, 'The metrics could not be rendered');
            res.writeHead(500).end();
        }
    }
}
