import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { OnEvent } from 'src/decorators';
import { BootstrapEventPriority, ImmichWorker, StorageFolder } from 'src/enum';
import { StorageCore } from 'src/cores/storage.core';
import { ConfigRepository } from 'src/repositories/config.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { MediaRepository } from 'src/repositories/media.repository';
import { AssetMediaService } from 'src/services/asset-media.service';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository';

const execFileAsync = promisify(execFile);

@Injectable()
export class RemoteStorageTestService {
  constructor(
    private storageRepository: StorageRepository,
    private assetMediaService: AssetMediaService,
    private userRepository: UserRepository,
    private configRepository: ConfigRepository,
    private mediaRepository: MediaRepository,
    private machineLearningRepository: MachineLearningRepository,
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

    await this.runRepositoryCanary();
    if (this.configRepository.getWorker() === ImmichWorker.Api) {
      setTimeout(() => void this.runRealMediaCanary(), 30_000).unref();
    }
  }

  private async runRepositoryCanary() {
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
      if (!listed.includes(`${id}-renamed.bin`) || !listed.includes(`${id}-copied.bin`)) throw new Error('readdir did not return canary files');
      await this.storageRepository.unlink(renamed);
      await this.storageRepository.unlink(copied);
      this.logger.log(`Remote storage canary PASS (${id})`);
    } catch (error) {
      this.logger.error(`Remote storage canary FAIL: ${(error as Error).message}`);
      await Promise.all([source, renamed, copied].map((path) => this.storageRepository.unlink(path).catch(() => undefined)));
    }
  }

  private async runRealMediaCanary() {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      this.logger.warn('Real media canary skipped: no admin user exists');
      return;
    }

    const auth = { user: admin } as any;
    const now = new Date();
    const imageId = randomUUID();
    const videoId = randomUUID();
    const tmpVideo = `/tmp/immich-remote-canary-${videoId}.mp4`;
    const remoteVideoPath = `/remote/photo-extern/.immich-router-canary/${videoId}.mp4`;

    try {
      const imageBuffer = await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 120, b: 160 } },
      }).jpeg({ quality: 85 }).toBuffer();
      const imagePath = await this.writeSyntheticAsset(auth.user.id, imageId, '.jpg', imageBuffer);
      const imageResult = await this.assetMediaService.uploadAsset(
        auth,
        { fileCreatedAt: now, fileModifiedAt: now, filename: 'remote-canary-image.jpg', isFavorite: false, assetData: undefined } as unknown as AssetMediaCreateDto,
        this.makeUploadFile(imagePath, imageBuffer, 'remote-canary-image.jpg', imageId),
      );
      this.logger.log(`Remote real image upload PASS: ${imageResult.id} (${imageResult.status})`);

      const directPreview = `/remote/photo-extern/.immich-router-canary/${imageId}-preview.jpeg`;
      await this.mediaRepository.generateThumbnail(imagePath, { format: 'jpeg' as any, quality: 80, colorspace: 'srgb', processInvalidImages: false }, directPreview);
      const previewStat = await this.storageRepository.stat(directPreview);
      if (previewStat.size <= 0) throw new Error('remote thumbnail was empty');
      this.logger.log(`Remote staged thumbnail PASS: ${directPreview} (${previewStat.size} bytes)`);

      await this.runMachineLearningCanary(imagePath);

      const r = Math.floor(Math.random() * 255);
      const g = Math.floor(Math.random() * 255);
      const b = Math.floor(Math.random() * 255);
      const hexColor = `0x${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${hexColor}:s=160x120:r=5`,
        '-t', '1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', tmpVideo,
      ]);
      const videoBuffer = await readFile(tmpVideo);
      const videoPath = await this.writeSyntheticAsset(auth.user.id, videoId, '.mp4', videoBuffer);
      const videoResult = await this.assetMediaService.uploadAsset(
        auth,
        { fileCreatedAt: now, fileModifiedAt: now, filename: 'remote-canary-video.mp4', isFavorite: false, duration: 1000, assetData: undefined } as unknown as AssetMediaCreateDto,
        this.makeUploadFile(videoPath, videoBuffer, 'remote-canary-video.mp4', videoId),
      );
      this.logger.log(`Remote real video upload PASS: ${videoResult.id} (${videoResult.status})`);

      await this.storageRepository.createFile(remoteVideoPath, videoBuffer);
      const remoteProbe = await this.mediaRepository.probe(remoteVideoPath);
      if (remoteProbe.videoStreams.length === 0 || remoteProbe.format.duration <= 0) throw new Error('remote video probe returned no valid video stream');
      this.logger.log(`Remote video probe PASS: ${remoteProbe.format.duration.toFixed(2)}s ${remoteProbe.videoStreams[0].width}x${remoteProbe.videoStreams[0].height}`);
      await this.storageRepository.unlink(remoteVideoPath);
    } catch (error) {
      this.logger.error(`Remote real media canary FAIL: ${(error as Error).message}`, (error as Error).stack);
      await this.storageRepository.unlink(remoteVideoPath).catch(() => undefined);
    } finally {
      await rm(tmpVideo, { force: true }).catch(() => undefined);
    }
  }

  private async runMachineLearningCanary(imagePath: string) {
    try {
      const config = this.configRepository.getMachineLearningConfig();
      if (!config.enabled) {
        this.logger.log('Remote ML canary SKIP: machine learning is disabled');
        return;
      }

      const clip = await this.machineLearningRepository.encodeImage(imagePath, config.clip);
      if (!clip) throw new Error('CLIP returned an empty embedding');
      this.logger.log(`Remote ML CLIP PASS (${clip.length} chars)`);

      if (config.facialRecognition.enabled) {
        const faces = await this.machineLearningRepository.detectFaces(imagePath, config.facialRecognition);
        this.logger.log(`Remote ML face detection PASS (${faces.faces.length} faces)`);
      }

      if (config.ocr.enabled) {
        const ocr = await this.machineLearningRepository.ocr(imagePath, config.ocr);
        this.logger.log(`Remote ML OCR PASS (${ocr.text.length} text regions)`);
      }
    } catch (error) {
      throw new Error(`Remote ML canary failed: ${(error as Error).message}`);
    }
  }

  private async writeSyntheticAsset(userId: string, uuid: string, extension: string, data: Buffer) {
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, userId, uuid);
    this.storageRepository.mkdirSync(folder);
    const path = `${folder}/${uuid}${extension}`;
    await this.storageRepository.createFile(path, data);
    return path;
  }

  private makeUploadFile(path: string, data: Buffer, originalName: string, uuid: string) {
    return { uuid, originalName, originalPath: path, size: data.length, checksum: createHash('sha1').update(data).digest() } as any;
  }
}
