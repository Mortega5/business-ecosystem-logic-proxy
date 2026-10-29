import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { buildPinoOptions } from './pino-options';

@Module({
    imports: [
        LoggerModule.forRootAsync({
            inject: [AppConfigService],
            useFactory: (config: AppConfigService) => ({ pinoHttp: buildPinoOptions(config.logging) })
        })
    ]
})
export class LoggingModule {}
