import { All, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { NotFoundError } from '../common/domain-error';
import { AdministratorGuard } from '../tmf/administrator.guard';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { parseRequest } from '../tmf/schemas/parse';
import { RequireFeature } from '../features/require-feature';
import { BlogAliasGuard } from './blog-alias.guard';
import { blogChangeForm, newBlogForm, type BlogView } from './blog-form';
import { BlogService } from './blog.service';

/**
 * The blog, the news and the questions of the marketplace. Anybody reads them, and only an administrator writes them.
 * It is at `/blog`, and also at `/domeblog` while the DOME extension is on. Anything else under either is closed.
 */
@RequireFeature('blog')
@UseGuards(BlogAliasGuard)
@UseInterceptors(BodyTextInterceptor)
@Controller(['blog', 'domeblog'])
export class BlogController {
    constructor(private readonly blog: BlogService) {}

    // The portal asks with `contentType`, `page` and `limit`, as it did of v11, which gave all the entries whatever it asked for
    @Public()
    @Get()
    list(): Promise<BlogView[]> {
        return this.blog.list();
    }

    @Public()
    @Get(':id')
    get(@Param('id') id: string): Promise<BlogView> {
        return this.blog.get(id);
    }

    @UseGuards(AdministratorGuard)
    @Post()
    @HttpCode(201)
    async create(@Body(JsonObjectBodyPipe) body: string): Promise<BlogView> {
        return this.blog.create(parseRequest(newBlogForm, JSON.parse(body), 'Validation failed'));
    }

    @UseGuards(AdministratorGuard)
    @Patch(':id')
    async update(@Param('id') id: string, @Body(JsonObjectBodyPipe) body: string): Promise<{ message: string; patchedBlog: BlogView }> {
        const patchedBlog = await this.blog.update(id, parseRequest(blogChangeForm, JSON.parse(body), 'Validation failed'));
        return { message: 'Blog entry patched successfully', patchedBlog };
    }

    @UseGuards(AdministratorGuard)
    @Delete(':id')
    async remove(@Param('id') id: string): Promise<{ message: string; deletedBlog: BlogView }> {
        const deletedBlog = await this.blog.remove(id);
        return { message: 'Blog entry deleted successfully', deletedBlog };
    }

    // Nothing else is under /blog or /domeblog
    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
