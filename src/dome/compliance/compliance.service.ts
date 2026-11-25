import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { isResourceId } from '../../tmf/resource-id.pipe';
import { callerParty, isRecord, isRelatedAs } from '../../tmf/related-party';
import { parseJson } from '../../tmf/specification/specifications';
import { TmfProxy } from '../../tmf/tmf-proxy';
import type { UpstreamUser } from '../../tmf/upstream-headers';
import { complianceFileAddresses, organizationFields } from './compliance-form';
import { fetchPublicFile, PublicFileError, type PublicFile } from './public-file';

const CERTIFICATE_PATH = '/api/v1/product-offering/certificate';
// What the compliance service answers is read up to here: a certificate and its report are small
const MAX_ANSWER_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;

const request = z.looseObject({ id: z.string() });

export interface CertificateRequestResult {
    status: number;
    body: unknown;
}

/**
 * The request for the compliance certificate of a product. The product is the one that TMForum has, not the one the client sends, and the
 * caller has to be its seller: the compliance service is told about the seller organisation and given the files the product names.
 */
@Injectable()
export class ComplianceService {
    private readonly logger = new Logger(ComplianceService.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService
    ) {}

    async requestCertificate(req: Request, body: string): Promise<CertificateRequestResult> {
        const settings = this.config.dome.compliance;
        if (settings.serverUrl === '') {
            throw new DomainError('The compliance service is not configured', 503);
        }
        const parsed = request.safeParse(JSON.parse(body));
        if (!parsed.success || !isResourceId(parsed.data.id)) {
            throw new DomainError('Invalid product specification', 400);
        }
        const specId = parsed.data.id;
        const partyId = callerParty(req, 'You need a party to ask for a certificate');

        const spec = await this.read(
            req,
            'tmforum.catalog',
            `/productSpecification/${encodeURIComponent(specId)}`,
            'The product specification does not exist'
        );
        if (!isRelatedAs(spec, partyId, this.config.auth.roles.seller)) {
            throw new ForbiddenError('You are not the seller of the product specification');
        }
        // The seller is the caller, so the organisation to tell the compliance service about is the party of the caller
        const organization = await this.read(
            req,
            'tmforum.party',
            `/organization/${encodeURIComponent(partyId)}`,
            'The seller of the product specification is not an organization'
        );

        const files = await this.files(spec);
        const form = new FormData();
        form.append('product_specification_id', specId);
        form.append('service_name', typeof spec['name'] === 'string' ? spec['name'] : '');
        form.append('service_version', typeof spec['version'] === 'string' ? spec['version'] : '');
        for (const [name, value] of Object.entries(organizationFields(organization))) {
            form.append(name, value);
        }
        form.append('requested_compliance_level', 'Baseline');
        for (const file of files) {
            form.append('files', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
        }

        this.logger.log(
            `A compliance certificate was asked for the product specification ${specId} with ${files.length} files`
        );
        return this.send(req, form, specId);
    }

    // What TMForum has of a resource: a resource that is not there is a 404, and an API that does not answer is the client's 502
    private async read(
        req: Request,
        upstream: 'tmforum.catalog' | 'tmforum.party',
        path: string,
        missing: string
    ): Promise<Json> {
        const response = await this.proxy.send(req, { upstream, path, method: 'GET', search: '' });
        if (response.status === 404) {
            throw new NotFoundError(missing);
        }
        const found = parseJson(response.body);
        if (response.status >= 400 || !isRecord(found)) {
            this.logger.warn(`${upstream} answered ${response.status} when reading ${path}`);
            throw new BadGatewayError('The product specification could not be read');
        }
        return found;
    }

    private async files(spec: Json): Promise<PublicFile[]> {
        const { maxFiles, maxFileMb, fileOrigins, timeoutMs } = this.config.dome.compliance;
        const addresses = complianceFileAddresses(spec);
        if (addresses.length > maxFiles) {
            throw new DomainError(`A certificate can be asked for with at most ${maxFiles} files`, 422);
        }
        const files: PublicFile[] = [];
        for (const [index, address] of addresses.entries()) {
            try {
                files.push(
                    await fetchPublicFile(address, index, {
                        maxBytes: maxFileMb * 1024 * 1024,
                        timeoutMs,
                        origins: fileOrigins
                    })
                );
            } catch (error) {
                if (!(error instanceof PublicFileError)) {
                    throw error;
                }
                // The address is the seller's own writing and is not repeated: the number of the file says which one it is
                this.logger.warn(`A file of a compliance request could not be taken: file ${index + 1}, ${error.kind}`);
                const message = `The compliance file ${index + 1} ${error.message}`;
                if (error.kind === 'failed') {
                    throw new BadGatewayError(message);
                }
                throw new DomainError(message, error.kind === 'too-large' ? 413 : 422);
            }
        }
        return files;
    }

    private async send(req: Request, form: FormData, specId: string): Promise<CertificateRequestResult> {
        const { serverUrl, timeoutMs } = this.config.dome.compliance;
        const token = (req as Request & { user?: UpstreamUser }).user?.accessToken;
        let response: Response;
        try {
            response = await fetch(`${serverUrl.replace(/\/+$/, '')}${CERTIFICATE_PATH}`, {
                method: 'POST',
                headers: token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` },
                body: form,
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch {
            this.logger.error(`The compliance service could not be reached for the product specification ${specId}`);
            throw new DomainError('Compliance server unreachable', 504);
        }
        const answer = parseJson(await this.text(response));
        if (response.status >= 400) {
            this.logger.warn(
                `The compliance service answered ${response.status} for the product specification ${specId}`
            );
            // What it says is for the client only when it is the client's fault
            const reason =
                isRecord(answer) && typeof answer['error'] === 'string' ? answer['error'].slice(0, 300) : undefined;
            if (response.status < 500) {
                throw new DomainError(reason ?? 'The compliance service refused the request', response.status);
            }
            throw new BadGatewayError('The compliance service failed');
        }
        return { status: response.status, body: answer ?? {} };
    }

    private async text(response: Response): Promise<string> {
        const reader = response.body?.getReader();
        if (reader === undefined) {
            return '';
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            received += value.byteLength;
            if (received > MAX_ANSWER_BYTES) {
                await reader.cancel();
                throw new BadGatewayError('The compliance service answered more than expected');
            }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
    }
}
