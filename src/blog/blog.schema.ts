import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export const CONTENT_TYPES = ['blog', 'news', 'faq'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

// The collection and the fields are the ones of v11, so that what was written stays. Entries older than `contentType` have it as `type`
@Schema({ collection: 'blogs' })
export class Blog {
    @Prop({ type: String, required: true })
    title!: string;

    @Prop({ type: String, required: true, default: 'blog' })
    contentType!: ContentType;

    // The same with the case folded, so that two slugs that differ in case are the same one; not given back to the client
    @Prop({ type: String, select: false })
    slugNormalized?: string;

    @Prop({ type: String })
    slug?: string;

    @Prop({ type: String })
    featuredImage?: string;

    @Prop({ type: String })
    metaDescription?: string;

    @Prop({ type: String })
    excerpt?: string;

    @Prop({ type: String })
    author?: string;

    @Prop({ type: String })
    partyId?: string;

    @Prop({ type: [String], default: [] })
    tags!: string[];

    @Prop({ type: Date, default: Date.now })
    date!: Date;

    @Prop({ type: String, required: true })
    content!: string;
}

export const BlogSchema = SchemaFactory.createForClass(Blog);
// A slug is unique whatever its case; an entry without one is not in the index
BlogSchema.index({ slugNormalized: 1 }, { unique: true, partialFilterExpression: { slugNormalized: { $type: 'string' } } });
