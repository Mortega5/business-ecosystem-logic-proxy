import { describe, expect, it, vi } from 'vitest';
import { DomainError, NotFoundError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import type { BlogFields, BlogRecord, BlogRepository } from './blog.repository';
import type { MongoConnectionService } from '../persistence/mongo-connection.service';
import { BlogService, slugBaseOf, viewOf } from './blog.service';

const ID = '64b7f0a1c2d3e4f5a6b7c8d9';
const OTHER = '64b7f0a1c2d3e4f5a6b7c8da';

/** The entries in memory, with the unique slug that the index of Mongo keeps. */
class MemoryEntries {
    records: (BlogRecord & { slugNormalized?: string })[] = [];
    private counter = 0;
    failNextCreateWithDuplicate = false;

    list = vi.fn(() =>
        Promise.resolve([...this.records].sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)))
    );
    findById = vi.fn((id: string) => Promise.resolve(this.records.find((record) => record._id.toString() === id)));
    withoutSlug = vi.fn(() => Promise.resolve(this.records.filter((record) => !record.slug)));
    slugTaken = vi.fn((slug: string, exceptId?: string) =>
        Promise.resolve(
            this.records.some(
                (record) => record._id.toString() !== exceptId && record.slug?.toLowerCase() === slug.toLowerCase()
            )
        )
    );
    create = vi.fn((fields: BlogFields) => {
        if (this.failNextCreateWithDuplicate) {
            return Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
        }
        this.counter += 1;
        const record = {
            _id: `64b7f0a1c2d3e4f5a6b7c8${(0xd0 + this.counter).toString(16)}`,
            ...fields
        } as unknown as BlogRecord;
        this.records.push(record);
        return Promise.resolve(record);
    });
    change = vi.fn((id: string, set: BlogFields, unset: string[]) => {
        const record = this.records.find((candidate) => candidate._id.toString() === id);
        if (record === undefined) {
            return Promise.resolve(undefined);
        }
        Object.assign(record, set);
        unset.forEach((field) => delete (record as unknown as Record<string, unknown>)[field]);
        return Promise.resolve(record);
    });
    giveSlug = vi.fn((id: string, slug: string) => {
        const record = this.records.find((candidate) => candidate._id.toString() === id);
        if (record !== undefined) {
            record.slug = slug;
        }
        return Promise.resolve();
    });
    remove = vi.fn((id: string) => {
        const record = this.records.find((candidate) => candidate._id.toString() === id);
        this.records = this.records.filter((candidate) => candidate !== record);
        return Promise.resolve(record);
    });
}

const setup = (blogEnabled = true) => {
    const entries = new MemoryEntries();
    const service = new BlogService(
        entries as unknown as BlogRepository,
        { blog: { enabled: blogEnabled } } as AppConfigService
    );
    return { entries, service };
};
const record = (extra: Partial<BlogRecord> = {}): BlogRecord => ({
    _id: ID,
    title: 'Hello',
    content: 'Body',
    date: new Date('2026-01-01T00:00:00Z'),
    ...extra
});

describe('the view of an entry', () => {
    it('says what v11 said, with the content type of the entries that had `type`, the date as text and no empty tags', () => {
        expect(viewOf(record({ type: 'faq', tags: ['a', ' ', 'b'], slug: 's' }))).toEqual({
            _id: ID,
            title: 'Hello',
            contentType: 'faq',
            slug: 's',
            tags: ['a', 'b'],
            date: '2026-01-01T00:00:00.000Z',
            content: 'Body'
        });
        expect(viewOf(record()).contentType).toBe('blog');
        expect(viewOf(record({ contentType: 'strange' })).contentType).toBe('blog');
    });

    it('makes a slug from a title', () => {
        expect(slugBaseOf('  Hello, World! 2026 ')).toBe('hello-world-2026');
        expect(slugBaseOf('¡¡¡')).toBe('post');
    });
});

describe('BlogService: reading', () => {
    it('lists the entries, newest first, and reads one; one that is not an id or is not there is not found', async () => {
        const { service, entries } = setup();
        entries.records = [
            record({ date: new Date('2026-01-01') }),
            record({ _id: OTHER, title: 'Newer', date: new Date('2026-02-01') })
        ];
        expect((await service.list()).map((entry) => entry.title)).toEqual(['Newer', 'Hello']);
        expect((await service.get(ID)).title).toBe('Hello');
        await expect(service.get('64b7f0a1c2d3e4f5a6b7c8db')).rejects.toBeInstanceOf(NotFoundError);
        await expect(service.get('{"$ne":""}')).rejects.toBeInstanceOf(NotFoundError);
        expect(entries.findById).not.toHaveBeenCalledWith('{"$ne":""}');
    });

    it('does not write when it reads', async () => {
        const { service, entries } = setup();
        entries.records = [record()];
        await service.list();
        await service.get(ID);
        expect(entries.giveSlug).not.toHaveBeenCalled();
        expect(entries.change).not.toHaveBeenCalled();
    });
});

describe('BlogService: making an entry', () => {
    it('makes a slug from the title when there is none, and a free one when it is taken', async () => {
        const { service } = setup();
        const first = await service.create({ title: 'Hello World', content: 'x' });
        const second = await service.create({ title: 'Hello World', content: 'x' });
        expect(first.slug).toBe('hello-world');
        expect(second.slug).toBe('hello-world-1');
        expect(first.contentType).toBe('blog');
        expect(first.tags).toEqual([]);
    });

    it('keeps the slug that is given, and refuses one that is taken whatever its case', async () => {
        const { service } = setup();
        await service.create({ title: 'A', content: 'x', slug: 'my-slug' });
        await expect(service.create({ title: 'B', content: 'x', slug: 'MY-SLUG' })).rejects.toMatchObject({
            status: 409
        });
    });

    it('tells a 409 when two requests took the same slug at once', async () => {
        const { service, entries } = setup();
        entries.failNextCreateWithDuplicate = true;
        await expect(service.create({ title: 'A', content: 'x' })).rejects.toMatchObject({ status: 409 });
    });

    it('keeps the fields that are given, and the date and the type it was given', async () => {
        const { service } = setup();
        const made = await service.create({
            title: 'A',
            content: 'x',
            contentType: 'news',
            author: 'Ana',
            tags: ['t'],
            date: new Date('2026-03-04T00:00:00Z'),
            excerpt: null
        });
        expect(made).toMatchObject({
            contentType: 'news',
            author: 'Ana',
            tags: ['t'],
            date: '2026-03-04T00:00:00.000Z'
        });
        expect(made).not.toHaveProperty('excerpt');
    });
});

describe('BlogService: changing and removing an entry', () => {
    it('changes what is sent, takes away what is sent empty, and refuses a change with nothing in it', async () => {
        const { service, entries } = setup();
        entries.records = [record({ slug: 'hello', author: 'Ana', excerpt: 'short' })];
        const changed = await service.update(ID, { title: 'New', author: null });
        expect(changed.title).toBe('New');
        expect(changed).not.toHaveProperty('author');
        expect(changed.excerpt).toBe('short');
        await expect(service.update(ID, {})).rejects.toMatchObject({ status: 400 });
        await expect(service.update('64b7f0a1c2d3e4f5a6b7c8db', { title: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lets an entry keep its own slug in another case, and refuses one that another entry has', async () => {
        const { service, entries } = setup();
        entries.records = [record({ slug: 'hello' }), record({ _id: OTHER, title: 'Other', slug: 'other' })];
        await expect(service.update(ID, { slug: 'HELLO'.toLowerCase() })).resolves.toBeDefined();
        await expect(service.update(ID, { slug: 'other' })).rejects.toMatchObject({ status: 409 });
    });

    it('does not take the slug of an entry away with an empty one, and gives one to an entry that has none', async () => {
        const { service, entries } = setup();
        entries.records = [record({ slug: 'hello' })];
        expect((await service.update(ID, { slug: null, title: 'Changed' })).slug).toBe('hello');

        entries.records = [record()];
        expect((await service.update(ID, { content: 'new' })).slug).toBe('hello');
    });

    it('removes an entry and says which, and says there is none when there is none', async () => {
        const { service, entries } = setup();
        entries.records = [record()];
        expect((await service.remove(ID)).title).toBe('Hello');
        await expect(service.remove(ID)).rejects.toBeInstanceOf(NotFoundError);
        await expect(service.remove('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
        expect(DomainError).toBeDefined();
    });
});

describe('BlogService: when it starts', () => {
    it('gives a slug to the entries that have none, one that is free for each', async () => {
        const { service, entries } = setup();
        entries.records = [record({ title: 'Same' }), record({ _id: OTHER, title: 'Same' })];
        await service.giveSlugs();
        expect(entries.records.map((entry) => entry.slug)).toEqual(['same', 'same-1']);
    });

    it('waits for the database before it reads the entries, and does not hold the start while it waits', async () => {
        let connect: () => void = () => undefined;
        const mongo = { whenUp: () => new Promise<void>((resolve) => (connect = resolve)) } as unknown as MongoConnectionService;
        const entries = new MemoryEntries();
        entries.records = [record({ title: 'Late' })];
        const service = new BlogService(entries as unknown as BlogRepository, { blog: { enabled: true } } as AppConfigService, mongo);

        service.onApplicationBootstrap();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(entries.withoutSlug).not.toHaveBeenCalled();

        connect();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(entries.records.map((entry) => entry.slug)).toEqual(['late']);
    });

    it('does nothing with the extension off, and does not stop the start when the database fails', async () => {
        const off = setup(false);
        await off.service.giveSlugs();
        expect(off.entries.withoutSlug).not.toHaveBeenCalled();

        const failing = setup();
        failing.entries.withoutSlug.mockRejectedValue(new Error('down'));
        await expect(failing.service.giveSlugs()).resolves.toBeUndefined();
    });
});
