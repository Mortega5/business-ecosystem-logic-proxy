import { join } from 'node:path';
import { Global, Module, RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Test, type TestingModule } from '@nestjs/testing';
import Ajv from 'ajv';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigService } from '../config/app-config.service';
import { AppModule } from '../app.module';
import { HealthModule } from '../health/health.module';
import { LegacyAuthBridge } from '../legacy/legacy-auth.bridge';
import { MongoConnectionService } from '../persistence/mongo-connection.service';
import { DocumentModule } from '../tmf/document/document.module';
import { RevenueModule } from '../tmf/revenue/revenue.module';
import { SearchModule } from '../tmf/search/search.module';
import { fakeLogin, LOGGED_IN } from '../testing/fake-login';
import { FakeUpstream } from '../testing/fake-upstream';

interface ResponseObject {
    headers?: Record<string, unknown>;
    content?: Record<string, { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> }>;
}

interface Operation {
    parameters?: { name: string; in: string }[];
    responses: Record<string, ResponseObject>;
}

type Document = { paths: Record<string, Record<string, Operation>> };

const DOCUMENT_PATH = join(__dirname, '../../docs/openapi.yaml');

const tmforum = new FakeUpstream();

const mongo = { ping: vi.fn<(timeoutMs: number) => Promise<boolean>>() };

@Global()
@Module({
    providers: [
        {
            provide: AppConfigService,
            useValue: {
                app: { shutdownDelayMs: 0 },
                health: { mongoPingTimeoutMs: 500 },
                http: { bodyLimit: '1kb' },
                auth: { propagateToken: true, allowLocalEori: false, roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' } },
                upstream: (name: string) => ({ baseUrl: `http://127.0.0.1:${tmforum.port}/${name}`, timeoutMs: 300 })
            }
        },
        { provide: MongoConnectionService, useValue: mongo }
    ],
    exports: [AppConfigService, MongoConnectionService]
})
class DependenciesStub {}

const trimSlashes = (path: string): string => path.replace(/^\/+|\/+$/g, '');

const routesOf = (module: TestingModule): string[] => {
    const routes: string[] = [];
    for (const { controllers } of module.get(ModulesContainer, { strict: false }).values()) {
        for (const wrapper of controllers.values()) {
            const type = wrapper.metatype as (new () => object) | null;
            if (type === null) {
                continue;
            }
            const base = Reflect.getMetadata(PATH_METADATA, type) as string;
            for (const name of Object.getOwnPropertyNames(type.prototype)) {
                const handler = (type.prototype as Record<string, unknown>)[name];
                const method = typeof handler === 'function' ? (Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined) : undefined;
                if (typeof handler === 'function' && method !== undefined) {
                    // An `all` route only closes a prefix with a 404: it is not part of the API
                    if (method === RequestMethod.ALL) {
                        continue;
                    }
                    for (const path of [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat()) {
                        const full = `/${[base, path].map(trimSlashes).filter(Boolean).join('/')}`;
                        routes.push(`${RequestMethod[method]?.toLowerCase()} ${full.replace(/:([A-Za-z]+)/g, '{$1}')}`);
                    }
                }
            }
        }
    }
    return routes.sort();
};

let document: Document;

beforeAll(async () => {
    document = (await SwaggerParser.validate(DOCUMENT_PATH)) as unknown as Document;
});

describe('docs/openapi.yaml', () => {
    it('is a valid OpenAPI document', () => {
        expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    });

    it('has examples that match their schemas', () => {
        const ajv = new Ajv({ strict: false, allErrors: true });
        let checked = 0;
        for (const operations of Object.values(document.paths)) {
            for (const operation of Object.values(operations)) {
                for (const response of Object.values(operation.responses)) {
                    for (const media of Object.values(response.content ?? {})) {
                        const examples = [media.example, ...Object.values(media.examples ?? {}).map((e) => e.value)].filter(
                            (e) => e !== undefined
                        );
                        const validate = ajv.compile(media.schema);
                        for (const example of examples) {
                            expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
                            checked++;
                        }
                    }
                }
            }
        }
        expect(checked).toBeGreaterThanOrEqual(4);
    });

    it('describes every route the Nest application implements, and only those', async () => {
        const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const documented = Object.entries(document.paths)
            .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`))
            .sort();

        expect(routesOf(module)).toEqual(documented);

        await module.close();
    });
});

describe('responses against docs/openapi.yaml', () => {
    let app: INestApplication;
    let url: string;
    const ajv = new Ajv({ strict: false, allErrors: true });

    interface Case {
        method: string;
        path: string;
        status: string;
        url?: string;
        headers?: Record<string, string>;
        body?: string;
        arrange: () => void;
    }

    interface ProxiedOptions {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        /** The request that is not valid: another url, or another body. */
        invalid?: { url?: string; body?: string };
        /** A body over the limit, when the route takes one. */
        tooLarge?: boolean;
    }

    // What every proxied route of the portal answers, as documented
    const proxied = (path: string, url: string, answer: string, options: ProxiedOptions = {}): Case[] => {
        const method = options.method ?? 'get';
        const headers = { ...LOGGED_IN, ...options.headers };
        const base = { method, path, url, ...(options.body === undefined ? {} : { body: options.body }) };
        return [
            { ...base, status: '200', headers, arrange: () => tmforum.answer((res) => tmforum.json(res, 200, answer)) },
            ...(options.invalid === undefined
                ? []
                : [
                      {
                          ...base,
                          status: '400',
                          url: options.invalid.url ?? url,
                          ...(options.invalid.body === undefined ? {} : { body: options.invalid.body }),
                          headers,
                          arrange: () => undefined
                      }
                  ]),
            ...(options.tooLarge === true
                ? [{ ...base, status: '413', body: JSON.stringify({ filler: 'x'.repeat(2000) }), headers, arrange: () => undefined }]
                : []),
            { ...base, status: '401', ...(options.headers === undefined ? {} : { headers: options.headers }), arrange: () => undefined },
            { ...base, status: '404', headers, arrange: () => tmforum.answer((res) => tmforum.json(res, 404, '{"error":"Not found"}')) },
            { ...base, status: '504', headers, arrange: () => tmforum.answer((res) => void setTimeout(() => res.end(), 800)) }
        ];
    };

    const cases: Case[] = [
        { method: 'get', path: '/health/live', status: '200', arrange: () => mongo.ping.mockResolvedValue(false) },
        { method: 'get', path: '/health/ready', status: '200', arrange: () => mongo.ping.mockResolvedValue(true) },
        { method: 'get', path: '/health/ready', status: '503', arrange: () => mongo.ping.mockResolvedValue(false) },
        ...proxied(
            '/document/documentSpecification/{id}',
            `/document/documentSpecification/${encodeURIComponent('urn:ngsi-ld:document-specification:7a1c0f3e')}`,
            '{"id":"urn:ngsi-ld:document-specification:7a1c0f3e","name":"Terms"}',
            { invalid: { url: '/document/documentSpecification/a%20b' } }
        ),
        ...proxied(
            '/revenue/dashboard/{id}',
            `/revenue/dashboard/${encodeURIComponent('urn:ngsi-ld:organization:a195013a')}`,
            '[{"label":"Subscription","text":null,"link":null,"items":null}]',
            { invalid: { url: '/revenue/dashboard/a%20b' } }
        ),
        ...proxied('/search-bck/api/searchOrganizations', '/search-bck/api/searchOrganizations?page=0&size=100', '{"content":[]}', {
            method: 'post',
            headers: { 'content-type': 'application/json' },
            body: '{"categories":["Cloud"]}',
            invalid: { body: 'not json' },
            tooLarge: true
        }),
        ...['categories', 'countries', 'complianceLevels'].flatMap((name) =>
            proxied(`/search-bck/api/${name}`, `/search-bck/api/${name}`, '["Cloud","Data"]')
        )
    ];

    beforeAll(async () => {
        await tmforum.start();

        @Module({ imports: [DependenciesStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), HealthModule, AuthModule, DocumentModule, RevenueModule, SearchModule] })
        class Contract {}

        app = await createApp(express(), Contract);
        app.get(LegacyAuthBridge).attach([fakeLogin]);
        await app.listen(0);
        url = await app.getUrl();
    });

    afterAll(async () => {
        await app.close();
        await tmforum.stop();
    });

    beforeEach(() => {
        mongo.ping.mockReset();
        tmforum.reset();
    });

    it('has a case for every documented response', () => {
        const documented = Object.entries(document.paths)
            .flatMap(([path, operations]) =>
                Object.entries(operations).flatMap(([method, operation]) =>
                    Object.keys(operation.responses).map((status) => `${method} ${path} ${status}`)
                )
            )
            .sort();

        expect(cases.map((c) => `${c.method} ${c.path} ${c.status}`).sort()).toEqual(documented);
    });

    it.each(cases)('$method $path answers $status as documented', async ({ method, path, status, arrange, url: target, headers, body: requestBody }) => {
        arrange();
        const response = document.paths[path]?.[method]?.responses[status];

        const res = await fetch(`${url}${target ?? path}`, {
            method: method.toUpperCase(),
            ...(headers === undefined ? {} : { headers }),
            ...(requestBody === undefined ? {} : { body: requestBody })
        });
        const body: unknown = await res.json();

        expect(res.status).toBe(Number(status));
        const schema = response?.content?.['application/json']?.schema;
        expect(schema).toBeDefined();
        const validate = ajv.compile(schema ?? {});
        expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
        for (const header of Object.keys(response?.headers ?? {})) {
            expect(res.headers.get(header), `header ${header}`).not.toBeNull();
        }
    });

    it('returns the request id it is given', async () => {
        mongo.ping.mockResolvedValue(true);
        const declared = document.paths['/health/ready']?.get?.parameters?.find((p) => p.in === 'header');

        const res = await fetch(`${url}/health/ready`, { headers: { [declared?.name ?? '']: 'abc-123' } });

        expect(declared?.name).toBe('X-Request-Id');
        expect(res.headers.get('x-request-id')).toBe('abc-123');
    });
});
