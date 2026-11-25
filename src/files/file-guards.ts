import { Injectable, Logger } from '@nestjs/common';
import { BadGatewayError, ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { fileTargetsIn } from './file-policy';
import { FileServiceClient, type StoredFile } from './file-service.client';

/** The label of a file in the file service that names the party it belongs to; the proxy writes it when the file is uploaded. */
export const OWNER_LABEL = 'owner';
const FILE_ID = 'fileId';

/** The party a file belongs to, from its metadata, or undefined when it has no owner. */
export const ownerOf = (file: StoredFile | undefined): string | undefined => {
    const owner = file?.labels?.[OWNER_LABEL];
    return typeof owner === 'string' ? owner : undefined;
};

/** The values of a characteristic of a service specification, as it comes in a request. */
const characteristicValues = (serviceSpec: unknown, name: string): string[] => {
    const characteristics =
        typeof serviceSpec === 'object' && serviceSpec !== null && Array.isArray((serviceSpec as { specCharacteristic?: unknown }).specCharacteristic)
            ? ((serviceSpec as { specCharacteristic: unknown[] }).specCharacteristic as Record<string, unknown>[])
            : [];
    return characteristics
        .filter((characteristic) => typeof characteristic === 'object' && characteristic !== null && characteristic['name'] === name)
        .flatMap((characteristic) => (Array.isArray(characteristic['characteristicValueSpecification']) ? (characteristic['characteristicValueSpecification'] as unknown[]) : []))
        .map((value) => (typeof value === 'object' && value !== null ? (value as { value?: unknown }).value : undefined))
        .filter((value): value is string => typeof value === 'string' && value !== '');
};

/**
 * What a seller may name when they make a product or a service: the files they uploaded and no others. The policy of a product
 * grants reading the files it names, so naming another party's file would grant it.
 */
@Injectable()
export class FileGuards {
    private readonly logger = new Logger(FileGuards.name);

    constructor(
        private readonly files: FileServiceClient,
        private readonly config: AppConfigService
    ) {}

    /** Without a file service there are no files to guard. */
    get guarding(): boolean {
        return this.config.fileService.enabled;
    }

    /** A service specification that points at a file (a dataset made from one) can only point at a file of the party that makes it. */
    async checkServiceSpecFiles(serviceSpec: unknown, partyId: string | null | undefined): Promise<void> {
        if (!this.guarding) {
            return;
        }
        const ids = new Set(characteristicValues(serviceSpec, FILE_ID));
        for (const id of ids) {
            const file = await this.find(id);
            if (file === undefined || partyId === undefined || partyId === null || ownerOf(file) !== partyId) {
                throw new ForbiddenError(`The file ${id} is not one of your files`);
            }
        }
    }

    /**
     * An access policy can only grant reading files of the party that makes the product, and cannot name files in a way that could
     * reach others': a pattern, or only the start of an id. A file that does not exist is not another's: its id is made by the file
     * service, so nobody can name now the file that another party will upload.
     */
    async checkProductSpecFiles(productSpec: unknown, partyId: string | null | undefined): Promise<void> {
        if (!this.guarding) {
            return;
        }
        const { ids, wide } = fileTargetsIn(productSpec);
        if (wide.length > 0) {
            throw new ForbiddenError(`The access policy could grant access to files without naming one: ${wide[0]}`);
        }
        for (const id of new Set(ids)) {
            const file = await this.find(id);
            if (file !== undefined && ownerOf(file) !== partyId) {
                throw new ForbiddenError(`The access policy grants access to the file ${id}, which is not one of your files`);
            }
        }
    }

    // A check that cannot be made is not a pass: the seller is told the files could not be checked
    private async find(fileId: string): Promise<StoredFile | undefined> {
        try {
            return await this.files.find(fileId);
        } catch (error) {
            this.logger.warn(`The file ${fileId} could not be checked: ${error instanceof Error ? error.message : 'unknown error'}`);
            throw new BadGatewayError('The files cannot be checked');
        }
    }
}
