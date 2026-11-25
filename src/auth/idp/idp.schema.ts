import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// The collection and the fields are the ones of v11, so that what was kept stays and v11 can still read it. A record keeps the
// client, the key and the callback it was made with, although only the callback is read back
@Schema({ collection: 'idps', versionKey: false })
export class Idp {
    @Prop({ type: String, required: true })
    provider!: string;

    @Prop({ type: String, required: true })
    name!: string;

    @Prop({ type: String, required: true })
    server!: string;

    @Prop({ type: String, required: true })
    clientID!: string;

    @Prop({ type: String, required: true })
    callbackURL!: string;

    @Prop({ type: String, required: true, unique: true })
    idpId!: string;

    @Prop({ type: String })
    issuerDid?: string;

    @Prop({ type: String })
    description?: string;

    @Prop({ type: String, required: true })
    tokenKey!: string;

    @Prop({ type: String, required: true })
    tokenCrt!: string;
}

export const IdpSchema = SchemaFactory.createForClass(Idp);
IdpSchema.index({ name: 'text', description: 'text' });
