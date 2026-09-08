import { HttpException, NotFoundException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { CacheControl } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { ImmichReadStream } from 'src/repositories/storage.repository';
import { isConnectionAborted } from 'src/utils/misc';

const REMOTE_MEDIA_PREFIX = '/remote/photo-extern';
const LOCAL_MEDIA_PREFIX = '/data';

export function getFileNameWithoutExtension(path: string): string {
  return basename(path, getFilenameExtension(path));
}

export function getFilenameExtension(path: string) {
  const extension = extname(path);
  if (!extension && path.startsWith('.') && !path.includes('.', 1)) {
    return path;
  }
  return extension;
}

export function getLivePhotoMotionFilename(stillName: string, motionName: string) {
  return getFileNameWithoutExtension(stillName) + getFilenameExtension(motionName);
}

export class ImmichFileResponse {
  public readonly path!: string;
  public readonly contentType!: string;
  public readonly cacheControl!: CacheControl;
  public readonly fileName?: string;

  constructor(response: ImmichFileResponse) {
    Object.assign(this, response);
  }
}
type SendFile = Parameters<Response['sendFile']>;
type SendFileOptions = SendFile[1];

const cacheControlHeaders: Record<CacheControl, string | null> = {
  [CacheControl.PrivateWithCache]:
    'private, max-age=86400, no-transform, stale-while-revalidate=2592000, stale-if-error=2592000',
  [CacheControl.PrivateWithoutCache]: 'private, no-cache, no-transform',
  [CacheControl.None]: null,
};

const sendRemoteFile = async (res: Response, path: string): Promise<number> => {
  const baseUrl = (process.env.REMOTE_STORAGE_URL || '').replace(/\/$/, '');
  const token = process.env.REMOTE_STORAGE_TOKEN || '';
  if (!baseUrl) throw new Error('REMOTE_STORAGE_URL is not configured');

  const relative = path.slice(REMOTE_MEDIA_PREFIX.length).replace(/^\/+/, '');
  const encodedPath = encodeURIComponent(relative);
  const range = res.req.headers.range;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (range) headers.range = range;

  const response = await fetch(`${baseUrl}/api/file?path=${encodedPath}`, { headers });
  const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

  res.status(response.status);
  for (const header of responseHeaders) {
    const value = response.headers.get(header);
    if (value) res.set(header, value);
  }

  if (!response.body) {
    res.end();
    return response.status;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    res.destroy(error as Error);
  }
  return response.status;
};

const localToRemotePath = (filePath: string): string | undefined => {
  if (filePath === LOCAL_MEDIA_PREFIX) return REMOTE_MEDIA_PREFIX;
  if (!filePath.startsWith(`${LOCAL_MEDIA_PREFIX}/`)) return undefined;
  return `${REMOTE_MEDIA_PREFIX}/${filePath.slice(`${LOCAL_MEDIA_PREFIX}/`.length)}`;
};

export const sendFile = async (
  res: Response,
  next: NextFunction,
  handler: () => Promise<ImmichFileResponse> | ImmichFileResponse,
  logger: LoggingRepository,
): Promise<void> => {
  const _sendFile = (path: string, options: SendFileOptions) =>
    promisify<string, SendFileOptions>(res.sendFile).bind(res)(path, options);

  try {
    const file = await handler();

    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      res.set('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    if (file.path === REMOTE_MEDIA_PREFIX || file.path.startsWith(`${REMOTE_MEDIA_PREFIX}/`)) {
      await sendRemoteFile(res, file.path);
      return;
    }

    try {
      await access(file.path, constants.R_OK);
      await _sendFile(file.path, { dotfiles: 'allow' });
      return;
    } catch (error: any) {
      const remoteFallback = localToRemotePath(file.path);
      if (error?.code !== 'ENOENT' || !remoteFallback || !process.env.REMOTE_STORAGE_URL) throw error;

      logger.warn(`Local media missing, trying verified remote-storage fallback: ${file.path}`);
      const status = await sendRemoteFile(res, remoteFallback);
      if (status === 404) {
        logger.warn(`Media missing from both local and remote storage: ${file.path}`);
      }
      return;
    }
  } catch (error: Error | any) {
    if (isConnectionAborted(error) || res.headersSent) {
      return;
    }

    if (!(error instanceof HttpException)) {
      logger.error(`Unable to send file: ${error}`, error.stack);
    }

    next(new NotFoundException());
  }
};

export const asStreamableFile = ({ stream, type, length }: ImmichReadStream) => {
  return new StreamableFile(stream, { type, length });
};
