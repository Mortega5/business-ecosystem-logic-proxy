import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MongooseRepository } from '../../persistence/mongoose.repository';
import { Idp } from './idp.schema';

@Injectable()
export class IdpRepository extends MongooseRepository<Idp> {
    constructor(@InjectModel(Idp.name) model: Model<Idp>) {
        super(model);
    }

    /** The ones whose name has the words; the text is data for the search and nothing else. */
    async search(text: string): Promise<Idp[]> {
        const found = await this.model.find({ $text: { $search: String(text) } }).lean<(Idp & { _id?: unknown })[]>();
        return found.map(({ _id, ...idp }) => {
            void _id;
            return idp as Idp;
        });
    }

    /** The record as it is given, so that a field that is not there is gone. */
    async replace(idpId: string, record: Idp): Promise<boolean> {
        const result = await this.model.replaceOne({ idpId: String(idpId) }, record);
        return result.matchedCount > 0;
    }
}
