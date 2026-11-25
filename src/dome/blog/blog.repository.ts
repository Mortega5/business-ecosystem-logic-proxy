import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Blog } from './blog.schema';

/** An entry as it is kept. `type` is what entries made before `contentType` call it. */
export interface BlogRecord {
    _id: { toString(): string };
    title: string;
    contentType?: string;
    type?: string;
    slug?: string;
    featuredImage?: string;
    metaDescription?: string;
    excerpt?: string;
    author?: string;
    partyId?: string;
    tags?: string[];
    date?: Date;
    content: string;
}

export type BlogFields = Partial<Omit<Blog, 'slugNormalized'>> & { slugNormalized?: string };

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The entries of the blog, in the collection that v11 kept them in. The ids are checked before they get here. */
@Injectable()
export class BlogRepository {
    constructor(@InjectModel(Blog.name) private readonly model: Model<Blog>) {}

    list(): Promise<BlogRecord[]> {
        return this.model.find().sort({ date: -1 }).lean<BlogRecord[]>().exec();
    }

    async findById(id: string): Promise<BlogRecord | undefined> {
        return (await this.model.findById(id).lean<BlogRecord>().exec()) ?? undefined;
    }

    /** The entries that have no slug, which v11 gave when they were read. */
    withoutSlug(): Promise<BlogRecord[]> {
        return this.model
            .find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] })
            .lean<BlogRecord[]>()
            .exec();
    }

    /** Whether another entry has the slug, whatever its case; an entry from before `slugNormalized` is found by its slug. */
    async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
        const query: Record<string, unknown> = {
            $or: [{ slugNormalized: slug.toLowerCase() }, { slug: new RegExp(`^${escapeRegex(slug)}$`, 'i') }]
        };
        if (exceptId !== undefined) {
            query['_id'] = { $ne: exceptId };
        }
        return (await this.model.exists(query)) !== null;
    }

    async create(fields: BlogFields): Promise<BlogRecord> {
        const created = await this.model.create(fields);
        return created.toObject() as unknown as BlogRecord;
    }

    /** Sets and removes fields of an entry; the entry after the change, or undefined when there is none. */
    async change(id: string, set: BlogFields, unset: string[]): Promise<BlogRecord | undefined> {
        const update: Record<string, unknown> = {};
        if (Object.keys(set).length > 0) {
            update['$set'] = set;
        }
        if (unset.length > 0) {
            update['$unset'] = Object.fromEntries(unset.map((field) => [field, '']));
        }
        return (await this.model.findByIdAndUpdate(id, update, { new: true }).lean<BlogRecord>().exec()) ?? undefined;
    }

    /** Gives a slug to an entry that has none, if it still has none. */
    async giveSlug(id: string, slug: string): Promise<void> {
        await this.model.updateOne(
            { _id: id, $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] },
            { $set: { slug, slugNormalized: slug.toLowerCase() } }
        );
    }

    async remove(id: string): Promise<BlogRecord | undefined> {
        return (await this.model.findByIdAndDelete(id).lean<BlogRecord>().exec()) ?? undefined;
    }
}
