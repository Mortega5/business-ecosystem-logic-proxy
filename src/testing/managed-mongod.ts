import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoBinary } from 'mongodb-memory-server';

export const MONGOD_VERSION = '7.0.14';

const freePort = (): Promise<number> =>
    new Promise((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });

const accepts = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });

/** A real mongod that can be stopped and started again on the same port and data directory. */
export class ManagedMongod {
    private process: ChildProcess | undefined;

    private constructor(
        readonly port: number,
        private readonly binary: string,
        private readonly dbPath: string
    ) {}

    static async create(): Promise<ManagedMongod> {
        const binary = await MongoBinary.getPath({ version: MONGOD_VERSION });
        return new ManagedMongod(await freePort(), binary, mkdtempSync(join(tmpdir(), 'bae-mongod-')));
    }

    get uri(): string {
        return `mongodb://127.0.0.1:${this.port}`;
    }

    async start(): Promise<void> {
        this.process = spawn(
            this.binary,
            ['--port', String(this.port), '--dbpath', this.dbPath, '--bind_ip', '127.0.0.1'],
            { stdio: 'ignore' }
        );
        for (let attempt = 0; attempt < 200 && !(await accepts(this.port)); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    async stop(): Promise<void> {
        const running = this.process;
        if (running === undefined || running.exitCode !== null) {
            return;
        }
        await new Promise<void>((resolve) => {
            running.once('exit', () => resolve());
            running.kill('SIGTERM');
        });
    }

    async destroy(): Promise<void> {
        await this.stop();
        rmSync(this.dbPath, { recursive: true, force: true });
    }
}
