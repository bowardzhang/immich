import { Injectable } from '@nestjs/common';
import { BinaryField, DefaultReadTaskOptions, ExifTool, ReadTaskOptions, Tags } from 'exiftool-vendored';
import geotz from 'geo-tz';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { RemoteStorageRepository } from 'src/repositories/remote-storage.repository';
import { mimeTypes } from 'src/utils/mime-types';

interface ExifDuration {
  Value: number;
  Scale?: number;
}

type StringOrNumber = string | number;

type TagsWithWrongTypes =
  | 'FocalLength'
  | 'Duration'
  | 'Description'
  | 'ImageDescription'
  | 'RegionInfo'
  | 'TagsList'
  | 'Keywords'
  | 'HierarchicalSubject'
  | 'ISO';

export interface ImmichTags extends Omit<Tags, TagsWithWrongTypes> {
  ContentIdentifier?: string;
  MotionPhoto?: number;
  MotionPhotoVersion?: number;
  MotionPhotoPresentationTimestampUs?: number;
  MediaGroupUUID?: string;
  ImagePixelDepth?: string;
  FocalLength?: number;
  Duration?: number | string | ExifDuration;
  EmbeddedVideoType?: string;
  EmbeddedVideoFile?: BinaryField;
  MotionPhotoVideo?: BinaryField;
  TagsList?: StringOrNumber[];
  HierarchicalSubject?: StringOrNumber[];
  Keywords?: StringOrNumber | StringOrNumber[];
  ISO?: number | number[];

  // Type is wrong, can also be number.
  Description?: StringOrNumber;
  ImageDescription?: StringOrNumber;

  // Extended properties for image regions, such as faces
  RegionInfo?: {
    AppliedToDimensions: {
      W: number;
      H: number;
      Unit: string;
    };
    RegionList: {
      Area: {
        // (X,Y) // center of the rectangle
        X: number | string;
        Y: number | string;
        W: number | string;
        H: number | string;
        Unit: string;
      };
      Rotation?: number;
      Type?: string;
      Name?: string;
    }[];
  };

  Device?: {
    Manufacturer?: string;
    ModelName?: string;
  };

  AndroidMake?: string;
  AndroidModel?: string;
  DeviceManufacturer?: string;
  DeviceModelName?: string;
}

@Injectable()
export class MetadataRepository {
  private exiftool = new ExifTool({
    defaultVideosToUTC: true,
    backfillTimezones: true,
    inferTimezoneFromDatestamps: true,
    inferTimezoneFromTimeStamp: true,
    useMWG: true,
    numericTags: [...DefaultReadTaskOptions.numericTags, 'FocalLength', 'FileSize', 'Rotation'],
    /* eslint unicorn/no-array-callback-reference: off, unicorn/no-array-method-this-argument: off */
    geoTz: (lat, lon) => geotz.find(lat, lon)[0],
    geolocation: true,
    // Enable exiftool LFS to parse metadata for files larger than 2GB.
    readArgs: ['-api', 'largefilesupport=1', '--ICC_Profile:DeviceManufacturer', '--ICC_Profile:DeviceModelName'],
    writeArgs: ['-api', 'largefilesupport=1', '-overwrite_original'],
    taskTimeoutMillis: 2 * 60 * 1000,
  });

  constructor(
    private logger: LoggingRepository,
    private remoteStorageRepository: RemoteStorageRepository,
  ) {
    this.logger.setContext(MetadataRepository.name);
  }

  setMaxConcurrency(concurrency: number) {
    this.exiftool.batchCluster.setMaxProcs(concurrency);
  }

  async teardown() {
    await this.exiftool.end();
  }

  private async withLocalPath<T>(filePath: string, operation: (localPath: string) => Promise<T>, writeBack = false): Promise<T> {
    if (!this.remoteStorageRepository.isRemotePath(filePath)) return operation(filePath);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'immich-remote-metadata-'));
    const localPath = path.join(tempDir, path.basename(filePath) || 'media');
    try {
      const buffer = await this.remoteStorageRepository.readFile(filePath);
      await fs.writeFile(localPath, buffer);
      const result = await operation(localPath);
      if (writeBack) {
        await this.remoteStorageRepository.createFile(filePath, await fs.readFile(localPath));
      }
      return result;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  readTags(path: string): Promise<ImmichTags> {
    const options: ReadTaskOptions | undefined = mimeTypes.isVideo(path) ? { readArgs: ['-ee'] } : undefined;

    return this.withLocalPath(path, (localPath) => this.exiftool.read(localPath, options)).catch((error) => {
      this.logger.warn(`Error reading exif data (${path}): ${error}\n${error?.stack}`);
      return {};
    }) as Promise<ImmichTags>;
  }

  extractBinaryTag(path: string, tagName: string): Promise<Buffer> {
    return this.withLocalPath(path, (localPath) => this.exiftool.extractBinaryTagToBuffer(tagName, localPath));
  }

  async writeTags(path: string, tags: Partial<Tags>): Promise<void> {
    // If exiftool assigns a field with ^= instead of =, empty values will be written too.
    // Since exiftool-vendored doesn't support an option for this, we append the ^ to the name of the tag instead.
    // https://exiftool.org/exiftool_pod.html#:~:text=is%20used%20to%20write%20an%20empty%20string
    const tagsToWrite = Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${key}^`, value]));
    try {
      await this.withLocalPath(path, (localPath) => this.exiftool.write(localPath, tagsToWrite), true);
    } catch (error) {
      this.logger.warn(`Error writing exif data (${path}): ${error}`);
    }
  }
}
