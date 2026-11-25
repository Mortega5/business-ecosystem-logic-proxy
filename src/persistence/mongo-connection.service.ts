import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { PinoLogger } from 'nestjs-pino';
import { ConnectionStates, type Connection } from 'mongoose';
import { AppConfigService } from '../config/app-config.service';

/** Where the connection goes, with no credentials and no options: the address is for the log, and the rest is secret. */
export const mongoTarget = (uri: string): string => uri.split('?')[0]!.replace(/\/\/[^@/]*@/, '//');

@Injectable()
export class MongoConnectionService implements OnApplicationBootstrap, OnApplicationShutdown {
    private stopped = false;
    private cancelWait: (() => void) | undefined;

    constructor(
        @Inject(getConnectionToken()) private readonly connection: Connection,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(MongoConnectionService.name);
    }

    onApplicationBootstrap(): void {
        this.logConnectionEvents();
        void this.connectUntilUp();
    }

    async onApplicationShutdown(): Promise<void> {
        this.stopped = true;
        this.cancelWait?.();
        await this.connection.close();
    }

    isUp(): boolean {
        return this.connection.readyState === ConnectionStates.connected;
    }

    /** True when the server answers a ping in time, which notices an outage sooner than readyState. */
    async ping(timeoutMs: number): Promise<boolean> {
        if (!this.isUp() || this.connection.db === undefined) {
            return false;
        }
        const db = this.connection.db;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });
        try {
            return await Promise.race([db.admin().ping().then(() => true), timeout]);
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    private async connectUntilUp(): Promise<void> {
        const { uri, maxPoolSize, serverSelectionTimeoutMs, heartbeatFrequencyMs, retryInitialDelayMs, retryMaxDelayMs } =
            this.config.mongo;
        for (let attempt = 1; !this.stopped; attempt++) {
            this.logger.info({ attempt, target: mongoTarget(uri), timeoutMs: serverSelectionTimeoutMs }, 'Connecting to MongoDB');
            try {
                await this.connection.openUri(uri, {
                    autoIndex: false,
                    maxPoolSize,
                    serverSelectionTimeoutMS: serverSelectionTimeoutMs,
                    heartbeatFrequencyMS: heartbeatFrequencyMs
                });
                return;
            } catch (error) {
                const delayMs = Math.min(retryInitialDelayMs * 2 ** (attempt - 1), retryMaxDelayMs);
                this.logger.warn({ attempt, delayMs, err: error }, 'MongoDB is not reachable, retrying');
                await this.wait(delayMs);
            }
        }
    }

    private wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            this.cancelWait = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }

    private logConnectionEvents(): void {
        this.connection.on('connected', () => this.logger.info('MongoDB connection established'));
        this.connection.on('disconnected', () => this.logger.warn('MongoDB connection lost'));
        this.connection.on('reconnected', () => this.logger.info('MongoDB connection restored'));
        this.connection.on('error', (error: Error) => this.logger.error({ err: error }, 'MongoDB connection error'));
    }
}
