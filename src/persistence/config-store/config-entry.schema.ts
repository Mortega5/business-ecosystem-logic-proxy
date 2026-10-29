import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'config', strict: false, versionKey: false })
export class ConfigEntry {
    @Prop({ type: String, required: true })
    id!: string;
}

export const ConfigEntrySchema = SchemaFactory.createForClass(ConfigEntry);
