import { Injectable } from '@nestjs/common';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import picomatch from 'picomatch';
import { Stats } from 'node:fs';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { mimeTypes } from 'src/utils/mime-types';

interface RemoteEntry { path: string; type: 'file' | 'directory'; size?: number; mtime?: string; }
interface RemoteListResponse { entries: RemoteEntry[]; }
export interface RemoteReadStream { stream: Readable; type?: string; length?: number; }

@Injectable()
export class RemoteStorageRepository {
  private readonly prefix = '/remote/photo-extern';
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor() {
    this.baseUrl = (process.env.REMOTE_STORAGE_URL || '').replace(/\/$/, '');
    this.token = process.env.REMOTE_STORAGE_TOKEN || undefined;
  }

  isRemotePath(filepath: string): boolean { return filepath === this.prefix || filepath.startsWith(`${this.prefix}/`); }

  private relativePath(filepath: string): string {
    if (!this.isRemotePath(filepath)) throw new Error(`Not a remote path: ${filepath}`);
    const relative = filepath.slice(this.prefix.length).replace(/^\/+/, '');
    const normalized = path.posix.normalize(`/${relative}`).replace(/^\/+/, '');
    if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Path traversal is not allowed: ${filepath}`);
    return normalized;
  }

  private buildUrl(endpoint: 'list' | 'file' | 'storage', relativePath: string, recursive = false): URL {
    if (!this.baseUrl) throw new Error('REMOTE_STORAGE_URL is not configured');
    const url = new URL(`/api/${endpoint}`, this.baseUrl);
    if (endpoint !== 'storage') {
      url.searchParams.set('path', relativePath);
      if (endpoint === 'list') url.searchParams.set('recursive', String(recursive));
    }
    return url;
  }

  private headers(): HeadersInit { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }

  private async request(url: URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, { ...init, headers: { ...this.headers(), ...(init?.headers || {}) } });
    if (!response.ok) {
      const error = new Error(`Remote storage request failed: ${response.status} ${response.statusText}`);
      Object.assign(error, { code: response.status === 404 ? 'ENOENT' : 'EREMOTE' });
      throw error;
    }
    return response;
  }

  private async uploadFile(localPath: string, remotePath: string) {
    const relative = this.relativePath(remotePath);
    const stat = await fs.stat(localPath);
    const response = await this.request(this.buildUrl('file', relative), {
      method: 'PUT', body: createReadStream(localPath), duplex: 'half',
      headers: { 'content-length': String(stat.size), 'content-type': mimeTypes.lookup(localPath) },
    });
    await response.arrayBuffer();
  }

  async stat(filepath: string): Promise<Stats> {
    const response = await this.request(this.buildUrl('file', this.relativePath(filepath)), { method: 'HEAD' });
    const size = Number(response.headers.get('content-length') || 0);
    const modified = response.headers.get('last-modified');
    const mtime = modified ? new Date(modified) : new Date(0);
    const isDirectory = response.headers.get('x-remote-type') === 'directory';
    return { size, mtime, mtimeMs: mtime.getTime(), ctime: mtime, ctimeMs: mtime.getTime(), birthtime: mtime,
      birthtimeMs: mtime.getTime(), atime: mtime, atimeMs: mtime.getTime(), dev: 0, ino: 0,
      mode: isDirectory ? 0o755 : 0o644, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 4096,
      blocks: Math.ceil(size / 512), isDirectory: () => isDirectory, isFile: () => !isDirectory,
      isBlockDevice: () => false, isCharacterDevice: () => false, isSymbolicLink: () => false,
      isFIFO: () => false, isSocket: () => false } as Stats;
  }

  async checkFileExists(filepath: string, mode = constants.F_OK): Promise<boolean> {
    if (mode !== constants.F_OK && mode !== constants.R_OK && mode !== constants.W_OK) return false;
    try { await this.stat(filepath); return true; } catch { return false; }
  }

  async readdir(filepath: string): Promise<string[]> {
    const response = await this.request(this.buildUrl('list', this.relativePath(filepath), false));
    const result = (await response.json()) as RemoteListResponse;
    return result.entries.map((entry) => path.posix.basename(entry.path));
  }

  async readdirWithTypes(filepath: string) {
    const response = await this.request(this.buildUrl('list', this.relativePath(filepath), false));
    const result = (await response.json()) as RemoteListResponse;
    return result.entries.map((entry) => ({ name: path.posix.basename(entry.path),
      isDirectory: () => entry.type === 'directory', isFile: () => entry.type === 'file',
      isBlockDevice: () => false, isCharacterDevice: () => false, isSymbolicLink: () => false,
      isFIFO: () => false, isSocket: () => false }));
  }

  async createReadStream(filepath: string, mimeType?: string | null): Promise<RemoteReadStream> {
    const response = await this.request(this.buildUrl('file', this.relativePath(filepath)));
    if (!response.body) throw new Error(`Remote storage returned an empty response for ${filepath}`);
    return { stream: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      length: Number(response.headers.get('content-length') || 0) || undefined,
      type: mimeType || response.headers.get('content-type') || undefined };
  }

  async createPlainReadStream(filepath: string): Promise<Readable> { return (await this.createReadStream(filepath)).stream; }

  async readFile(filepath: string): Promise<Buffer> {
    const response = await this.request(this.buildUrl('file', this.relativePath(filepath)));
    return Buffer.from(await response.arrayBuffer());
  }

  async createFile(filepath: string, buffer: Buffer) {
    await this.request(this.buildUrl('file', this.relativePath(filepath)), { method: 'PUT', body: buffer,
      headers: { 'content-length': String(buffer.length), 'content-type': mimeTypes.lookup(filepath) } });
  }

  createWriteStream(filepath: string): Writable {
    const relative = this.relativePath(filepath);
    const temp = path.join(os.tmpdir(), `immich-remote-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    const local = createWriteStream(temp, { flags: 'wx' });
    return new Writable({
      write: (chunk, encoding, callback) => {
        if (!local.write(chunk, encoding)) local.once('drain', callback); else callback();
      },
      final: (callback) => {
        local.end(async () => {
          try { await this.uploadFile(temp, `${this.prefix}/${relative}`); callback(); }
          catch (error) { callback(error as Error); }
          finally { await fs.rm(temp, { force: true }); }
        });
      },
      destroy: (_error, callback) => { local.destroy(); void fs.rm(temp, { force: true }).then(() => callback()).catch(callback); },
    });
  }

  async createOrOverwriteFile(filepath: string, buffer: Buffer) { return this.createFile(filepath, buffer); }
  async overwriteFile(filepath: string, buffer: Buffer) { return this.createFile(filepath, buffer); }

  async rename(source: string, target: string) {
    const sourceRelative = this.relativePath(source);
    const targetRelative = this.relativePath(target);
    await this.request(this.buildUrl('file', targetRelative), { method: 'MOVE',
      headers: { 'x-source-path': sourceRelative }, });
  }

  async unlink(filepath: string) { await this.request(this.buildUrl('file', this.relativePath(filepath)), { method: 'DELETE' }); }
  async utimes(_filepath: string, _atime: Date, _mtime: Date) { /* remote filesystem mtime is retained */ }

  async copyFile(source: string, target: string) {
    const response = await this.request(this.buildUrl('file', this.relativePath(source)));
    if (!response.body) throw new Error(`Remote storage returned an empty response for ${source}`);
    await this.request(this.buildUrl('file', this.relativePath(target)), { method: 'PUT', body: response.body, duplex: 'half',
      headers: { 'content-type': response.headers.get('content-type') || mimeTypes.lookup(target) } });
  }

  async *walk(walkOptions: WalkOptionsDto): AsyncGenerator<string[]> {
    const { pathsToCrawl, exclusionPatterns, includeHidden, take } = walkOptions;
    if (pathsToCrawl.length === 0) return;
    const matcher = picomatch(exclusionPatterns);
    const extensions = mimeTypes.getSupportedFileExtensions().map((extension) => extension.toLowerCase());
    let batch: string[] = [];
    for (const root of pathsToCrawl) {
      const response = await this.request(this.buildUrl('list', this.relativePath(root), true));
      const result = (await response.json()) as RemoteListResponse;
      for (const entry of result.entries) {
        if (entry.type !== 'file') continue;
        const remotePath = `${this.prefix}/${entry.path}`;
        const filename = path.posix.basename(entry.path);
        if (!extensions.includes(path.posix.extname(filename).toLowerCase())) continue;
        if (!includeHidden && filename.startsWith('.')) continue;
        if (matcher(remotePath) || matcher(entry.path)) continue;
        batch.push(remotePath);
        if (batch.length >= take) { yield batch; batch = []; }
      }
    }
    if (batch.length > 0) yield batch;
  }

  async crawl(crawlOptions: CrawlOptionsDto): Promise<string[]> {
    const paths: string[] = [];
    for await (const batch of this.walk({ ...crawlOptions, take: Number.MAX_SAFE_INTEGER })) paths.push(...batch);
    return paths;
  }

  realpath(filepath: string): string { this.relativePath(filepath); return path.posix.normalize(filepath); }
}
