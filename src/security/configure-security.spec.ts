import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { loadStaticConfig } from '../config/config.loader';
import { LoggingModule } from '../logging/logging.module';
import { configureSecurity } from './configure-security';

@Controller('probe')
class ProbeController {
    @Get()
    read() {
        return { ok: true };
    }

    @Post()
    write() {
        return { ok: true };
    }
}

@Module({ imports: [AppConfigModule, LoggingModule], controllers: [ProbeController] })
class Root {}

const DEFAULTS = join(__dirname, '../../config/default.yaml');
const apps: NestExpressApplication[] = [];

const serve = async (env: NodeJS.ProcessEnv = {}): Promise<string> => {
    const app = await createApp(Root);
    configureSecurity(app, loadStaticConfig({ defaultsPath: DEFAULTS, env }));
    await app.listen(0);
    apps.push(app);
    return app.getUrl();
};

afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('security headers', () => {
    it('are on the answers of Nest, of a 404 and of a refusal', async () => {
        const url = await serve();
        const answers = await Promise.all([
            fetch(`${url}/probe`),
            fetch(`${url}/nothing/here`),
            fetch(`${url}/probe`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
        ]);
        expect(answers.map((res) => res.status)).toEqual([200, 404, 403]);
        for (const res of answers) {
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
            expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
            expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
            expect(res.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
            expect(res.headers.get('x-powered-by')).toBeNull();
        }
        // The 404 page brings its own, stricter policy; the others only report
        expect(answers.map((res) => res.headers.get('content-security-policy'))).toEqual([null, "default-src 'none'", null]);
    });

    it('follow the configuration', async () => {
        const url = await serve({
            BAE_SECURITY__CSP__REPORT_ONLY: 'false',
            BAE_SECURITY__HSTS__INCLUDE_SUB_DOMAINS: 'true',
            BAE_SECURITY__HSTS__MAX_AGE_SECONDS: '600',
            BAE_SECURITY__CROSS_ORIGIN_RESOURCE_POLICY: 'cross-origin'
        });
        const res = await fetch(`${url}/probe`);
        expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(res.headers.get('content-security-policy-report-only')).toBeNull();
        expect(res.headers.get('strict-transport-security')).toBe('max-age=600; includeSubDomains');
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    });

    it('can leave out HSTS', async () => {
        const url = await serve({ BAE_SECURITY__HSTS__ENABLED: 'false' });
        expect((await fetch(`${url}/probe`)).headers.get('strict-transport-security')).toBeNull();
    });
});

describe('CSRF protection', () => {
    const post = (url: string, headers: Record<string, string>) => fetch(`${url}/probe`, { method: 'POST', headers });

    it('refuses a state-changing request a browser says comes from another site', async () => {
        const url = await serve();
        const res = await post(url, { 'sec-fetch-site': 'cross-site' });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: expect.any(String) as string });
    });

    it('lets in the same origin, a read and a client that is not a browser', async () => {
        const url = await serve();
        expect((await post(url, { 'sec-fetch-site': 'same-origin' })).status).toBe(201);
        expect((await post(url, {})).status).toBe(201);
        expect((await fetch(`${url}/probe`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
    });

    it('refuses a foreign Origin when the browser sends no fetch metadata', async () => {
        const url = await serve();
        expect((await post(url, { origin: 'https://evil.example' })).status).toBe(403);
    });

    it('lets in the origins it is told to trust, for tests', async () => {
        const url = await serve({ BAE_SECURITY__CSRF__TRUSTED_ORIGINS: '["http://localhost:4200"]' });
        expect((await post(url, { 'sec-fetch-site': 'same-site', origin: 'http://localhost:4200' })).status).toBe(201);
        expect((await post(url, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).status).toBe(403);
    });

    it('can be turned off', async () => {
        const url = await serve({ BAE_SECURITY__CSRF__ENABLED: 'false' });
        expect((await post(url, { 'sec-fetch-site': 'cross-site' })).status).toBe(201);
    });
});

describe('CORS', () => {
    const preflight = (url: string, origin: string) =>
        fetch(`${url}/probe`, {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,x-organization' }
        });

    it('lets every origin in until it is configured', async () => {
        const url = await serve();
        const res = await preflight(url, 'https://anyone.example');
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
        expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-organization');
        const answer = await fetch(`${url}/probe`, { headers: { origin: 'https://anyone.example' } });
        expect(answer.headers.get('access-control-expose-headers')).toContain('X-Total-Count');
        expect(answer.headers.get('access-control-expose-headers')).not.toContain('X-Redirect-URL');
    });

    it('lets in only the origins it is given', async () => {
        const url = await serve({ BAE_HTTP__CORS__ORIGINS: '["https://portal.example.org"]' });
        expect((await preflight(url, 'https://portal.example.org')).headers.get('access-control-allow-origin')).toBe(
            'https://portal.example.org'
        );
        expect((await preflight(url, 'https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
    });

    it('can expose the redirect header', async () => {
        const url = await serve({ BAE_LP_CORS_EXPOSE_REDIRECT: 'true' });
        const answer = await fetch(`${url}/probe`, { headers: { origin: 'https://anyone.example' } });
        expect(answer.headers.get('access-control-expose-headers')).toContain('X-Redirect-URL');
    });
});

describe('the configuration of it', () => {
    it('refuses an origin that is not an origin', () => {
        const load = (env: NodeJS.ProcessEnv) => () => loadStaticConfig({ defaultsPath: DEFAULTS, env });
        expect(load({ BAE_HTTP__CORS__ORIGINS: '["portal.example.org"]' })).toThrow('http.cors.origins');
        expect(load({ BAE_SECURITY__CSRF__TRUSTED_ORIGINS: '["http://localhost:4200/path"]' })).toThrow('security.csrf.trustedOrigins');
        expect(load({ BAE_SECURITY__CSRF__TRUSTED_ORIGINS: '["*"]' })).toThrow('security.csrf.trustedOrigins');
    });
});
