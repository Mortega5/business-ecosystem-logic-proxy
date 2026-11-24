import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * The key is the hash of what the caller asked for, so an access token is never an id in the database, and the value is
 * sealed. Mongo removes the document some time after `expiresAt` (it looks every minute), so a read checks the date too.
 */
@Schema({ collection: 'auth_cache', versionKey: false })
export class AuthCacheEntry {
    @Prop({ type: String })
    _id!: string;

    @Prop({ type: String, required: true })
    value!: string;

    @Prop({ type: Date, required: true, expires: 0 })
    expiresAt!: Date;
}

export const AuthCacheEntrySchema = SchemaFactory.createForClass(AuthCacheEntry);
