import { describe, expect, it, vi } from 'vitest';
import { DomainError, NotFoundError } from '../../common/domain-error';
import { BlogController } from './blog.controller';
import type { BlogService } from './blog.service';

const setup = () => {
    const blog = {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ _id: 'x' }),
        create: vi.fn().mockResolvedValue({ _id: 'x' }),
        update: vi.fn().mockResolvedValue({ _id: 'x' }),
        remove: vi.fn().mockResolvedValue({ _id: 'x' })
    };
    return { blog, controller: new BlogController(blog as unknown as BlogService) };
};
const json = (value: unknown): string => JSON.stringify(value);

describe('BlogController', () => {
    it('lists and reads', async () => {
        const { controller, blog } = setup();
        await controller.list();
        await controller.get('abc');
        expect(blog.list).toHaveBeenCalledOnce();
        expect(blog.get).toHaveBeenCalledWith('abc');
    });

    it('makes an entry from what is valid, and refuses what is not with a 400', async () => {
        const { controller, blog } = setup();
        await controller.create(json({ title: 'A', content: 'B', ignored: 1 }));
        expect(blog.create).toHaveBeenCalledWith({ title: 'A', content: 'B' });
        await expect(controller.create(json({ title: 'A' }))).rejects.toMatchObject({
            status: 400,
            message: 'Validation failed'
        });
        await expect(
            controller.create(json({ title: 'A', content: 'B', featuredImage: 'javascript:alert(1)' }))
        ).rejects.toBeInstanceOf(DomainError);
        expect(blog.create).toHaveBeenCalledOnce();
    });

    it('changes an entry and tells it as v11 did', async () => {
        const { controller, blog } = setup();
        expect(await controller.update('abc', json({ title: 'New' }))).toEqual({
            message: 'Blog entry patched successfully',
            patchedBlog: { _id: 'x' }
        });
        expect(blog.update).toHaveBeenCalledWith('abc', { title: 'New' });
        await expect(controller.update('abc', json({ tags: 'one' }))).rejects.toBeInstanceOf(DomainError);
    });

    it('removes an entry and tells it as v11 did', async () => {
        const { controller } = setup();
        expect(await controller.remove('abc')).toEqual({
            message: 'Blog entry deleted successfully',
            deletedBlog: { _id: 'x' }
        });
    });

    it('closes everything else under /domeblog', () => {
        expect(() => setup().controller.closed()).toThrow(NotFoundError);
    });
});
