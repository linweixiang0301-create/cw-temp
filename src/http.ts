import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export type JsonObject = Record<string, unknown>;

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

export function sendText(
  res: http.ServerResponse,
  statusCode: number,
  payload: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export async function readJsonBody<T extends JsonObject>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.psd': 'image/vnd.adobe.photoshop',
    '.psb': 'application/vnd.adobe.photoshop',
  };
  return map[ext] || 'application/octet-stream';
}

export function sendFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentTypeForFile(filePath),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}
