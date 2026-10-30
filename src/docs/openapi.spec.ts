import { join } from 'node:path';
import { Global, Module, RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Test, type TestingModule } from '@nestjs/testing';
import Ajv from 'ajv';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { AppModule } from '../app.module';
import { HealthModule } from '../health/health.module';
import { MongoConnectionService } from '../persistence/mongo-connection.service';

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

const mongo = { ping: vi.fn<(timeoutMs: number) => Promise<boolean>>() };

@Global()
@Module({
    providers: [
        { provide: AppConfigService, useValue: { app: { shutdownDelayMs: 0 }, health: { mongoPingTimeoutMs: 500 } } },
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
                    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
                    routes.push(`${RequestMethod[method]?.toLowerCase()} /${[base, path].map(trimSlashes).filter(Boolean).join('/')}`);
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

    const cases = [
        { method: 'get', path: '/health/live', status: '200', arrange: () => mongo.ping.mockResolvedValue(false) },
        { method: 'get', path: '/health/ready', status: '200', arrange: () => mongo.ping.mockResolvedValue(true) },
        { method: 'get', path: '/health/ready', status: '503', arrange: () => mongo.ping.mockResolvedValue(false) }
    ];

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            imports: [DependenciesStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), HealthModule]
        }).compile();
        app = module.createNestApplication();
        await app.listen(0);
        url = await app.getUrl();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        mongo.ping.mockReset();
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

    it.each(cases)('$method $path answers $status as documented', async ({ method, path, status, arrange }) => {
        arrange();
        const response = document.paths[path]?.[method]?.responses[status];

        const res = await fetch(`${url}${path}`, { method: method.toUpperCase() });
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
