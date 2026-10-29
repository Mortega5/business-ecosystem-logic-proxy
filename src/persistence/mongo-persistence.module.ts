import { Global, Module } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import mongoose from 'mongoose';
import { MongoConnectionService } from './mongo-connection.service';

// The connection is created unopened: MongoConnectionService opens it in the background and keeps
// retrying, so the server starts (and can report it is not ready) while Mongo is down.
@Global()
@Module({
    providers: [{ provide: getConnectionToken(), useFactory: () => mongoose.createConnection() }, MongoConnectionService],
    exports: [getConnectionToken(), MongoConnectionService]
})
export class MongoPersistenceModule {}
