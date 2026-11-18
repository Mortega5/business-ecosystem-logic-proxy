import { All, Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { RequireFeature } from '../../features/require-feature';
import { JsonBodyPipe, OptionalJsonBodyPipe } from '../json-body.pipe';
import { OwnPartyGuard } from '../own-party.guard';
import { ResourceIdPipe } from '../resource-id.pipe';
import { TmfProxy } from '../tmf-proxy';

const ROOT = 'quoteManagement';

/**
 * The quote management API, as far as the portal uses it. Quotes need the `quotes` feature and the tendering routes
 * the `tendering` one. The routes that name a user in the path are for the party of the caller. Everything else under
 * /quote is closed here, so it is not handed to the legacy application.
 */
@Controller('quote')
@RequireFeature('quotes')
export class QuoteController {
    constructor(private readonly proxy: TmfProxy) {}

    private send(req: Request, res: Response, path: string, body?: string): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'tmforum.quote', path: `/${ROOT}/${path}`, ...(body === undefined ? {} : { body }) });
    }

    @Post(`${ROOT}/createQuote`)
    createQuote(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, 'createQuote', body);
    }

    @Post(`${ROOT}/quote`)
    create(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, 'quote', body);
    }

    @Get(`${ROOT}/quote`)
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, 'quote');
    }

    @Get(`${ROOT}/quoteById/:id`)
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, `quoteById/${encodeURIComponent(id)}`);
    }

    @Delete(`${ROOT}/quote/:id`)
    remove(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, `quote/${encodeURIComponent(id)}`);
    }

    @Patch(`${ROOT}/updateQuoteStatus/:id`)
    updateStatus(
        @Param('id', ResourceIdPipe) id: string,
        @Body(OptionalJsonBodyPipe) body: string | undefined,
        @Req() req: Request,
        @Res() res: Response
    ): Promise<void> {
        return this.send(req, res, `updateQuoteStatus/${encodeURIComponent(id)}`, body);
    }

    @Patch(`${ROOT}/updateQuoteDate/:id`)
    updateDate(
        @Param('id', ResourceIdPipe) id: string,
        @Body(OptionalJsonBodyPipe) body: string | undefined,
        @Req() req: Request,
        @Res() res: Response
    ): Promise<void> {
        return this.send(req, res, `updateQuoteDate/${encodeURIComponent(id)}`, body);
    }

    @Patch(`${ROOT}/addNoteToQuote/:id`)
    addNote(
        @Param('id', ResourceIdPipe) id: string,
        @Body(OptionalJsonBodyPipe) body: string | undefined,
        @Req() req: Request,
        @Res() res: Response
    ): Promise<void> {
        return this.send(req, res, `addNoteToQuote/${encodeURIComponent(id)}`, body);
    }

    @Patch(`${ROOT}/addAttachmentToQuote/:id`)
    addAttachment(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, {
            upstream: 'tmforum.quote',
            path: `/${ROOT}/addAttachmentToQuote/${encodeURIComponent(id)}`,
            upload: true
        });
    }

    @Get(`${ROOT}/quoteByUser/:userId`)
    @UseGuards(OwnPartyGuard)
    byUser(@Param('userId', ResourceIdPipe) userId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, `quoteByUser/${encodeURIComponent(userId)}`);
    }

    @Post(`${ROOT}/tendering/createCoordinatorQuote`)
    @RequireFeature('tendering')
    createCoordinatorQuote(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, 'tendering/createCoordinatorQuote', body);
    }

    @Post(`${ROOT}/tendering/createQuote`)
    @RequireFeature('tendering')
    createTenderQuote(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, 'tendering/createQuote', body);
    }

    @Get(`${ROOT}/tendering/coordinatorQuotes/:userId`)
    @RequireFeature('tendering')
    @UseGuards(OwnPartyGuard)
    coordinatorQuotes(@Param('userId', ResourceIdPipe) userId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, `tendering/coordinatorQuotes/${encodeURIComponent(userId)}`);
    }

    @Get(`${ROOT}/tendering/quotes/:userId`)
    @RequireFeature('tendering')
    @UseGuards(OwnPartyGuard)
    tenderQuotes(@Param('userId', ResourceIdPipe) userId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, `tendering/quotes/${encodeURIComponent(userId)}`);
    }

    @Post(`${ROOT}/tendering/broadcastMessage`)
    @RequireFeature('tendering')
    broadcastMessage(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.send(req, res, 'tendering/broadcastMessage', body);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
