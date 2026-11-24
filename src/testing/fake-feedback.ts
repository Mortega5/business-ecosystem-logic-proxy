import { Module } from '@nestjs/common';
import { FeedbackController } from '../feedback/feedback.controller';
import { FeedbackRepository } from '../feedback/feedback.repository';
import type { Feedback } from '../feedback/feedback.schema';
import { InMemoryRepository } from './in-memory.repository';

/** The feedback that a test has kept. */
export const keptFeedback = new InMemoryRepository<Feedback>();

/** The feedback route as `FeedbackModule` has it, with no database. */
@Module({ controllers: [FeedbackController], providers: [{ provide: FeedbackRepository, useValue: keptFeedback }] })
export class FakeFeedbackModule {}
