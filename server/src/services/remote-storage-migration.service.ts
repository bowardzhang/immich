import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { OnEvent } from 'src/decorators';
import { BootstrapEventPriority, ImmichWorker } from 'src/enum';
import { DB } from 'src/schema';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';

const LOCAL_PREFIXES = ['/data/', '/usr/src/app/upload/'];
const REMOTE_PREFIX = '/remote/photo-extern/';
const BATCH_SIZE = 25;

interface MigrationFile {
  assetId: string;
  kind: 'original' | 'asset-file';
  path: string;
  target: string;
  expectedSize?: number;
  expectedSha1?: string;
}

@Injectable()
export class RemoteStorageMigrationService {
  private running = false;

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private storageRepository: StorageRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(RemoteStorageMigrationService.name);
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageService + 2 })
  async onBootstrap() {
    if (process.env.REMOTE_STORAGE_MIGRATION !== 'true') return;
    if (process.env.REMOTE_STORAGE_URL === undefined || process.env.REMOTE_STORAGE_URL === '') {
      this.logger.error('Legacy media migration requested but REMOTE_STORAGE_URL is missing');
      return;
    }
    if (process.env.I_WORKER && process.env.I_WORKER !== ImmichWorker.Api) return;

    // Run only once for this process and give StorageService/bootstrap a chance to settle.
    if (this.running) return;
    this.running = true;
    setTimeout(() => void this.migrate(), 5_000).unref();
  }

  private isLocalPath(path: string): boolean {
    return LOCAL_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  private targetFor(path: string): string {
    const prefix = LOCAL_PREFIXES.find((candidate) => path.startsWith(candidate));
    if (!prefix) throw new Error(`Unsupported migration path: ${path}`);
    const relative = path.slice(prefix.length);
    return `${REMOTE_PREFIX}${relative}`;
  }

  private async collectFiles(): Promise<MigrationFile[]> {
    const originals = await this.db
      .selectFrom('asset')
      .select(['id as assetId', 'originalPath', 'checksum'])
      .where('originalPath', 'like', '/data/%')
      .execute();

    const derived = await this.db
      .selectFrom('asset_file')
      .select(['assetId', 'path'])
      .where('path', 'like', '/data/%')
      .execute();

    const files: MigrationFile[] = [];
    for (const row of originals) {
      files.push({
        assetId: row.assetId,
        kind: 'original',
        path: row.originalPath,
        target: this.targetFor(row.originalPath),
        expectedSha1: row.checksum.toString('hex'),
      });
    }
    for (const row of derived) {
      files.push({ assetId: row.assetId, kind: 'asset-file', path: row.path, target: this.targetFor(row.path) });
    }

    const unique = new Map<string, MigrationFile>();
    for (const file of files) unique.set(`${file.assetId}:${file.kind}:${file.path}`, file);
    return [...unique.values()];
  }

  private async copyAndVerify(file: MigrationFile): Promise<{ size: number; sha1: string }> {
    const sourceStat = await this.storageRepository.stat(file.path);
    if (!sourceStat.isFile()) throw new Error(`Source is not a regular file: ${file.path}`);

    const hash = createHash('sha1');
    let size = 0;
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const source = this.storageRepository.createPlainReadStream(file.path);
    const target = this.storageRepository.createWriteStream(file.target);
    await pipeline(source, digest, target);

    const sha1 = hash.digest('hex');
    const targetStat = await this.storageRepository.stat(file.target);
    if (targetStat.size !== sourceStat.size || size !== sourceStat.size) {
      throw new Error(`Size verification failed for ${file.path}: source=${sourceStat.size}, copied=${size}, target=${targetStat.size}`);
    }
    if (file.expectedSha1 && sha1 !== file.expectedSha1) {
      throw new Error(`Source checksum mismatch for ${file.path}: DB=${file.expectedSha1}, source=${sha1}`);
    }

    // Read back the remote object and verify the bytes actually stored by the router.
    const remoteHash = createHash('sha1');
    let remoteSize = 0;
    for await (const chunk of this.storageRepository.createPlainReadStream(file.target)) {
      remoteHash.update(chunk as Buffer);
      remoteSize += (chunk as Buffer).length;
    }
    const remoteSha1 = remoteHash.digest('hex');
    if (remoteSize !== sourceStat.size || remoteSha1 !== sha1) {
      throw new Error(`Remote checksum verification failed for ${file.path}: source=${sha1}, remote=${remoteSha1}, size=${remoteSize}`);
    }

    return { size: sourceStat.size, sha1 };
  }

  private async updateDatabase(file: MigrationFile): Promise<void> {
    if (file.kind === 'original') {
      await this.db.updateTable('asset').set({ originalPath: file.target }).where('id', '=', file.assetId).execute();
    } else {
      await this.db.updateTable('asset_file').set({ path: file.target }).where('assetId', '=', file.assetId).where('path', '=', file.path).execute();
    }
  }

  private async migrate() {
    try {
      const files = await this.collectFiles();
      const totalBytes = files.reduce((sum, file) => sum + (file.expectedSize ?? 0), 0);
      this.logger.log(`Legacy media migration discovered ${files.length} database-referenced local files`);

      let completed = 0;
      let failed = 0;
      let bytes = 0;

      for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
        const batch = files.slice(offset, offset + BATCH_SIZE);
        for (const file of batch) {
          try {
            const result = await this.copyAndVerify(file);
            await this.updateDatabase(file);
            await this.storageRepository.unlink(file.path);
            completed++;
            bytes += result.size;
            if (completed % 10 === 0 || completed === files.length) {
              this.logger.log(`Legacy media migration progress: ${completed}/${files.length} files, ${bytes} bytes migrated`);
            }
          } catch (error) {
            failed++;
            this.logger.error(`Legacy media migration FAILED for ${file.path}: ${(error as Error).message}`);
            // Never delete a local source after an unsuccessful copy/verification/DB update.
          }
        }
      }

      this.logger.log(`Legacy media migration finished: completed=${completed}, failed=${failed}, bytes=${bytes}, plannedBytes=${totalBytes}`);
      if (failed === 0) this.logger.log('Legacy media migration COMPLETE: all referenced local media were verified and moved');
      else this.logger.warn(`Legacy media migration INCOMPLETE: ${failed} files remain on local storage and must be retried`);
    } catch (error) {
      this.logger.error(`Legacy media migration aborted: ${(error as Error).message}`, (error as Error).stack);
    } finally {
      this.running = false;
    }
  }
}
