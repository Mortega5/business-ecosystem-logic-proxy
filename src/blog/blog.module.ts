import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BlogAliasGuard } from './blog-alias.guard';
import { BlogController } from './blog.controller';
import { BlogRepository } from './blog.repository';
import { Blog, BlogSchema } from './blog.schema';
import { BlogService } from './blog.service';

/** The blog, the news and the questions: `/blog`, and `/domeblog` while the DOME extension is on. */
@Module({
    imports: [MongooseModule.forFeature([{ name: Blog.name, schema: BlogSchema }])],
    controllers: [BlogController],
    providers: [BlogRepository, BlogService, BlogAliasGuard]
})
export class BlogModule {}
