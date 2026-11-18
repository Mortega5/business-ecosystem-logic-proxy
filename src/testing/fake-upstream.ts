import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';

export interface SeenRequest {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingHttpHeaders;
    body: string;
    bytes: Buffer;
}

/** A server standing for an upstream: it answers what the test says and records what it was asked. */
export class FakeUpstream {
    seen: SeenRequest | undefined;
    port = 0;
    private server: Server | undefined;
    private answerWith: (res: ServerResponse) => void = (res) => this.json(res, 200, '{}');

    answer(handler: (res: ServerResponse) => void): void {
        this.answerWith = handler;
    }

    json(res: ServerResponse, status: number, body: string): void {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
    }

    reset(): void {
        this.seen = undefined;
        this.answerWith = (res) => this.json(res, 200, '{}');
    }

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const bytes = Buffer.concat(chunks);
                this.seen = { method: req.method, url: req.url, headers: req.headers, body: bytes.toString(), bytes };
                this.answerWith(res);
            });
        });
        await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as { port: number }).port;
    }

    async stop(): Promise<void> {
        this.server?.closeAllConnections();
        await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
    }
}
