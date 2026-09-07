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

  private async runMachineLearningCanary(imagePath: string) {
    try {
      const config = this.machineLearningRepository.getConfig();
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
