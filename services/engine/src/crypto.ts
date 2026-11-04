import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export class SecretBox {
  private key: Buffer;
  constructor(hex: string) { this.key = Buffer.from(hex, 'hex'); if (this.key.length !== 32) throw new Error('Invalid encryption key'); }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(value: string, context: string): unknown {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  }
}
