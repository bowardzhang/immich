import { Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MediaRepository } from 'src/repositories/media.repository';
import { RemoteStorageRepository } from 'src/repositories/remote-storage.repository';

/**
 * Adapts path-oriented media libraries (ffmpeg, sharp, exiftool) to the HTTP
 * storage namespace. The persistent DB path remains the remote logical path;
 * only the short-lived processing copy uses local ephemeral disk.
 */
@Injectable()
export class RemoteMediaAdapterRepository {
  private readonly patched = new WeakSet<object>();

  constructor(
    private mediaRepository: MediaRepository,
    private remoteStorageRepository: RemoteStorageRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(RemoteMediaAdapterRepository.name);
    this.patch();
  }

  private isRemote(value: unknown): value is string {
    return typeof value === 'string' && this.remoteStorageRepository.isRemotePath(value);
  }

  private async stageInput(input: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    if (!this.isRemote(input)) return { path: input, cleanup: async () => {} };

    const temp = path.join(os.tmpdir(), `immich-media-input-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(input)}`);
    await pipeline(this.remoteStorageRepository.createPlainReadStream(input), createWriteStream(temp, { flags: 'wx' }));
    return { path: temp, cleanup: () => fs.rm(temp, { force: true }) };
  }

  private async stageOutput(output: string): Promise<{ path: string; commit: () => Promise<void>; cleanup: () => Promise<void> }> {
    if (!this.isRemote(output)) return { path: output, commit: async () => {}, cleanup: async () => {} };

    const temp = path.join(os.tmpdir(), `immich-media-output-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(output)}`);
    return {
      path: temp,
      commit: async () => {
        await pipeline(createReadStream(temp), this.remoteStorageRepository.createWriteStream(output));
      },
      cleanup: () => fs.rm(temp, { force: true }),
    };
  }

  private async stageExistingOutput(output: string) {
    const staged = await this.stageInput(output);
    return staged;
  }

  private patch() {
    const media = this.mediaRepository as any;
    if (this.patched.has(media)) return;
    this.patched.add(media);

    const originalExtract = media.extract.bind(media);
    media.extract = async (input: string) => {
      const staged = await this.stageInput(input);
      try { return await originalExtract(staged.path); } finally { await staged.cleanup(); }
    };

    const originalWriteExif = media.writeExif.bind(media);
    media.writeExif = async (tags: unknown, output: string) => {
      if (!this.isRemote(output)) return originalWriteExif(tags, output);
      const staged = await this.stageExistingOutput(output);
      try {
        const result = await originalWriteExif(tags, staged.path);
        if (result) await staged.cleanup().then(() => undefined);
        if (result) await pipeline(createReadStream(staged.path), this.remoteStorageRepository.createWriteStream(output));
        return result;
      } finally {
        await staged.cleanup();
      }
    };

    const originalCopyTagGroup = media.copyTagGroup.bind(media);
    media.copyTagGroup = async (tagGroup: string, source: string, target: string) => {
      const sourceStaged = await this.stageInput(source);
      const targetStaged = this.isRemote(target) ? await this.stageExistingOutput(target) : { path: target, cleanup: async () => {} };
      try {
        const result = await originalCopyTagGroup(tagGroup, sourceStaged.path, targetStaged.path);
        if (result && this.isRemote(target)) {
          await pipeline(createReadStream(targetStaged.path), this.remoteStorageRepository.createWriteStream(target));
        }
        return result;
      } finally {
        await sourceStaged.cleanup();
        await targetStaged.cleanup();
      }
    };

    const originalDecodeImage = media.decodeImage.bind(media);
    media.decodeImage = async (input: string | Buffer, options: unknown) => {
      if (Buffer.isBuffer(input)) return originalDecodeImage(input, options);
      const staged = await this.stageInput(input);
      try { return await originalDecodeImage(staged.path, options); } finally { await staged.cleanup(); }
    };

    const originalGenerateThumbnail = media.generateThumbnail.bind(media);
    media.generateThumbnail = async (input: string | Buffer, options: unknown, output: string) => {
      const inputStaged = typeof input === 'string' ? await this.stageInput(input) : { path: input, cleanup: async () => {} };
      const outputStaged = await this.stageOutput(output);
      try {
        await originalGenerateThumbnail(inputStaged.path, options, outputStaged.path);
        await outputStaged.commit();
      } finally {
        await inputStaged.cleanup();
        await outputStaged.cleanup();
      }
    };

    const originalGenerateThumbhash = media.generateThumbhash.bind(media);
    media.generateThumbhash = async (input: string | Buffer, options: unknown) => {
      if (Buffer.isBuffer(input)) return originalGenerateThumbhash(input, options);
      const staged = await this.stageInput(input);
      try { return await originalGenerateThumbhash(staged.path, options); } finally { await staged.cleanup(); }
    };

    const originalProbe = media.probe.bind(media);
    media.probe = async (input: string, options?: unknown) => {
      const staged = await this.stageInput(input);
      try { return await originalProbe(staged.path, options); } finally { await staged.cleanup(); }
    };

    const originalProbePackets = media.probePackets.bind(media);
    media.probePackets = async (input: string, streamIndex: number) => {
      const staged = await this.stageInput(input);
      try { return await originalProbePackets(staged.path, streamIndex); } finally { await staged.cleanup(); }
    };

    const originalTranscode = media.transcode.bind(media);
    media.transcode = async (input: string, output: string | NodeJS.WritableStream, options: unknown) => {
      const inputStaged = await this.stageInput(input);
      const outputStaged = typeof output === 'string' ? await this.stageOutput(output) : { path: output, commit: async () => {}, cleanup: async () => {} };
      try {
        await originalTranscode(inputStaged.path, outputStaged.path, options);
        await outputStaged.commit();
      } finally {
        await inputStaged.cleanup();
        await outputStaged.cleanup();
      }
    };

    const originalGetImageMetadata = media.getImageMetadata.bind(media);
    media.getImageMetadata = async (input: string | Buffer) => {
      if (Buffer.isBuffer(input)) return originalGetImageMetadata(input);
      const staged = await this.stageInput(input);
      try { return await originalGetImageMetadata(staged.path); } finally { await staged.cleanup(); }
    };

    this.logger.log('Remote media staging adapter enabled');
  }
}
