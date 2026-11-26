import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { buildPinoOptions } from './pino-options';

@Module({
    imports: [
        LoggerModule.forRootAsync({
            inject: [AppConfigService],
            // The actor that the guard assigns goes also to the access line, which is written when the response ends
            useFactory: (config: AppConfigService) => ({ pinoHttp: buildPinoOptions(config.logging), assignResponse: true })
        })
    ]
})
export class LoggingModule {}
