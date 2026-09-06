import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OnEvent } from 'src/decorators';
import { BootstrapEventPriority } from 'src/enum';
import { RemoteStorageRepository } from 'src/repositories/remote-storage.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';

@Injectable()
export class RemoteStorageTestService {
  constructor(
    private remoteStorageRepository: RemoteStorageRepository,
    private storageRepository: StorageRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(RemoteStorageTestService.name);
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageService + 1 })
  async onBootstrap() {
    if (process.env.REMOTE_STORAGE_CANARY !== 'true') return;
    if (!process.env.REMOTE_STORAGE_URL) {
      this.logger.warn('REMOTE_STORAGE_CANARY is enabled but REMOTE_STORAGE_URL is missing');
      return;
    }

    const id = randomUUID();
    const root = '/remote/photo-extern/.immich-router-canary';
    const source = `${root}/${id}.bin`;
    const renamed = `${root}/${id}-renamed.bin`;
    const copied = `${root}/${id}-copied.bin`;
    const payload = Buffer.from(`immich-remote-canary:${id}:` + '0123456789abcdef'.repeat(256));

    try {
      await this.storageRepository.createFile(source, payload);
      const readBack = await this.storageRepository.readFile(source);
      if (!readBack.equals(payload)) throw new Error('read-back content mismatch');

      const stat = await this.storageRepository.stat(source);
      if (stat.size !== payload.length) throw new Error(`stat size mismatch: ${stat.size} !== ${payload.length}`);

      await this.storageRepository.rename(source, renamed);
      if (!(await this.storageRepository.checkFileExists(renamed))) throw new Error('rename target missing');

      await this.storageRepository.copyFile(renamed, copied);
      if (!(await this.storageRepository.checkFileExists(copied))) throw new Error('copy target missing');

      const listed = await this.storageRepository.readdir(root);
      if (!listed.includes(`${id}-renamed.bin`) || !listed.includes(`${id}-copied.bin`)) {
        throw new Error('readdir did not return canary files');
      }

      await this.storageRepository.unlink(renamed);
      await this.storageRepository.unlink(copied);
      this.logger.log(`Remote storage canary PASS (${id})`);
    } catch (error) {
      this.logger.error(`Remote storage canary FAIL: ${(error as Error).message}`);
      try {
        await this.storageRepository.unlink(source);
        await this.storageRepository.unlink(renamed);
        await this.storageRepository.unlink(copied);
      } catch (cleanupError) {
        this.logger.warn(`Remote storage canary cleanup failed: ${(cleanupError as Error).message}`);
      }
    }
  }
}
