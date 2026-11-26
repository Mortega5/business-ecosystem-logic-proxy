import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'config', strict: false, versionKey: false })
export class ConfigEntry {
    @Prop({ type: String, required: true })
    id!: string;
}

export const ConfigEntrySchema = SchemaFactory.createForClass(ConfigEntry);

// Partial so that documents kept without an `id` do not count as duplicates of each other (they are all `null` to a plain unique index)
ConfigEntrySchema.index({ id: 1 }, { unique: true, partialFilterExpression: { id: { $type: 'string' } } });
