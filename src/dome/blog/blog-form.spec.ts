import { describe, expect, it } from 'vitest';
import { blogChangeForm, newBlogForm } from './blog-form';

const valid = { title: ' A title ', content: ' <p>Text</p> ' };

describe('the form of a blog entry', () => {
    it('needs a title and a content, which it trims, and takes the rest as they come', () => {
        const form = newBlogForm.parse({
            ...valid,
            slug: ' my-slug ',
            contentType: 'news',
            tags: [' one ', '', 'two'],
            date: '2026-01-02T03:04:05.000Z',
            author: ' Ana '
        });
        expect(form).toMatchObject({
            title: 'A title',
            content: '<p>Text</p>',
            slug: 'my-slug',
            contentType: 'news',
            tags: ['one', 'two'],
            author: 'Ana'
        });
        expect(form.date?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
        expect(newBlogForm.safeParse({ title: '  ', content: 'x' }).success).toBe(false);
        expect(newBlogForm.safeParse({ title: 'x' }).success).toBe(false);
    });

    it('ignores what it does not know, as v11 did', () => {
        expect(newBlogForm.parse({ ...valid, _id: 'x', __v: 3, slugNormalized: 'y' })).not.toHaveProperty('_id');
    });

    it('takes an optional text that is empty as none, so that a change can remove it', () => {
        const form = blogChangeForm.parse({ metaDescription: '   ', slug: '', featuredImage: '' });
        expect(form).toMatchObject({ metaDescription: null, slug: null, featuredImage: null });
        expect(blogChangeForm.parse({})).toEqual({});
    });

    it('refuses a slug that is not lowercase letters and digits with hyphens', () => {
        for (const slug of ['Upper', 'with space', 'a--b', '-a', 'a_b']) {
            expect(newBlogForm.safeParse({ ...valid, slug }).success).toBe(false);
        }
    });

    it('refuses an image that is not an http or https address, a content type that is not one, and a date that is not one', () => {
        for (const featuredImage of [
            'javascript:alert(1)',
            'data:text/html,x',
            'ftp://x.example.org/a.png',
            'not a url'
        ]) {
            expect(newBlogForm.safeParse({ ...valid, featuredImage }).success).toBe(false);
        }
        expect(newBlogForm.safeParse({ ...valid, featuredImage: 'https://img.example.org/a.png' }).success).toBe(true);
        expect(newBlogForm.safeParse({ ...valid, contentType: 'page' }).success).toBe(false);
        expect(newBlogForm.safeParse({ ...valid, date: 'tomorrow-ish' }).success).toBe(false);
    });

    it('limits the description, the excerpt and each tag', () => {
        expect(newBlogForm.safeParse({ ...valid, metaDescription: 'x'.repeat(161) }).success).toBe(false);
        expect(newBlogForm.safeParse({ ...valid, excerpt: 'x'.repeat(301) }).success).toBe(false);
        expect(newBlogForm.safeParse({ ...valid, tags: ['x'.repeat(51)] }).success).toBe(false);
        expect(newBlogForm.safeParse({ ...valid, tags: 'one' }).success).toBe(false);
    });
});
