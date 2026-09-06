import { Injectable } from '@nestjs/common';
import { compareSync, hash } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { RemoteStorageRepository } from 'src/repositories/remote-storage.repository';

@Injectable()
export class CryptoRepository {
  constructor(private remoteStorageRepository: RemoteStorageRepository) {}
  randomUUID(): string { return randomUUID(); }
  randomBytes(size: number) { return randomBytes(size); }
  hashBcrypt(data: string | Buffer, saltOrRounds: string | number) { return hash(data, saltOrRounds); }
  compareBcrypt(data: string | Buffer, encrypted: string) { return compareSync(data, encrypted); }
  hashSha256(value: string) { return createHash('sha256').update(value).digest(); }
  verifySha256(value: string, encryptedValue: string, publicKey: string) {
    const publicKeyBuffer = Buffer.from(publicKey, 'base64');
    const cryptoPublicKey = createPublicKey({ key: publicKeyBuffer, type: 'spki', format: 'pem' });
    const verifier = createVerify('SHA256'); verifier.update(value); verifier.end();
    return verifier.verify(cryptoPublicKey, Buffer.from(encryptedValue, 'base64'));
  }
  hashSha1(value: string | Buffer): Buffer { return createHash('sha1').update(value).digest(); }
  hashFile(filepath: string | Buffer): Promise<Buffer> {
    if (typeof filepath === 'string' && this.remoteStorageRepository.isRemotePath(filepath)) {
      return this.hashReadable(this.remoteStorageRepository.createPlainReadStream(filepath));
    }
    return this.hashReadable(createReadStream(filepath));
  }
  private async hashReadable(stream: Readable): Promise<Buffer> {
    const digest = createHash('sha1');
    return new Promise<Buffer>((resolve, reject) => {
      stream.on('error', reject); stream.on('data', (chunk) => digest.update(chunk)); stream.on('end', () => resolve(digest.digest()));
    });
  }
  randomBytesAsText(bytes: number): string { return randomBytes(bytes).toString('base64').replaceAll(/\W/g, ''); }
  signJwt(payload: string | object | Buffer, secret: string, options?: jwt.SignOptions): string { return jwt.sign(payload, secret, { algorithm: 'HS256', ...options }); }
  verifyJwt<T = any>(token: string, secret: string): T { return jwt.verify(token, secret, { algorithms: ['HS256'] }) as T; }
}
