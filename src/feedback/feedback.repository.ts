import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MongooseRepository } from '../persistence/mongoose.repository';
import { Feedback } from './feedback.schema';

@Injectable()
export class FeedbackRepository extends MongooseRepository<Feedback> {
    constructor(@InjectModel(Feedback.name) model: Model<Feedback>) {
        super(model);
    }
}
