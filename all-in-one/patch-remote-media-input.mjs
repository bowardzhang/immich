import fs from 'node:fs/promises';

const file = 'server/src/repositories/media.repository.ts';
let source = await fs.readFile(file, 'utf8');

const replaceOnce = (before, after, label) => {
  if (!source.includes(before)) {
    throw new Error(`Unable to patch ${label}: expected source not found`);
  }
  source = source.replace(before, after);
};

replaceOnce(
  "import { spawn } from 'node:child_process';\nimport fs from 'node:fs/promises';\nimport { Writable } from 'node:stream';",
  "import { spawn } from 'node:child_process';\nimport { createWriteStream } from 'node:fs';\nimport fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { Readable, Writable } from 'node:stream';\nimport { pipeline } from 'node:stream/promises';",
  'imports',
);

replaceOnce(
  `  decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {\n    return this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });\n  }`,
  `  async decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {\n    if (Buffer.isBuffer(input)) {\n      return this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });\n    }\n\n    return this.withAvailableInput(input, (availableInput) =>\n      this.getImageDecodingPipeline(availableInput, options).raw().toBuffer({ resolveWithObject: true }),\n    );\n  }`,
  'decodeImage',
);

replaceOnce(
  `  transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {\n    if (!options.twoPass) {`,
  `  transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {\n    return this.withAvailableInput(input, (availableInput) => this.transcodeAvailable(availableInput, output, options));\n  }\n\n  private transcodeAvailable(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {\n    if (!options.twoPass) {`,
  'transcode',
);

replaceOnce(
  `  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {\n    const { width = 0, height = 0, hasAlpha = false } = await sharp(input, { unlimited: true }).metadata();\n    return { width, height, isTransparent: hasAlpha };\n  }\n\n  private configureFfmpegCall`,
  `  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {\n    if (Buffer.isBuffer(input)) {\n      const { width = 0, height = 0, hasAlpha = false } = await sharp(input, { unlimited: true }).metadata();\n      return { width, height, isTransparent: hasAlpha };\n    }\n\n    return this.withAvailableInput(input, async (availableInput) => {\n      const { width = 0, height = 0, hasAlpha = false } = await sharp(availableInput, { unlimited: true }).metadata();\n      return { width, height, isTransparent: hasAlpha };\n    });\n  }\n\n  private async withAvailableInput<T>(input: string, handler: (availableInput: string) => Promise<T>): Promise<T> {\n    try {\n      await fs.access(input);\n      return await handler(input);\n    } catch (error: any) {\n      if (error?.code !== 'ENOENT' || !input.startsWith('/data/')) {\n        throw error;\n      }\n    }\n\n    const baseUrl = (process.env.REMOTE_STORAGE_URL || '').replace(/\\/$/, '');\n    if (!baseUrl) {\n      throw new Error(\`Input file is missing locally and REMOTE_STORAGE_URL is not configured: \${input}\`);\n    }\n\n    const headers: Record<string, string> = {};\n    if (process.env.REMOTE_STORAGE_TOKEN) {\n      headers.authorization = \`Bearer \${process.env.REMOTE_STORAGE_TOKEN}\`;\n    }\n\n    let remotePath = input.slice('/data/'.length);\n    let response = await fetch(\`\${baseUrl}/api/file?path=\${encodeURIComponent(remotePath)}\`, { headers });\n\n    if (response.status === 404) {\n      const filename = path.basename(remotePath);\n      const listResponse = await fetch(\`\${baseUrl}/api/list?path=&recursive=true\`, { headers });\n      if (listResponse.ok) {\n        const data = (await listResponse.json()) as { entries?: Array<{ path?: string }> };\n        const matches = (data.entries || [])\n          .map((entry) => entry.path || '')\n          .filter((candidate) => candidate && path.posix.basename(candidate) === filename);\n        if (matches.length === 1) {\n          remotePath = matches[0];\n          this.logger.warn(\`Resolved stale media path by unique filename: \${input} -> remote:\${remotePath}\`);\n          response = await fetch(\`\${baseUrl}/api/file?path=\${encodeURIComponent(remotePath)}\`, { headers });\n        } else if (matches.length > 1) {\n          this.logger.warn(\`Refusing ambiguous remote filename fallback for \${input}: \${matches.length} matches\`);\n        }\n      }\n    }\n\n    if (!response.ok || !response.body) {\n      throw new Error(\`Remote media input unavailable for \${input}: HTTP \${response.status}\`);\n    }\n\n    const tempDir = await fs.mkdtemp('/tmp/immich-remote-input-');\n    const tempPath = path.join(tempDir, path.basename(input));\n    this.logger.debug(\`Staging remote media input \${input} from remote:\${remotePath} to \${tempPath}\`);\n    try {\n      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempPath));\n      return await handler(tempPath);\n    } finally {\n      await fs.rm(tempDir, { recursive: true, force: true });\n    }\n  }\n\n  private configureFfmpegCall`,
  'remote input helper',
);

await fs.writeFile(file, source);
console.log('[aio-build] patched MediaRepository to stage missing /data media from remote storage');
