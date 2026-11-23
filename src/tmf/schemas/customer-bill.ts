import { z } from 'zod';
import { isResourceId } from '../resource-id.pipe';
import { pagination } from './pagination';

/** What a party of a bill may change in it: its name, and nothing else. */
export const billRenaming = (nameLength: number) =>
    z.strictObject({ billNo: z.string().trim().min(1).max(nameLength) });

export type BillRenaming = z.infer<ReturnType<typeof billRenaming>>;

/** The query of the rates of a bill: the bill and the page, and no other filter. */
export const ratesQuery = z.strictObject({ 'bill.id': z.string().refine(isResourceId), ...pagination });
