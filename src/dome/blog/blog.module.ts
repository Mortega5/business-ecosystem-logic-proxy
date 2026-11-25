import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DomeEnabledGuard } from '../dome-enabled.guard';
import { BlogController } from './blog.controller';
import { BlogRepository } from './blog.repository';
import { Blog, BlogSchema } from './blog.schema';
import { BlogService } from './blog.service';

/** The blog of DOME: `/domeblog`. */
@Module({
    imports: [MongooseModule.forFeature([{ name: Blog.name, schema: BlogSchema }])],
    controllers: [BlogController],
    providers: [BlogRepository, BlogService, DomeEnabledGuard]
})
export class BlogModule {}
