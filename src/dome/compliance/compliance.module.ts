import { Module } from '@nestjs/common';
import { TmfModule } from '../../tmf/tmf.module';
import { CertificateController } from './certificate.controller';
import { CertificateService } from './certificate.service';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';

/** The compliance certificate that a seller asks for, and the credential that a certifier uploads for a product. */
@Module({
    imports: [TmfModule],
    controllers: [ComplianceController, CertificateController],
    providers: [ComplianceService, CertificateService]
})
export class ComplianceModule {}
