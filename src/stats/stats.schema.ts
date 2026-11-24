import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// The collection and its two lists are the ones of v11, whose document has a generated id and no date: it is read as one that is
// out of date, and the first refresh writes the document of its own
@Schema({ collection: 'stats', strict: false, versionKey: false })
export class StatsEntry {
    @Prop({ type: String })
    _id!: string;
}

export const StatsEntrySchema = SchemaFactory.createForClass(StatsEntry);
