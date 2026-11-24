import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FeedbackController } from './feedback.controller';
import { FeedbackRepository } from './feedback.repository';
import { Feedback, FeedbackSchema } from './feedback.schema';

@Module({
    imports: [MongooseModule.forFeature([{ name: Feedback.name, schema: FeedbackSchema }])],
    controllers: [FeedbackController],
    providers: [FeedbackRepository]
})
export class FeedbackModule {}
