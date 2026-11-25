import { All, Controller, Get, Param, ParseEnumPipe, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { ResourceIdPipe } from '../resource-id.pipe';
import { TmfProxy } from '../tmf-proxy';

// The formats accepted for an invoice
const InvoiceFormat = { XmlHtml: 'xml-html' } as const;

/**
 * The invoicing API, as far as the portal uses it: an invoice as an HTML page that the browser opens in a new tab, so
 * the user is the one of the session cookie. The page is served sandboxed and with `no-store`. Everything else under
 * /invoicing is closed here.
 */
@Controller('invoicing')
export class InvoicingController {
    constructor(private readonly proxy: TmfProxy) {}

    @Get('invoices/:id')
    invoice(
        @Param('id', ResourceIdPipe) id: string,
        @Query('format', new ParseEnumPipe(InvoiceFormat)) format: string,
        @Req() req: Request,
        @Res() res: Response
    ): Promise<void> {
        return this.proxy.forward(req, res, {
            upstream: 'tmforum.invoicing',
            path: `/invoices/${encodeURIComponent(id)}`,
            search: `?format=${format}`,
            responseHeaders: { 'content-security-policy': 'sandbox', 'cache-control': 'no-store' }
        });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
