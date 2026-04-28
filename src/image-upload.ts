import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runtimePath } from './config.js';
import { addImageUpload, type ImageUploadRecord } from './state.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type MultipartPart = {
  name: string;
  filename: string | null;
  headers: Record<string, string>;
  content: Buffer;
};

type ImageInfo = {
  mime: string;
  extension: string;
  width: number;
  height: number;
};

function uploadError(message: string, statusCode = 400): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function sanitizeBaseName(value: string): string {
  const ext = path.extname(value);
  const base = path.basename(value, ext) || 'image';
  return base.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]+/g, '_').slice(0, 80) || 'image';
}

function headerParam(value: string, name: string): string | null {
  const pattern = new RegExp(`${name}="([^"]*)"`);
  const quoted = value.match(pattern)?.[1];
  if (quoted !== undefined) return quoted;
  const plain = value.match(new RegExp(`${name}=([^;]+)`))?.[1];
  return plain ? plain.trim() : null;
}

function contentTypeBoundary(contentType: string): string {
  const boundary = headerParam(contentType, 'boundary');
  if (!boundary) throw uploadError('multipart/form-data 缺少 boundary。');
  return boundary;
}

async function readRequestBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += next.length;
    if (total > MAX_UPLOAD_BYTES + 1024 * 1024) {
      throw uploadError('上传图片超过 50MB 限制。', 413);
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

function parsePartHeaders(raw: string): { name: string; filename: string | null; headers: Record<string, string> } {
  const headers = raw.split(/\r?\n/).reduce<Record<string, string>>((acc, line) => {
    const index = line.indexOf(':');
    if (index <= 0) return acc;
    acc[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    return acc;
  }, {});
  const disposition = headers['content-disposition'] || '';
  const name = headerParam(disposition, 'name') || '';
  const filename = headerParam(disposition, 'filename');
  return { name, filename, headers };
}

function parseMultipart(buffer: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerEndNeedle = Buffer.from('\r\n\r\n');
  const parts: MultipartPart[] = [];
  let cursor = buffer.indexOf(delimiter);
  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    if (buffer.subarray(partStart, partStart + 2).toString('ascii') === '--') break;
    if (buffer.subarray(partStart, partStart + 2).toString('ascii') === '\r\n') partStart += 2;
    const headerEnd = buffer.indexOf(headerEndNeedle, partStart);
    if (headerEnd < 0) break;
    const nextBoundary = buffer.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + headerEndNeedle.length);
    if (nextBoundary < 0) break;
    const headerText = buffer.subarray(partStart, headerEnd).toString('utf8');
    const meta = parsePartHeaders(headerText);
    parts.push({
      ...meta,
      content: buffer.subarray(headerEnd + headerEndNeedle.length, nextBoundary),
    });
    cursor = nextBoundary + 2;
    cursor = buffer.indexOf(delimiter, cursor);
  }
  return parts;
}

function readUint24LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] || 0) + ((buffer[offset + 1] || 0) << 8) + ((buffer[offset + 2] || 0) << 16);
}

function jpegDimensions(buffer: Buffer): Pick<ImageInfo, 'width' | 'height'> | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

export function imageInfoFromBuffer(buffer: Buffer): ImageInfo {
  if (
    buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return {
      mime: 'image/png',
      extension: '.png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  const jpeg = jpegDimensions(buffer);
  if (jpeg) return { mime: 'image/jpeg', extension: '.jpg', ...jpeg };
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return {
        mime: 'image/webp',
        extension: '.webp',
        width: readUint24LE(buffer, 24) + 1,
        height: readUint24LE(buffer, 27) + 1,
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const b0 = buffer[21] || 0;
      const b1 = buffer[22] || 0;
      const b2 = buffer[23] || 0;
      const b3 = buffer[24] || 0;
      return {
        mime: 'image/webp',
        extension: '.webp',
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        mime: 'image/webp',
        extension: '.webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  throw uploadError('只支持真实 PNG / JPG / WEBP 图片。');
}

function uploadDir(): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = runtimePath('uploads', 'images', day);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function handleImageUpload(req: http.IncomingMessage): Promise<ImageUploadRecord> {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data/i.test(contentType)) {
    throw uploadError('图片上传必须使用 multipart/form-data。');
  }
  const body = await readRequestBuffer(req);
  const parts = parseMultipart(body, contentTypeBoundary(contentType));
  const filePart = parts.find((part) => part.filename && part.content.length > 0);
  if (!filePart) throw uploadError('没有读取到上传图片文件。');
  if (filePart.content.length > MAX_UPLOAD_BYTES) throw uploadError('上传图片超过 50MB 限制。', 413);

  const info = imageInfoFromBuffer(filePart.content);
  const id = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(filePart.content).digest('hex');
  const originalName = filePart.filename || 'upload';
  const baseName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeBaseName(originalName)}-${id.slice(0, 8)}`;
  const storedPath = path.join(uploadDir(), `${baseName}${info.extension}`);
  fs.writeFileSync(storedPath, filePart.content);
  const metadataPath = path.join(uploadDir(), `${baseName}.json`);
  const metadata = {
    id,
    createdAt: new Date().toISOString(),
    originalName,
    storedPath,
    mime: info.mime,
    extension: info.extension,
    sizeBytes: filePart.content.length,
    sha256,
    width: info.width,
    height: info.height,
    declaredContentType: filePart.headers['content-type'] || null,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  return addImageUpload({
    ...metadata,
    metadataPath,
    label: parts.find((part) => part.name === 'label')?.content.toString('utf8').trim() || null,
  });
}
