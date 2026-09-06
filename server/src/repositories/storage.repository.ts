import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import chokidar, { ChokidarOptions } from 'chokidar';
import { escapePath, glob, globStream } from 'fast-glob';
import {
  constants,
  createReadStream,
  createWriteStream,
  Dirent,
  existsSync,
  mkdirSync,
  ReadOptionsWithBuffer,
  watch,
} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { RemoteStorageRepository } from 'src/repositories/remote-storage.repository';
import { mimeTypes } from 'src/utils/mime-types';

export interface WatchEvents {
  onReady(): void;
  onAdd(path: string): void;
  onChange(path: string): void;
  onUnlink(path: string): void;
  onError(error: Error): void;
}

export interface ImmichReadStream {
  stream: Readable;
  type?: string;
  length?: number;
}

export interface ImmichZipStream extends ImmichReadStream {
  addFile: (inputPath: string, filename: string) => void;
  finalize: () => Promise<void>;
}

export interface DiskUsage {
  available: number;
  free: number;
  total: number;
}

@Injectable()
export class StorageRepository {
  constructor(
    private logger: LoggingRepository,
    private remoteStorageRepository: RemoteStorageRepository,
  ) {
    this.logger.setContext(StorageRepository.name);
  }

  realpath(filepath: string) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      return this.remoteStorageRepository.realpath(filepath);
    }
    return fs.realpath(filepath);
  }

  readdir(folder: string): Promise<string[]> {
    if (this.remoteStorageRepository.isRemotePath(folder)) {
      return this.remoteStorageRepository.readdir(folder);
    }
    return fs.readdir(folder);
  }

  readdirWithTypes(folder: string): Promise<Dirent[]> {
    if (this.remoteStorageRepository.isRemotePath(folder)) {
      return this.remoteStorageRepository.readdirWithTypes(folder) as Promise<Dirent[]>;
    }
    return fs.readdir(folder, { withFileTypes: true });
  }

  copyFile(source: string, target: string) {
    if (this.remoteStorageRepository.isRemotePath(source) || this.remoteStorageRepository.isRemotePath(target)) {
      throw new Error('Remote external library files are read-only');
    }
    return fs.copyFile(source, target);
  }

  stat(filepath: string) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      return this.remoteStorageRepository.stat(filepath);
    }
    return fs.stat(filepath);
  }

  createFile(filepath: string, buffer: Buffer) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      throw new Error('Remote external library files are read-only');
    }
    return fs.writeFile(filepath, buffer, { flag: 'wx' });
  }

  createWriteStream(filepath: string): Writable {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      throw new Error('Remote external library files are read-only');
    }
    return createWriteStream(filepath, { flags: 'w', flush: true });
  }

  createOrOverwriteFile(filepath: string, buffer: Buffer) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      throw new Error('Remote external library files are read-only');
    }
    return fs.writeFile(filepath, buffer, { flag: 'w' });
  }

  overwriteFile(filepath: string, buffer: Buffer) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      throw new Error('Remote external library files are read-only');
    }
    return fs.writeFile(filepath, buffer, { flag: 'r+' });
  }

  rename(source: string, target: string) {
    if (this.remoteStorageRepository.isRemotePath(source) || this.remoteStorageRepository.isRemotePath(target)) {
      throw new Error('Remote external library files are read-only');
    }
    return fs.rename(source, target);
  }

  utimes(filepath: string, atime: Date, mtime: Date) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      throw new Error('Remote external library files are read-only');
    }
    return fs.utimes(filepath, atime, mtime);
  }

  createZipStream(): ImmichZipStream {
    const archive = archiver('zip', { store: true });

    const addFile = (input: string, filename: string) => {
      if (this.remoteStorageRepository.isRemotePath(input)) {
        throw new Error('Remote external library downloads are not supported yet');
      }
      archive.file(input, { name: filename, mode: 0o644 });
    };

    const finalize = () => archive.finalize();

    return { stream: archive, addFile, finalize };
  }

  createGzip(): PassThrough {
    return createGzip();
  }

  createGunzip(): PassThrough {
    return createGunzip();
  }

  createPlainReadStream(filepath: string): Readable {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      return this.remoteStorageRepository.createPlainReadStream(filepath);
    }
    return createReadStream(filepath);
  }

  async createReadStream(filepath: string, mimeType?: string | null): Promise<ImmichReadStream> {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      return this.remoteStorageRepository.createReadStream(filepath, mimeType);
    }

    const { size } = await fs.stat(filepath);
    await fs.access(filepath, constants.R_OK);
    return {
      stream: createReadStream(filepath),
      length: size,
      type: mimeType || undefined,
    };
  }

  async readFile(filepath: string, options?: ReadOptionsWithBuffer<Buffer>): Promise<Buffer> {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      if (options) {
        throw new Error('Remote external library ranged reads are not supported yet');
      }
      return this.remoteStorageRepository.readFile(filepath);
    }

    if (options) {
      const file = await fs.open(filepath);
      try {
        const { buffer } = await file.read(options);
        return buffer as Buffer;
      } finally {
        await file.close();
      }
    }

    return fs.readFile(filepath);
  }

  async readJsonFile<T>(filepath: string): Promise<T> {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      const file = await this.remoteStorageRepository.readFile(filepath);
      return JSON.parse(file.toString('utf8')) as T;
    }

    const file = await fs.readFile(filepath, 'utf8');
    return JSON.parse(file) as T;
  }

  async checkFileExists(filepath: string, mode = constants.F_OK): Promise<boolean> {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      return this.remoteStorageRepository.checkFileExists(filepath, mode);
    }

    try {
      await fs.access(filepath, mode);
      return true;
    } catch {
      return false;
    }
  }

  async unlink(file: string) {
    if (this.remoteStorageRepository.isRemotePath(file)) {
      throw new Error('Remote external library files are read-only');
    }

    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.logger.warn(`File ${file} does not exist.`);
      } else {
        throw error;
      }
    }
  }

  async unlinkDir(folder: string, options: { recursive?: boolean; force?: boolean }) {
    if (this.remoteStorageRepository.isRemotePath(folder)) {
      throw new Error('Remote external library files are read-only');
    }
    await fs.rm(folder, { ...options, maxRetries: 5, retryDelay: 100 });
  }

  async removeEmptyDirs(directory: string, self: boolean = false) {
    if (this.remoteStorageRepository.isRemotePath(directory)) {
      throw new Error('Remote external library files are read-only');
    }

    const stats = await fs.lstat(directory);
    if (!stats.isDirectory()) {
      return;
    }

    const files = await fs.readdir(directory);
    await Promise.all(files.map((file) => this.removeEmptyDirs(path.join(directory, file), true)));

    if (self) {
      const updated = await fs.readdir(directory);
      if (updated.length === 0) {
        try {
          await fs.rmdir(directory);
        } catch (error: Error | any) {
          if (error.code !== 'ENOTEMPTY') {
            this.logger.warn(`Attempted to remove directory, but failed: ${error}`);
          }
        }
      }
    }
  }

  mkdirSync(filepath: string): void {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      throw new Error('Remote external library files are read-only');
    }
    if (!existsSync(filepath)) {
      mkdirSync(filepath, { recursive: true });
    }
  }

  existsSync(filepath: string) {
    if (this.remoteStorageRepository.isRemotePath(filepath)) {
      return false;
    }
    return existsSync(filepath);
  }

  async checkDiskUsage(folder: string): Promise<DiskUsage> {
    return fs.statfs(folder).then((stats) => ({
      available: stats.bavail * stats.bsize,
      free: stats.bfree * stats.bsize,
      total: stats.blocks * stats.bsize,
    }));
  }

  crawl(crawlOptions: CrawlOptionsDto): Promise<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden } = crawlOptions;
    if (pathsToCrawl.length === 0) {
      return Promise.resolve([]);
    }

    const remotePaths = pathsToCrawl.filter((crawlPath) => this.remoteStorageRepository.isRemotePath(crawlPath));
    const localPaths = pathsToCrawl.filter((crawlPath) => !this.remoteStorageRepository.isRemotePath(crawlPath));

    if (remotePaths.length > 0 && localPaths.length > 0) {
      return Promise.all([
        this.remoteStorageRepository.crawl({ pathsToCrawl: remotePaths, exclusionPatterns, includeHidden }),
        glob(
          localPaths.map((crawlPath) => this.asGlob(crawlPath)),
          { absolute: true, caseSensitiveMatch: false, onlyFiles: true, dot: includeHidden, ignore: exclusionPatterns },
        ),
      ]).then(([remote, local]) => [...remote, ...local]);
    }

    if (remotePaths.length > 0) {
      return this.remoteStorageRepository.crawl({ pathsToCrawl: remotePaths, exclusionPatterns, includeHidden });
    }

    const globbedPaths = localPaths.map((crawlPath) => this.asGlob(crawlPath));
    return glob(globbedPaths, {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: includeHidden,
      ignore: exclusionPatterns,
    });
  }

  async *walk(walkOptions: WalkOptionsDto): AsyncGenerator<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden } = walkOptions;
    if (pathsToCrawl.length === 0) {
      return;
    }

    const remotePaths = pathsToCrawl.filter((crawlPath) => this.remoteStorageRepository.isRemotePath(crawlPath));
    const localPaths = pathsToCrawl.filter((crawlPath) => !this.remoteStorageRepository.isRemotePath(crawlPath));

    if (remotePaths.length > 0) {
      for await (const batch of this.remoteStorageRepository.walk({
        ...walkOptions,
        pathsToCrawl: remotePaths,
      })) {
        yield batch;
      }
    }

    if (localPaths.length === 0) {
      return;
    }

    const globbedPaths = localPaths.map((crawlPath) => this.asGlob(crawlPath));
    const stream = globStream(globbedPaths, {
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      dot: includeHidden,
      ignore: exclusionPatterns,
    });

    let batch: string[] = [];
    for await (const value of stream) {
      batch.push(value.toString());
      if (batch.length === walkOptions.take) {
        yield batch;
        batch = [];
      }
    }

    if (batch.length > 0) {
      yield batch;
    }
  }

  watch(paths: string[], options: ChokidarOptions, events: Partial<WatchEvents>) {
    if (paths.some((watchPath) => this.remoteStorageRepository.isRemotePath(watchPath))) {
      throw new Error('Remote external library watching is not supported yet; disable library watching for remote libraries');
    }

    const watcher = chokidar.watch(paths, options);

    watcher.on('ready', () => events.onReady?.());
    watcher.on('add', (path) => events.onAdd?.(path));
    watcher.on('change', (path) => events.onChange?.(path));
    watcher.on('unlink', (path) => events.onUnlink?.(path));
    watcher.on('error', (error) => events.onError?.(error as Error));

    return () => watcher.close();
  }

  watchDir = watch;

  private asGlob(pathToCrawl: string): string {
    const escapedPath = escapePath(pathToCrawl).replaceAll('"', '["]').replaceAll("'", "[']").replaceAll('`', '[`]');
    const extensions = `*{${mimeTypes.getSupportedFileExtensions().join(',')}}`;
    return `${escapedPath}/**/${extensions}`;
  }
}
