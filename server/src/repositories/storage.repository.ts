import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import chokidar, { ChokidarOptions } from 'chokidar';
import { escapePath, glob, globStream } from 'fast-glob';
import { constants, createReadStream, createWriteStream, Dirent, existsSync, mkdirSync, ReadOptionsWithBuffer } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { RemoteStorageRepository } from 'src/repositories/remote-storage.repository';
import { mimeTypes } from 'src/utils/mime-types';

export interface WatchEvents { onReady(): void; onAdd(path: string): void; onChange(path: string): void; onUnlink(path: string): void; onError(error: Error): void; }
export interface ImmichReadStream { stream: Readable; type?: string; length?: number; }
export interface ImmichZipStream extends ImmichReadStream { addFile: (inputPath: string, filename: string) => void; finalize: () => Promise<void>; }
export interface DiskUsage { available: number; free: number; total: number; }

@Injectable()
export class StorageRepository {
  constructor(private logger: LoggingRepository, private remoteStorageRepository: RemoteStorageRepository) { this.logger.setContext(StorageRepository.name); }
  realpath(filepath: string) { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.realpath(filepath) : fs.realpath(filepath); }
  readdir(folder: string): Promise<string[]> { return this.remoteStorageRepository.isRemotePath(folder) ? this.remoteStorageRepository.readdir(folder) : fs.readdir(folder); }
  readdirWithTypes(folder: string): Promise<Dirent[]> { return this.remoteStorageRepository.isRemotePath(folder) ? this.remoteStorageRepository.readdirWithTypes(folder) as Promise<Dirent[]> : fs.readdir(folder, { withFileTypes: true }); }
  copyFile(source: string, target: string) {
    if (this.remoteStorageRepository.isRemotePath(source)) {
      if (this.remoteStorageRepository.isRemotePath(target)) return this.remoteStorageRepository.copyFile(source, target);
      return new Promise<void>((resolve, reject) => this.remoteStorageRepository.createPlainReadStream(source).then((stream) => { const output = createWriteStream(target); stream.pipe(output).on('finish', resolve).on('error', reject); }).catch(reject));
    }
    if (this.remoteStorageRepository.isRemotePath(target)) return new Promise<void>((resolve, reject) => { const input = createReadStream(source); const output = this.remoteStorageRepository.createWriteStream(target); input.pipe(output).on('finish', resolve).on('error', reject); });
    return fs.copyFile(source, target);
  }
  stat(filepath: string) { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.stat(filepath) : fs.stat(filepath); }
  createFile(filepath: string, buffer: Buffer) { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.createFile(filepath, buffer) : fs.writeFile(filepath, buffer, { flag: 'wx' }); }
  createWriteStream(filepath: string): Writable { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.createWriteStream(filepath) : createWriteStream(filepath, { flags: 'w', flush: true }); }
  createOrOverwriteFile(filepath: string, buffer: Buffer) { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.createOrOverwriteFile(filepath, buffer) : fs.writeFile(filepath, buffer, { flag: 'w' }); }
  overwriteFile(filepath: string, buffer: Buffer) { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.overwriteFile(filepath, buffer) : fs.writeFile(filepath, buffer, { flag: 'r+' }); }
  rename(source: string, target: string) { if (this.remoteStorageRepository.isRemotePath(source) && this.remoteStorageRepository.isRemotePath(target)) return this.remoteStorageRepository.rename(source, target); if (this.remoteStorageRepository.isRemotePath(source)) return this.copyFile(source, target).then(() => this.unlink(source)); if (this.remoteStorageRepository.isRemotePath(target)) return this.copyFile(source, target).then(() => this.unlink(source)); return fs.rename(source, target); }
  utimes(filepath: string, atime: Date, mtime: Date) { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.utimes(filepath, atime, mtime) : fs.utimes(filepath, atime, mtime); }
  createZipStream(): ImmichZipStream {
    const archive = archiver('zip', { store: true });
    const pending: Promise<void>[] = [];
    const addFile = (input: string, filename: string) => {
      if (!this.remoteStorageRepository.isRemotePath(input)) { archive.file(input, { name: filename, mode: 0o644 }); return; }
      const passThrough = new PassThrough();
      archive.append(passThrough, { name: filename, mode: 0o644 });
      const pendingRead = this.remoteStorageRepository.createPlainReadStream(input).then((stream) => new Promise<void>((resolve, reject) => { stream.on('error', reject); passThrough.on('error', reject); passThrough.on('finish', resolve); stream.pipe(passThrough); }));
      pending.push(pendingRead);
    };
    const finalize = async () => { await Promise.all(pending); await archive.finalize(); };
    return { stream: archive, addFile, finalize };
  }
  createGzip(): PassThrough { return createGzip(); }
  createGunzip(): PassThrough { return createGunzip(); }
  createPlainReadStream(filepath: string): Readable { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.createPlainReadStream(filepath) : createReadStream(filepath); }
  async createReadStream(filepath: string, mimeType?: string | null): Promise<ImmichReadStream> { if (this.remoteStorageRepository.isRemotePath(filepath)) return this.remoteStorageRepository.createReadStream(filepath, mimeType); const { size } = await fs.stat(filepath); await fs.access(filepath, constants.R_OK); return { stream: createReadStream(filepath), length: size, type: mimeType || undefined }; }
  async readFile(filepath: string, options?: ReadOptionsWithBuffer<Buffer>): Promise<Buffer> { if (this.remoteStorageRepository.isRemotePath(filepath)) { if (options) throw new Error('Remote external library ranged reads are not supported yet'); return this.remoteStorageRepository.readFile(filepath); } if (options) { const file = await fs.open(filepath); try { const { buffer } = await file.read(options); return buffer as Buffer; } finally { await file.close(); } } return fs.readFile(filepath); }
  async readJsonFile<T>(filepath: string): Promise<T> { const file = await this.readFile(filepath); return JSON.parse(file.toString('utf8')) as T; }
  async checkFileExists(filepath: string, mode = constants.F_OK): Promise<boolean> { return this.remoteStorageRepository.isRemotePath(filepath) ? this.remoteStorageRepository.checkFileExists(filepath, mode) : fs.access(filepath, mode).then(() => true).catch(() => false); }
  async unlink(file: string) { if (this.remoteStorageRepository.isRemotePath(file)) { try { await this.remoteStorageRepository.unlink(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } return; } try { await fs.unlink(file); } catch (error: any) { if (error?.code === 'ENOENT') this.logger.warn(`File ${file} does not exist.`); else throw error; } }
  async unlinkDir(folder: string, options: { recursive?: boolean; force?: boolean }) { if (this.remoteStorageRepository.isRemotePath(folder)) throw new Error('Remote directory deletion is not supported'); await fs.rm(folder, { ...options, maxRetries: 5, retryDelay: 100 }); }
  async removeEmptyDirs(directory: string, self = false) { if (this.remoteStorageRepository.isRemotePath(directory)) return; const stats = await fs.lstat(directory); if (!stats.isDirectory()) return; const files = await fs.readdir(directory); await Promise.all(files.map((file) => this.removeEmptyDirs(path.join(directory, file), true))); if (self && (await fs.readdir(directory)).length === 0) { try { await fs.rmdir(directory); } catch (error: any) { if (error.code !== 'ENOTEMPTY') this.logger.warn(`Attempted to remove directory, but failed: ${error}`); } } }
  mkdirSync(filepath: string): void { if (this.remoteStorageRepository.isRemotePath(filepath)) return; if (!existsSync(filepath)) mkdirSync(filepath, { recursive: true }); }
  existsSync(filepath: string) { return this.remoteStorageRepository.isRemotePath(filepath) ? true : existsSync(filepath); }
  async checkDiskUsage(folder: string): Promise<DiskUsage> { if (this.remoteStorageRepository.isRemotePath(folder)) { const baseUrl = (process.env.REMOTE_STORAGE_URL || '').replace(/\/$/, ''); const response = await fetch(`${baseUrl}/api/storage`, { headers: process.env.REMOTE_STORAGE_TOKEN ? { Authorization: `Bearer ${process.env.REMOTE_STORAGE_TOKEN}` } : {} }); if (!response.ok) throw new Error(`Remote storage disk usage request failed: ${response.status}`); const data = await response.json() as { availableBytes: number; freeBytes: number; totalBytes: number }; return { available: data.availableBytes, free: data.freeBytes, total: data.totalBytes }; } const stats = await fs.statfs(folder); return { available: stats.bavail * stats.bsize, free: stats.bfree * stats.bsize, total: stats.blocks * stats.bsize }; }
  crawl(crawlOptions: CrawlOptionsDto): Promise<string[]> { const { pathsToCrawl, exclusionPatterns, includeHidden } = crawlOptions; if (pathsToCrawl.length === 0) return Promise.resolve([]); const remotePaths = pathsToCrawl.filter((crawlPath) => this.remoteStorageRepository.isRemotePath(crawlPath)); const localPaths = pathsToCrawl.filter((crawlPath) => !this.remoteStorageRepository.isRemotePath(crawlPath)); if (remotePaths.length && localPaths.length) return Promise.all([this.remoteStorageRepository.crawl({ pathsToCrawl: remotePaths, exclusionPatterns, includeHidden }), glob(localPaths.map((crawlPath) => this.asGlob(crawlPath)), { absolute: true, caseSensitiveMatch: false, onlyFiles: true, dot: includeHidden, ignore: exclusionPatterns })]).then(([remote, local]) => [...remote, ...local]); if (remotePaths.length) return this.remoteStorageRepository.crawl({ pathsToCrawl: remotePaths, exclusionPatterns, includeHidden }); return glob(localPaths.map((crawlPath) => this.asGlob(crawlPath)), { absolute: true, caseSensitiveMatch: false, onlyFiles: true, dot: includeHidden, ignore: exclusionPatterns }); }
  async *walk(walkOptions: WalkOptionsDto): AsyncGenerator<string[]> { const { pathsToCrawl, exclusionPatterns, includeHidden } = walkOptions; if (pathsToCrawl.length === 0) return; const remotePaths = pathsToCrawl.filter((crawlPath) => this.remoteStorageRepository.isRemotePath(crawlPath)); const localPaths = pathsToCrawl.filter((crawlPath) => !this.remoteStorageRepository.isRemotePath(crawlPath)); if (remotePaths.length) for await (const batch of this.remoteStorageRepository.walk({ ...walkOptions, pathsToCrawl: remotePaths })) yield batch; if (!localPaths.length) return; const stream = globStream(localPaths.map((crawlPath) => this.asGlob(crawlPath)), { absolute: true, caseSensitiveMatch: false, onlyFiles: true, dot: includeHidden, ignore: exclusionPatterns }); let batch: string[] = []; for await (const value of stream) { batch.push(value.toString()); if (batch.length === walkOptions.take) { yield batch; batch = []; } } if (batch.length) yield batch; }
  watch(paths: string[], options: ChokidarOptions, events: Partial<WatchEvents>) { if (paths.some((watchPath) => this.remoteStorageRepository.isRemotePath(watchPath))) throw new Error('Remote external library watching is not supported; disable library watching for remote libraries'); const watcher = chokidar.watch(paths, options); watcher.on('ready', () => events.onReady?.()); watcher.on('add', (p) => events.onAdd?.(p)); watcher.on('change', (p) => events.onChange?.(p)); watcher.on('unlink', (p) => events.onUnlink?.(p)); watcher.on('error', (error) => events.onError?.(error as Error)); return () => watcher.close(); }
  watchDir = this.watch;
  private asGlob(pathToCrawl: string): string { const escapedPath = escapePath(pathToCrawl).replaceAll('"', '["]').replaceAll("'", "[']").replaceAll('`', '[`]'); const extensions = `*{${mimeTypes.getSupportedFileExtensions().join(',')}}`; return `${escapedPath}/**/${extensions}`; }
}
