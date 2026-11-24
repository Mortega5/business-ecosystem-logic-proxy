import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// The collection and the fields are the ones of v11, so that what was kept stays; its documents have no version
@Schema({ collection: 'feedback', versionKey: false })
export class Feedback {
    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: Number, required: true })
    rating!: number;

    @Prop({ type: String })
    description?: string;

    @Prop({ type: String })
    type?: string;

    @Prop({ type: String, required: true })
    creation_date!: string;
}

export const FeedbackSchema = SchemaFactory.createForClass(Feedback);
