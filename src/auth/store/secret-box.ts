import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Encrypts what must not be readable in the database, the refresh tokens above all. AES-256-GCM, a new IV each time, and
 * the key is the SHA-256 of the secret, which has to be a random string of its own, not a password.
 */
export class SecretBox {
    private readonly key: Buffer;

    constructor(secret: string) {
        this.key = createHash('sha256').update(secret).digest();
    }

    seal(plain: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
    }

    /** The text, or undefined when it was not sealed with this secret (it was changed) or has been altered. */
    open(sealed: string): string | undefined {
        const [version, iv, tag, encrypted] = sealed.split('.');
        if (version !== VERSION || iv === undefined || tag === undefined || encrypted === undefined) {
            return undefined;
        }
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
            decipher.setAuthTag(Buffer.from(tag, 'base64'));
            return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
        } catch {
            return undefined;
        }
    }
}
