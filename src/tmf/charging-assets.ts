import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { BadGatewayError, DomainError } from '../common/domain-error';
import type { UpstreamResponse } from '../http-client/upstream-client';
import { AS_JSON } from './http-options';
import { isRecord } from './related-party';
import { parseJson } from './specification/specifications';
import { TmfProxy } from './tmf-proxy';

// What the charging backend says about the request itself, which the client is told as it is
const CLIENT_ERRORS = [400, 403, 409, 422];

const PRODUCTS = '/charging/api/assetManagement/assets/validateJob';
const OFFERINGS = '/charging/api/assetManagement/assets/offeringJob';

/**
 * What the charging backend is told about the products and the offerings of the catalog, so that it can check them, keep what it
 * needs and take it back. It answers each call before it is over, and what it says about the request goes to the client as it
 * is; any other failure is a bad gateway. The routes and the `action` of each call are the backend's, and are known only here.
 */
@Injectable()
export class ChargingAssets {
    private readonly logger = new Logger(ChargingAssets.name);

    constructor(private readonly proxy: TmfProxy) {}

    /** The product is valid, before it is made. */
    validateProduct(req: Request, product: unknown): Promise<void> {
        return this.call(req, PRODUCTS, { action: 'create', product }, 'The server has failed validating the product specification');
    }

    /** The product was made. */
    attachProduct(req: Request, product: unknown): Promise<void> {
        return this.call(req, PRODUCTS, { action: 'attach', product }, 'The server has failed validating the product specification');
    }

    /** The product was not made after all. */
    rollbackProduct(req: Request, product: unknown): Promise<void> {
        return this.call(req, PRODUCTS, { action: 'rollback_create', product }, 'The server has failed validating the product specification');
    }

    /** The product is valid as a new version, before it is changed. */
    validateProductUpgrade(req: Request, product: unknown): Promise<void> {
        return this.call(req, PRODUCTS, { action: 'upgrade', product }, 'The server has failed validating the product specification');
    }

    /** The product was changed to a new version. */
    attachProductUpgrade(req: Request, product: unknown): Promise<void> {
        return this.call(req, PRODUCTS, { action: 'attach_upgrade', product }, 'The server has failed validating the product specification');
    }

    /** The product was not changed after all. */
    rollbackProductUpgrade(req: Request, product: unknown): Promise<void> {
        return this.call(req, PRODUCTS, { action: 'rollback_upgrade', product }, 'The server has failed validating the product specification');
    }

    /** The offering is valid, before it is made. */
    validateOffering(req: Request, offering: unknown): Promise<void> {
        return this.call(req, OFFERINGS, { action: 'create', offering }, 'The server has failed validating the offering');
    }

    /** The offering was made. */
    attachOffering(req: Request, offering: unknown): Promise<void> {
        return this.call(req, OFFERINGS, { action: 'attach', offering }, 'The server has failed validating the offering');
    }

    /** The offering was changed. */
    updateOffering(req: Request, offering: unknown): Promise<void> {
        return this.call(req, OFFERINGS, { action: 'update', offering }, 'The server has failed validating the offering');
    }

    /** `payload` is `{ action, product }` or `{ action, offering }`; only the action, the kind and the id are written to the log. */
    private async call(req: Request, path: string, payload: { action: string } & Record<string, unknown>, failure: string): Promise<void> {
        const { action, ...rest } = payload;
        const [kind] = Object.keys(rest);
        const subject = kind === undefined ? undefined : rest[kind];
        const id = isRecord(subject) && typeof subject['id'] === 'string' ? subject['id'] : 'not made yet';
        const what = `${action} of the ${kind ?? 'asset'} (${id})`;
        let response: UpstreamResponse;
        try {
            response = await this.proxy.send(req, { upstream: 'charging', path, method: 'POST', body: JSON.stringify(payload), ...AS_JSON, search: '' });
        } catch (error) {
            this.logger.warn(`The charging backend could not be reached for the ${what}: ${error instanceof Error ? error.message : 'unknown error'}`);
            throw error;
        }
        if (action.startsWith('rollback')) {
            this.logger.warn(`The charging backend was told to take back what it kept: ${what}, answered ${response.status}`);
        }
        if (response.status < 400) {
            return;
        }
        this.logger.warn(`The charging backend refused the ${what} with ${response.status}`);
        const said = parseJson(response.body);
        if (CLIENT_ERRORS.includes(response.status)) {
            throw new DomainError(isRecord(said) && typeof said['error'] === 'string' ? said['error'] : failure, response.status);
        }
        throw new BadGatewayError(failure);
    }
}
