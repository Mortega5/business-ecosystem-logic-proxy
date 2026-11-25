import { z } from 'zod';
import { CONTENT_TYPES, type ContentType } from './blog.schema';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TAG = 50;

const trimmed = z.string().transform((value) => value.trim());

/** A text that is required: it has something in it once trimmed. */
const required = (max: number) => trimmed.pipe(z.string().min(1).max(max));

/** A text that may be left out; an empty one (or only spaces) says that there is none, and is `null`. */
const optional = (max: number) =>
    trimmed
        .pipe(z.string().max(max))
        .transform((value) => (value === '' ? null : value))
        .optional();

const slug = trimmed
    .pipe(
        z
            .string()
            .refine(
                (value) => value === '' || SLUG.test(value),
                'Slug must follow the format: lowercase letters/numbers separated by hyphens'
            )
    )
    .transform((value) => (value === '' ? null : value))
    .optional();

const featuredImage = trimmed
    .pipe(
        z
            .string()
            .max(2000)
            .refine(
                (value) => value === '' || (/^https?:\/\//i.test(value) && URL.canParse(value)),
                'featuredImage must be a valid URL'
            )
    )
    .transform((value) => (value === '' ? null : value))
    .optional();

const date = z
    .union([z.string().min(1), z.number()])
    .refine((value) => !Number.isNaN(new Date(value).getTime()), 'date must be a valid date')
    .transform((value) => new Date(value))
    .optional();

const tags = z
    .array(trimmed.pipe(z.string().max(MAX_TAG)))
    .max(50)
    .transform((list) => list.filter((tag) => tag !== ''))
    .optional();

const fields = {
    title: required(300),
    content: required(1_000_000),
    contentType: z.enum(CONTENT_TYPES).optional(),
    slug,
    featuredImage,
    metaDescription: optional(160),
    excerpt: optional(300),
    author: optional(200),
    partyId: optional(200),
    tags,
    date
};

// What is not in the list is ignored, as v11 did: the portal sends the entry as it has it
/** What an administrator sends to make an entry: a title and a content, and the rest as they like. */
export const newBlogForm = z.object(fields);

/** What is sent to change an entry: any of the fields. */
export const blogChangeForm = z.object(fields).partial();

export type NewBlogForm = z.infer<typeof newBlogForm>;
export type BlogChangeForm = z.infer<typeof blogChangeForm>;

/** What the client is told of an entry. */
export interface BlogView {
    _id: string;
    title: string;
    contentType: ContentType;
    slug?: string;
    featuredImage?: string;
    metaDescription?: string;
    excerpt?: string;
    author?: string;
    partyId?: string;
    tags: string[];
    date: string;
    content: string;
}

/** A Mongo ObjectId, which is what the portal calls the id of an entry. */
export const OBJECT_ID = /^[0-9a-f]{24}$/i;
