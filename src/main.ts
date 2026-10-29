import 'reflect-metadata';
import { createApp } from './bootstrap';
import { AppConfigService } from './config/app-config.service';
import type { LegacyHandler } from './legacy/legacy-fallback.filter';

interface LegacyServer {
    app: LegacyHandler;
    onlistening: () => void;
}

const bootstrap = async (): Promise<void> => {
    const legacy = (await require('../server.js')) as LegacyServer;
    const app = await createApp(legacy.app);
    const { host, port } = app.get(AppConfigService).app;

    await (host === undefined ? app.listen(port) : app.listen(port, host));
    legacy.onlistening();
};

bootstrap().catch((error: unknown) => {
    process.stderr.write(`The server could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
});
