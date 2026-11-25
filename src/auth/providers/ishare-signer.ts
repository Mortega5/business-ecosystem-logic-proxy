import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

/** The base64 of each certificate of a PEM chain, with no line breaks, as the `x5c` header of a JWT wants it. */
export const certificateChain = (pem: string): string[] =>
    (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map((certificate) =>
        certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
    );

/** Signs the JWTs that an iSHARE identity provider asks the proxy for, with its key (RS256) and the chain of its certificate in `x5c`. */
export class IshareSigner {
    private readonly chain: string[];

    constructor(
        private readonly keyPem: string,
        certificatePem: string,
        private readonly now: () => number = () => Math.floor(Date.now() / 1000)
    ) {
        this.chain = certificateChain(certificatePem);
        if (this.chain.length === 0) {
            throw new Error('The certificate of the proxy has no PEM certificate');
        }
    }

    /** The signed request of the authorization: what the user asks for, so that nobody can change it on the way. */
    request(claims: { clientId: string, idpId: string, params: Record<string, string> }): string {
        const iat = this.now();
        return this.sign({
            jti: randomUUID(),
            iss: claims.clientId,
            // The user is not known yet
            sub: 'urn:TBD',
            aud: claims.idpId,
            iat,
            nbf: iat,
            exp: iat + 30,
            client_id: claims.clientId,
            language: 'en',
            acr_values: 'urn:http://eidas.europa.eu/LoA/NotNotified/high',
            ...claims.params
        });
    }

    /** The proof that the client is the one of the code, a new one for each exchange: the proxy is its own subject. */
    clientAssertion(clientId: string, idpId: string): string {
        const iat = this.now();
        return this.sign({ jti: randomUUID(), iss: clientId, sub: clientId, aud: idpId, iat, nbf: iat, exp: iat + 30 });
    }

    private sign(payload: Record<string, unknown>): string {
        return jwt.sign(payload, this.keyPem, { algorithm: 'RS256', header: { alg: 'RS256', x5c: this.chain } });
    }
}
