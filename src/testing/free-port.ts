import { createServer } from 'node:net';

export const freePort = (): Promise<number> =>
    new Promise((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });
