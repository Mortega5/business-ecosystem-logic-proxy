import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { DomainError, NotFoundError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { MongoConnectionService } from '../persistence/mongo-connection.service';
import type { BlogChangeForm, BlogView, NewBlogForm } from './blog-form';
import { OBJECT_ID } from './blog-form';
import { BlogRepository, type BlogFields, type BlogRecord } from './blog.repository';
import { CONTENT_TYPES, type ContentType } from './blog.schema';

const SLUG_TAKEN = 'A blog entry with the same slug already exists';
const NOT_FOUND = 'Blog entry not found';

const isDuplicate = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

/** A slug made from a title: lowercase letters and digits separated by hyphens. */
export const slugBaseOf = (title: string): string => {
    const base = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return base === '' ? 'post' : base;
};

const contentTypeOf = (record: BlogRecord): ContentType => {
    const kept = record.contentType ?? record.type;
    return (CONTENT_TYPES as readonly string[]).includes(kept ?? '') ? (kept as ContentType) : 'blog';
};

/** What the client is told of an entry: the same as v11, without the version of the document. */
export const viewOf = (record: BlogRecord): BlogView => ({
    _id: record._id.toString(),
    title: record.title,
    contentType: contentTypeOf(record),
    ...(record.slug === undefined || record.slug === null ? {} : { slug: record.slug }),
    ...(record.featuredImage === undefined || record.featuredImage === null
        ? {}
        : { featuredImage: record.featuredImage }),
    ...(record.metaDescription === undefined || record.metaDescription === null
        ? {}
        : { metaDescription: record.metaDescription }),
    ...(record.excerpt === undefined || record.excerpt === null ? {} : { excerpt: record.excerpt }),
    ...(record.author === undefined || record.author === null ? {} : { author: record.author }),
    ...(record.partyId === undefined || record.partyId === null ? {} : { partyId: record.partyId }),
    tags: (record.tags ?? []).filter((tag) => typeof tag === 'string' && tag.trim() !== ''),
    date: (record.date ?? new Date(0)).toISOString(),
    content: record.content
});

/**
 * The entries of the blog, the news and the questions of the marketplace. Anybody reads them; only an administrator writes them. An
 * entry has a slug, which is unique whatever its case and which the proxy makes from the title when the administrator gives none.
 */
@Injectable()
export class BlogService implements OnApplicationBootstrap {
    private readonly logger = new Logger(BlogService.name);

    constructor(
        private readonly entries: BlogRepository,
        private readonly config: AppConfigService,
        @Optional() private readonly mongo?: MongoConnectionService
    ) {}

    /** The server does not wait for it: the entries get their slug when the database is there. */
    onApplicationBootstrap(): void {
        void this.giveSlugs();
    }

    /** The entries that v11 left without slug get one, so that reading never has to write. */
    async giveSlugs(): Promise<void> {
        if (!this.config.blog.enabled) {
            return;
        }
        try {
            await this.mongo?.whenUp();
            for (const entry of await this.entries.withoutSlug()) {
                await this.entries.giveSlug(
                    entry._id.toString(),
                    await this.freeSlug(entry.title, entry._id.toString())
                );
            }
        } catch (error) {
            this.logger.warn(
                `The entries of the blog without slug could not be given one: ${error instanceof Error ? error.message : 'unknown error'}`
            );
        }
    }

    async list(): Promise<BlogView[]> {
        return (await this.entries.list()).map(viewOf);
    }

    async get(id: string): Promise<BlogView> {
        return viewOf(await this.existing(id));
    }

    async create(form: NewBlogForm): Promise<BlogView> {
        const slug = form.slug ?? undefined;
        if (slug !== undefined && (await this.entries.slugTaken(slug))) {
            throw new DomainError(SLUG_TAKEN, 409);
        }
        const chosen = slug ?? (await this.freeSlug(form.title));
        const fields: BlogFields = {
            title: form.title,
            content: form.content,
            contentType: form.contentType ?? 'blog',
            slug: chosen,
            slugNormalized: chosen.toLowerCase(),
            date: form.date ?? new Date(),
            tags: form.tags ?? []
        };
        for (const name of ['featuredImage', 'metaDescription', 'excerpt', 'author', 'partyId'] as const) {
            const value = form[name];
            if (value !== undefined && value !== null) {
                fields[name] = value;
            }
        }
        const created = await this.keepingSlugUnique(() => this.entries.create(fields));
        this.logger.log(`A blog entry was made: ${created._id.toString()}`);
        return viewOf(created);
    }

    async update(id: string, form: BlogChangeForm): Promise<BlogView> {
        if (Object.keys(form).filter((name) => (form as Record<string, unknown>)[name] !== undefined).length === 0) {
            throw new DomainError('No update fields provided', 400);
        }
        const current = await this.existing(id);
        const set: BlogFields = {};
        const unset: string[] = [];

        for (const name of ['title', 'content', 'contentType', 'tags', 'date'] as const) {
            if (form[name] !== undefined) {
                (set as Record<string, unknown>)[name] = form[name];
            }
        }
        // What is sent empty is taken away
        for (const name of ['featuredImage', 'metaDescription', 'excerpt', 'author', 'partyId'] as const) {
            const value = form[name];
            if (value === null) {
                unset.push(name);
            } else if (value !== undefined) {
                set[name] = value;
            }
        }

        const requested = form.slug;
        if (typeof requested === 'string') {
            const same = current.slug?.toLowerCase() === requested.toLowerCase();
            if (!same && (await this.entries.slugTaken(requested, id))) {
                throw new DomainError(SLUG_TAKEN, 409);
            }
            set.slug = requested;
            set.slugNormalized = requested.toLowerCase();
        } else if (current.slug === undefined || current.slug === null || current.slug === '') {
            // An empty slug does not take the one that the entry has; one that has none is given one
            const slug = await this.freeSlug(form.title ?? current.title, id);
            set.slug = slug;
            set.slugNormalized = slug.toLowerCase();
        }

        const changed = await this.keepingSlugUnique(() => this.entries.change(id, set, unset));
        if (changed === undefined) {
            throw new NotFoundError(NOT_FOUND);
        }
        this.logger.log(`A blog entry was changed: ${id}`);
        return viewOf(changed);
    }

    async remove(id: string): Promise<BlogView> {
        this.assertId(id);
        const removed = await this.entries.remove(id);
        if (removed === undefined) {
            throw new NotFoundError(NOT_FOUND);
        }
        this.logger.log(`A blog entry was removed: ${id}`);
        return viewOf(removed);
    }

    private assertId(id: string): void {
        // A string that is not an id cannot be an entry; it is not given to the database to complain about
        if (!OBJECT_ID.test(id)) {
            throw new NotFoundError(NOT_FOUND);
        }
    }

    private async existing(id: string): Promise<BlogRecord> {
        this.assertId(id);
        const found = await this.entries.findById(id);
        if (found === undefined) {
            throw new NotFoundError(NOT_FOUND);
        }
        return found;
    }

    private async freeSlug(title: string, exceptId?: string): Promise<string> {
        const base = slugBaseOf(title);
        let candidate = base;
        for (let counter = 1; await this.entries.slugTaken(candidate, exceptId); counter += 1) {
            candidate = `${base}-${counter}`;
        }
        return candidate;
    }

    // Two requests can take the same slug between the check and the write: the index makes the second one fail
    private async keepingSlugUnique<T>(write: () => Promise<T>): Promise<T> {
        try {
            return await write();
        } catch (error) {
            if (isDuplicate(error)) {
                throw new DomainError(SLUG_TAKEN, 409);
            }
            throw error;
        }
    }
}
