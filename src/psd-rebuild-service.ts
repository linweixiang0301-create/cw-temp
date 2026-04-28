import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimePath } from './config.js';
import { loadPhotoshopConfigBridge } from './bridge.js';
import { imageInfoFromBuffer } from './image-upload.js';
import {
  getResolvedModelRoute,
  runVisionLayerAnalysis,
} from './model-routing.js';
import {
  addModelUsageRecord,
  addPsdRebuildJob,
  getImageUpload,
  getPsdRebuildJob,
  listPsdRebuildJobs,
  type ImageUploadRecord,
  type PsdRebuildJobRecord,
} from './state.js';

type CreatePsdRebuildJobInput = {
  uploadId?: string;
  imagePath?: string;
  modelId?: string;
  prompt?: string;
  executePhotoshop?: boolean;
};

type SourceImage = {
  uploadId: string | null;
  path: string;
  width: number;
  height: number;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
};

type RebuildLayer = {
  id: string;
  name: string;
  type: 'background' | 'subject' | 'text' | 'decoration' | 'shadow' | 'highlight' | 'raster';
  role: string;
  confidence: number;
  text?: string | null;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    pixels: {
      left: number;
      top: number;
      width: number;
      height: number;
    };
  };
  editableRecommendation: string;
  notes?: string | null;
};

type LocalFileStatus = {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  updatedAt: string | null;
};

type PsdRebuildLibraryItem = PsdRebuildJobRecord & {
  generatedAt?: string | null;
  summary?: string | null;
  manifestStatus?: string | null;
  directoryPath: string;
  manifestFile: LocalFileStatus;
  photoshopScriptFile: LocalFileStatus;
  outputPsdFile: LocalFileStatus;
  previewImageFile: LocalFileStatus;
  visionInput?: unknown;
  layerPolicy?: unknown;
};

type PsdRebuildLibraryDetail = {
  job: PsdRebuildLibraryItem;
  layerManifest: Record<string, unknown> | null;
};

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function badRequest(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

function maybeRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourceFromUpload(upload: ImageUploadRecord): SourceImage {
  return {
    uploadId: upload.id,
    path: upload.storedPath,
    width: upload.width,
    height: upload.height,
    mime: upload.mime,
    sizeBytes: upload.sizeBytes,
    sha256: upload.sha256,
  };
}

function sourceFromPath(imagePath: string): SourceImage {
  const resolved = path.resolve(String(imagePath || '').trim());
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw badRequest('imagePath 不存在，无法创建 PSD 重建作业。');
  }
  const buffer = fs.readFileSync(resolved);
  const info = imageInfoFromBuffer(buffer);
  return {
    uploadId: null,
    path: resolved,
    width: info.width,
    height: info.height,
    mime: info.mime,
    sizeBytes: buffer.length,
    sha256: sha256File(resolved),
  };
}

function resolveSource(input: CreatePsdRebuildJobInput): SourceImage {
  const uploadId = String(input.uploadId || '').trim();
  if (uploadId) {
    const upload = getImageUpload(uploadId);
    if (!upload) throw badRequest('上传记录不存在，无法创建 PSD 重建作业。');
    if (!fs.existsSync(upload.storedPath) || !fs.statSync(upload.storedPath).isFile()) {
      throw badRequest('上传图片文件不存在，无法创建 PSD 重建作业。');
    }
    return sourceFromUpload(upload);
  }
  if (String(input.imagePath || '').trim()) return sourceFromPath(String(input.imagePath));
  throw badRequest('缺少 uploadId 或 imagePath。');
}

function rebuildDir(jobId: string): string {
  const dir = runtimePath('psd-rebuild', jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rebuildRoot(): string {
  const root = runtimePath('psd-rebuild');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function stripJsonFences(value: string): string {
  return String(value || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseAnalysisJson(rawText: string): Record<string, any> | null {
  const stripped = stripJsonFences(rawText);
  const direct = maybeParseJson(stripped);
  if (direct) return direct;
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) return maybeParseJson(stripped.slice(first, last + 1));
  return null;
}

function maybeParseJson(value: string): Record<string, any> | null {
  try {
    return maybeRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizedBounds(rawBounds: unknown, source: SourceImage): RebuildLayer['bounds'] {
  const raw = maybeRecord(rawBounds) || {};
  let x = finiteNumber(raw.x ?? raw.left, 0);
  let y = finiteNumber(raw.y ?? raw.top, 0);
  let width = finiteNumber(raw.width, 1);
  let height = finiteNumber(raw.height, 1);
  if (x > 1 || y > 1 || width > 1 || height > 1) {
    x /= source.width;
    y /= source.height;
    width /= source.width;
    height /= source.height;
  }
  x = clamp(x, 0, 1);
  y = clamp(y, 0, 1);
  width = clamp(width, 0.01, 1 - x || 1);
  height = clamp(height, 0.01, 1 - y || 1);
  return {
    x,
    y,
    width,
    height,
    pixels: {
      left: Math.round(x * source.width),
      top: Math.round(y * source.height),
      width: Math.max(1, Math.round(width * source.width)),
      height: Math.max(1, Math.round(height * source.height)),
    },
  };
}

function layerType(value: unknown): RebuildLayer['type'] {
  const raw = String(value || '').trim();
  if (['background', 'subject', 'text', 'decoration', 'shadow', 'highlight', 'raster'].includes(raw)) {
    return raw as RebuildLayer['type'];
  }
  return 'raster';
}

function sanitizedLayerName(value: unknown, fallback: string): string {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return name.slice(0, 80) || fallback;
}

function layersFromAnalysis(analysisJson: Record<string, any> | null, source: SourceImage): RebuildLayer[] {
  const rawLayers = Array.isArray(analysisJson?.layers) ? analysisJson.layers : [];
  const layers = rawLayers.map((item, index): RebuildLayer | null => {
    const raw = maybeRecord(item);
    if (!raw) return null;
    const type = layerType(raw.type);
    return {
      id: String(raw.id || `ai_layer_${index + 1}`).trim() || `ai_layer_${index + 1}`,
      name: sanitizedLayerName(raw.name, `AI 重建层 ${index + 1}`),
      type,
      role: String(raw.role || '').trim() || '视觉模型建议的重建层。',
      confidence: clamp(finiteNumber(raw.confidence, 0.5), 0, 1),
      text: type === 'text' ? String(raw.text || '').trim() || null : null,
      bounds: normalizedBounds(raw.bounds, source),
      editableRecommendation: String(raw.editableRecommendation || raw.recommendation || '').trim()
        || (type === 'text' ? '在 Photoshop 中重建为可编辑文本层。' : '作为 AI 重建参考层，需要人工确认。'),
      notes: String(raw.notes || '').trim() || null,
    };
  }).filter((item): item is RebuildLayer => Boolean(item));

  if (layers.length > 0) return layers;
  return [{
    id: 'source_flattened_raster',
    name: '原图扁平像素层',
    type: 'raster',
    role: '真实上传图片本身；未声称拆出原始 PSD 图层。',
    confidence: 1,
    text: null,
    bounds: normalizedBounds({ x: 0, y: 0, width: 1, height: 1 }, source),
    editableRecommendation: '先作为 PSD 底图；后续由人工或增强模型继续拆分主体、文字和装饰。',
    notes: '这是扁平图 fallback，不是原始 PSD 图层恢复。',
  }];
}

function buildManifest(input: {
  jobId: string;
  source: SourceImage;
  analysisJson: Record<string, any> | null;
  analysisRawText: string | null;
  layers: RebuildLayer[];
  status: 'ai_analyzed' | 'single_raster_fallback';
  model?: string | null;
  selectedRole?: string | null;
  fallbackReason?: string | null;
  analysisRequestImagePath?: string | null;
  analysisImageCompatibility?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const textCandidates = Array.isArray(input.analysisJson?.textCandidates) ? input.analysisJson.textCandidates : [];
  const reconstructionPlan = Array.isArray(input.analysisJson?.reconstructionPlan) ? input.analysisJson.reconstructionPlan : [];
  const limitations = Array.isArray(input.analysisJson?.limitations) ? input.analysisJson.limitations : [];
  return {
    schema: 'ps-automation-console.psd-rebuild.v1',
    jobId: input.jobId,
    generatedAt: new Date().toISOString(),
    status: input.status,
    sourceImage: input.source,
    layerPolicy: {
      layerKind: 'ai_rebuilt_layers',
      originalPsdRecovery: false,
      note: 'JPG/PNG/WEBP 不包含原始 PSD 图层；以下为 AI 辅助重建建议与本地 PSD 生成输入。',
    },
    model: input.model || null,
    selectedRole: input.selectedRole || null,
    visionInput: {
      originalImagePath: input.source.path,
      requestImagePath: input.analysisRequestImagePath || input.source.path,
      compatibility: input.analysisImageCompatibility || null,
    },
    summary: input.analysisJson?.summary || (input.status === 'ai_analyzed' ? '视觉模型已返回拆层建议。' : '模型不可用或未返回结构化结果，保留真实单图层重建包。'),
    layers: input.layers,
    textCandidates,
    reconstructionPlan,
    limitations: limitations.length ? limitations : ['扁平图片无法真实恢复原始 PSD 图层、智能对象、蒙版和图层样式。'],
    rawAnalysisText: input.analysisRawText,
    fallbackReason: input.fallbackReason || null,
  };
}

function jsxString(value: string): string {
  return JSON.stringify(value);
}

function writePhotoshopScript(input: {
  source: SourceImage;
  sourceOpenPath?: string | null;
  layers: RebuildLayer[];
  outputPsdPath: string;
  previewImagePath: string;
  manifestPath: string;
  scriptPath: string;
}): void {
  const textLayers = input.layers.filter((layer) => layer.type === 'text' && String(layer.text || '').trim());
  const sourceOpenPath = input.sourceOpenPath && fs.existsSync(input.sourceOpenPath)
    ? input.sourceOpenPath
    : input.source.path;
  const script = `#target photoshop
app.displayDialogs = DialogModes.NO;
var sourceFile = File(${jsxString(sourceOpenPath)});
var originalSourceFile = File(${jsxString(input.source.path)});
var outputFile = File(${jsxString(input.outputPsdPath)});
var previewFile = File(${jsxString(input.previewImagePath)});
var manifestFile = File(${jsxString(input.manifestPath)});
var sourceWidth = ${Math.max(1, Math.round(input.source.width))};
var sourceHeight = ${Math.max(1, Math.round(input.source.height))};
if (!sourceFile.exists) {
  throw new Error("Source image missing: " + sourceFile.fsName);
}
var sourceDoc = app.open(sourceFile);
var doc = app.documents.add(sourceWidth, sourceHeight, 72, "AI PSD rebuild", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
app.activeDocument = sourceDoc;
sourceDoc.activeLayer.duplicate(doc, ElementPlacement.PLACEATBEGINNING);
sourceDoc.close(SaveOptions.DONOTSAVECHANGES);
app.activeDocument = doc;
try {
  doc.activeLayer.name = "Original flattened image";
} catch (renameError) {}
try {
  var rasterBounds = doc.activeLayer.bounds;
  var rasterLeft = rasterBounds[0].as("px");
  var rasterTop = rasterBounds[1].as("px");
  var rasterWidth = rasterBounds[2].as("px") - rasterLeft;
  var rasterHeight = rasterBounds[3].as("px") - rasterTop;
  if (rasterWidth > 0 && rasterHeight > 0) {
    doc.activeLayer.resize((sourceWidth / rasterWidth) * 100, (sourceHeight / rasterHeight) * 100, AnchorPosition.TOPLEFT);
    var resizedBounds = doc.activeLayer.bounds;
    doc.activeLayer.translate(-resizedBounds[0].as("px"), -resizedBounds[1].as("px"));
  }
} catch (fitError) {}
var layerSet = doc.layerSets.add();
layerSet.name = "AI rebuilt editable layers";
var textLayers = ${JSON.stringify(textLayers.map((layer) => ({
    name: layer.name,
    text: layer.text || layer.name,
    left: layer.bounds.pixels.left,
    top: layer.bounds.pixels.top,
    height: layer.bounds.pixels.height,
  })))};
for (var i = 0; i < textLayers.length; i += 1) {
  var item = textLayers[i];
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.TEXT;
  layer.name = item.name || ("AI text " + (i + 1));
  layer.textItem.contents = item.text || layer.name;
  layer.textItem.position = [Math.max(4, item.left || 24), Math.max(16, item.top || 32)];
  layer.textItem.size = Math.max(12, Math.min(96, Math.round((item.height || 42) * 0.55)));
  try {
    layer.move(layerSet, ElementPlacement.INSIDE);
  } catch (moveError) {}
}
var noteLayer = doc.artLayers.add();
noteLayer.kind = LayerKind.TEXT;
noteLayer.name = "AI rebuild note";
noteLayer.textItem.contents = "AI rebuilt layers, not original PSD layers. Manifest: " + manifestFile.fsName;
noteLayer.textItem.position = [24, 28];
noteLayer.textItem.size = 18;
try {
  noteLayer.move(layerSet, ElementPlacement.INSIDE);
} catch (noteMoveError) {}
var psdOptions = new PhotoshopSaveOptions();
psdOptions.layers = true;
psdOptions.embedColorProfile = true;
doc.saveAs(outputFile, psdOptions, true, Extension.LOWERCASE);
try {
  var pngOptions = new PNGSaveOptions();
  doc.saveAs(previewFile, pngOptions, true, Extension.LOWERCASE);
} catch (previewError) {}
doc.close(SaveOptions.DONOTSAVECHANGES);
`;
  fs.writeFileSync(input.scriptPath, script);
}

async function runPhotoshopScript(scriptPath: string): Promise<{ ok: boolean; command: string; error?: string }> {
  const configBridge = await loadPhotoshopConfigBridge();
  const config = configBridge.readPhotoshopConfig();
  if (!config.configured) {
    return { ok: false, command: 'photoshop-disabled', error: config.unavailableReason || 'Photoshop 自动化未配置。' };
  }
  const appName = path.basename(String(config.appPath || 'Adobe Photoshop 2026'), '.app');
  const appleScript = [
    `set jsFile to POSIX file ${JSON.stringify(scriptPath)} as alias`,
    'set jsSource to read jsFile',
    `tell application ${JSON.stringify(appName)}`,
    'activate',
    'do javascript jsSource',
    'end tell',
  ].join('\n');
  const result = spawnSync('osascript', ['-e', appleScript], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  return result.status === 0
    ? { ok: true, command: `osascript ${path.basename(scriptPath)}` }
    : { ok: false, command: `osascript ${path.basename(scriptPath)}`, error: stderr || stdout || `exit=${result.status}` };
}

function localFileStatus(filePath: string): LocalFileStatus {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { path: filePath, exists: false, sizeBytes: null, updatedAt: null };
  }
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    exists: true,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function safeReadManifest(manifestPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) return null;
  try {
    return maybeRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  } catch {
    return null;
  }
}

function normalizeLibraryJobId(jobId: string): string {
  const normalized = String(jobId || '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw badRequest('PSD 重建 jobId 无效。');
  }
  return normalized;
}

function directoryUpdatedAt(dir: string): string | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  return fs.statSync(dir).mtime.toISOString();
}

function manifestSourceImage(manifest: Record<string, unknown> | null): Record<string, any> {
  return maybeRecord(manifest?.sourceImage) || {};
}

function manifestLayers(manifest: Record<string, unknown> | null): RebuildLayer[] {
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  return layers.filter((layer): layer is RebuildLayer => Boolean(maybeRecord(layer)));
}

function sourceFromLibraryItem(item: PsdRebuildLibraryItem): SourceImage {
  return {
    uploadId: item.uploadId || null,
    path: item.sourceImagePath,
    width: item.sourceImage.width,
    height: item.sourceImage.height,
    mime: item.sourceImage.mime,
    sizeBytes: item.sourceImage.sizeBytes,
    sha256: item.sourceImage.sha256 || null,
  };
}

function photoshopOpenPathFromManifest(manifest: Record<string, unknown> | null, fallbackPath: string): string {
  const visionInput = maybeRecord(manifest?.visionInput);
  const requestImagePath = String(visionInput?.requestImagePath || '').trim();
  return requestImagePath && fs.existsSync(requestImagePath) && fs.statSync(requestImagePath).isFile()
    ? requestImagePath
    : fallbackPath;
}

function statusFromLibraryFiles(
  manifest: Record<string, unknown> | null,
  outputPsdFile: LocalFileStatus,
): PsdRebuildJobRecord['status'] {
  if (outputPsdFile.exists) return 'psd_exported';
  const manifestStatus = String(manifest?.status || '').trim();
  if (manifestStatus === 'ai_analyzed') return 'analyzed';
  if (manifestStatus === 'single_raster_fallback') return 'fallback';
  return manifest ? 'fallback' : 'failed';
}

function librarySortTime(item: PsdRebuildLibraryItem): number {
  return Date.parse(item.updatedAt || item.generatedAt || item.createdAt || '') || 0;
}

function buildLibraryItem(jobId: string, existing: PsdRebuildJobRecord | null = null): PsdRebuildLibraryDetail | null {
  const normalizedJobId = normalizeLibraryJobId(jobId);
  const dir = path.join(rebuildRoot(), normalizedJobId);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

  const layerManifestPath = existing?.layerManifestPath || path.join(dir, 'layer-manifest.json');
  const photoshopScriptPath = existing?.photoshopScriptPath || path.join(dir, 'rebuild.jsx');
  const outputPsdPath = existing?.outputPsdPath || path.join(dir, 'rebuilt.psd');
  const previewImagePath = existing?.previewImagePath || path.join(dir, 'preview.png');
  const layerManifest = safeReadManifest(layerManifestPath);
  const sourceImage = manifestSourceImage(layerManifest);
  const layers = manifestLayers(layerManifest);
  const textLayerCount = layers.filter((layer) => layer.type === 'text' && String(layer.text || '').trim()).length;
  const outputPsdFile = localFileStatus(outputPsdPath);
  const previewImageFile = localFileStatus(previewImagePath);
  const manifestFile = localFileStatus(layerManifestPath);
  const photoshopScriptFile = localFileStatus(photoshopScriptPath);
  const generatedAt = layerManifest?.generatedAt ? String(layerManifest.generatedAt) : null;
  const updatedAt = outputPsdFile.updatedAt || previewImageFile.updatedAt || manifestFile.updatedAt || directoryUpdatedAt(dir) || existing?.updatedAt || generatedAt || new Date().toISOString();
  const sourcePath = String(sourceImage.path || existing?.sourceImagePath || '').trim();
  const findings = existing?.findings?.length ? existing.findings : [{
    code: 'local_layer_library',
    severity: 'info',
    message: '从本机 PSD 重建目录读取的真实拆层作业。',
  }];

  const item: PsdRebuildLibraryItem = {
    id: normalizedJobId,
    createdAt: existing?.createdAt || generatedAt || updatedAt,
    updatedAt,
    status: statusFromLibraryFiles(layerManifest, outputPsdFile),
    uploadId: sourceImage.uploadId ? String(sourceImage.uploadId) : existing?.uploadId || null,
    sourceImagePath: sourcePath,
    sourceImage: {
      width: finiteNumber(sourceImage.width ?? existing?.sourceImage.width, 0),
      height: finiteNumber(sourceImage.height ?? existing?.sourceImage.height, 0),
      mime: String(sourceImage.mime || existing?.sourceImage.mime || ''),
      sizeBytes: finiteNumber(sourceImage.sizeBytes ?? existing?.sourceImage.sizeBytes, 0),
      sha256: sourceImage.sha256 ? String(sourceImage.sha256) : existing?.sourceImage.sha256 || null,
    },
    layerManifestPath,
    photoshopScriptPath,
    outputPsdPath,
    outputPsdExists: outputPsdFile.exists,
    previewImagePath: previewImageFile.exists ? previewImagePath : null,
    layerCount: layers.length || existing?.layerCount || 0,
    textLayerCount: textLayerCount || existing?.textLayerCount || 0,
    model: layerManifest?.model ? String(layerManifest.model) : existing?.model || null,
    selectedRole: layerManifest?.selectedRole ? String(layerManifest.selectedRole) : existing?.selectedRole || null,
    apiKeyEnv: existing?.apiKeyEnv || null,
    durationMs: existing?.durationMs ?? null,
    fallback: maybeRecord(layerManifest?.fallbackReason)
      ? existing?.fallback || null
      : layerManifest?.fallbackReason
        ? { mode: 'single_raster_manifest', reason: String(layerManifest.fallbackReason), nonBlocking: true }
        : existing?.fallback || null,
    findings,
    psdDelivery: 'local_only',
    generatedAt,
    summary: layerManifest?.summary ? String(layerManifest.summary) : null,
    manifestStatus: layerManifest?.status ? String(layerManifest.status) : null,
    directoryPath: dir,
    manifestFile,
    photoshopScriptFile,
    outputPsdFile,
    previewImageFile,
    visionInput: layerManifest?.visionInput || null,
    layerPolicy: layerManifest?.layerPolicy || null,
  };

  return { job: item, layerManifest };
}

function stateRecordFromLibraryItem(
  item: PsdRebuildLibraryItem,
  findings: PsdRebuildJobRecord['findings'] = item.findings,
): Omit<PsdRebuildJobRecord, 'id' | 'createdAt' | 'updatedAt' | 'psdDelivery'> & {
  id: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: item.id,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    status: item.status,
    uploadId: item.uploadId || null,
    sourceImagePath: item.sourceImagePath,
    sourceImage: item.sourceImage,
    layerManifestPath: item.layerManifestPath,
    photoshopScriptPath: item.photoshopScriptPath || null,
    outputPsdPath: item.outputPsdPath || null,
    outputPsdExists: Boolean(item.outputPsdExists),
    previewImagePath: item.previewImagePath || null,
    layerCount: item.layerCount,
    textLayerCount: item.textLayerCount,
    model: item.model || null,
    selectedRole: item.selectedRole || null,
    apiKeyEnv: item.apiKeyEnv || null,
    durationMs: item.durationMs ?? null,
    fallback: item.fallback || null,
    findings,
  };
}

export function listPsdRebuildLibrary(input: { limit?: number } = {}): Record<string, unknown> {
  const root = rebuildRoot();
  const existingById = new Map(listPsdRebuildJobs().map((job) => [job.id, job]));
  const ids = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[A-Za-z0-9._-]+$/.test(entry.name)) ids.add(entry.name);
  }
  for (const job of existingById.values()) {
    if (job.id && /^[A-Za-z0-9._-]+$/.test(job.id)) ids.add(job.id);
  }
  const items = Array.from(ids)
    .map((id) => buildLibraryItem(id, existingById.get(id) || null)?.job || null)
    .filter((item): item is PsdRebuildLibraryItem => Boolean(item))
    .sort((a, b) => librarySortTime(b) - librarySortTime(a));
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit || 50))));
  return {
    ok: true,
    root,
    count: items.length,
    items: items.slice(0, limit),
  };
}

export function getPsdRebuildLibraryJob(jobId: string): PsdRebuildLibraryDetail {
  const normalizedJobId = normalizeLibraryJobId(jobId);
  const detail = buildLibraryItem(normalizedJobId, getPsdRebuildJob(normalizedJobId));
  if (!detail) throw badRequest('本机拆解图层库中没有这个 PSD 重建 job。');
  return detail;
}

export async function exportPsdRebuildLibraryJob(jobId: string): Promise<Record<string, unknown>> {
  const before = getPsdRebuildLibraryJob(jobId);
  if (!before.job.photoshopScriptFile.exists || !before.job.photoshopScriptPath) {
    throw badRequest('这个 PSD 重建 job 缺少 rebuild.jsx，无法执行 Photoshop 导出。');
  }
  writePhotoshopScript({
    source: sourceFromLibraryItem(before.job),
    sourceOpenPath: photoshopOpenPathFromManifest(before.layerManifest, before.job.sourceImagePath),
    layers: manifestLayers(before.layerManifest),
    outputPsdPath: before.job.outputPsdPath || path.join(before.job.directoryPath, 'rebuilt.psd'),
    previewImagePath: before.job.previewImageFile.path || path.join(before.job.directoryPath, 'preview.png'),
    manifestPath: before.job.layerManifestPath,
    scriptPath: before.job.photoshopScriptPath,
  });
  const photoshopResult = await runPhotoshopScript(before.job.photoshopScriptPath);
  const after = getPsdRebuildLibraryJob(jobId);
  const outputExists = Boolean(after.job.outputPsdFile.exists);
  const baseFindings = after.job.findings.filter((finding) => !new Set([
    'photoshop_rebuild_not_exported',
    'photoshop_rebuild_exported',
    'photoshop_execution_skipped',
  ]).has(String(finding.code || '')));
  const findings = [
    ...baseFindings,
    photoshopResult.ok && outputExists
      ? {
          code: 'photoshop_rebuild_exported',
          severity: 'info',
          message: '已执行本机 Photoshop JSX，并生成本地 rebuilt.psd。',
        }
      : {
          code: 'photoshop_rebuild_not_exported',
          severity: 'warning',
          message: photoshopResult.error || 'Photoshop 执行完成但未发现 rebuilt.psd；请检查 Photoshop 日志或手动运行 JSX。',
        },
  ];
  const record = addPsdRebuildJob(stateRecordFromLibraryItem(after.job, findings));
  const updated = getPsdRebuildLibraryJob(jobId);
  return {
    ok: true,
    job: {
      ...updated.job,
      ...record,
      manifestFile: updated.job.manifestFile,
      photoshopScriptFile: updated.job.photoshopScriptFile,
      outputPsdFile: updated.job.outputPsdFile,
      previewImageFile: updated.job.previewImageFile,
      directoryPath: updated.job.directoryPath,
      summary: updated.job.summary,
      manifestStatus: updated.job.manifestStatus,
      generatedAt: updated.job.generatedAt,
      visionInput: updated.job.visionInput,
      layerPolicy: updated.job.layerPolicy,
      findings,
    },
    layerManifest: updated.layerManifest,
    photoshop: {
      executed: true,
      result: photoshopResult,
      outputPsdExists: outputExists,
      outputPsdPath: after.job.outputPsdPath,
      previewImagePath: after.job.previewImagePath,
      localOnly: true,
    },
    library: listPsdRebuildLibrary(),
  };
}

function safeAddLayerAnalysisUsage(input: {
  source: SourceImage;
  status: 'completed' | 'fallback';
  model?: string | null;
  selectedRole?: string | null;
  apiKeyEnv?: string | null;
  durationMs: number;
  metadataPath?: string | null;
  fallbackReason?: string | null;
  attempts?: unknown;
  usage?: Record<string, unknown> | null;
}): void {
  const route = getResolvedModelRoute('vision');
  try {
    addModelUsageRecord({
      operation: 'vision.layer_analysis',
      routeKey: 'vision',
      status: input.status,
      model: input.model || null,
      provider: route.provider,
      sourceKind: route.sourceKind,
      durationMs: input.durationMs,
      input: {
        imagePath: input.source.path,
        requestedModel: input.model || null,
      },
      artifact: {
        path: input.source.path,
        metadataPath: input.metadataPath || null,
        sizeBytes: input.source.sizeBytes,
        mime: input.source.mime,
      },
      fallback: input.fallbackReason ? {
        mode: 'single_raster_manifest',
        reason: input.fallbackReason,
      } : null,
      audit: {
        routePrimary: route.primary,
        routeFallback: route.fallback,
        selectedRole: input.selectedRole || null,
        apiKeyEnv: input.apiKeyEnv || null,
        usage: input.usage || null,
        attempts: Array.isArray(input.attempts) ? input.attempts as any[] : [],
      },
      findings: route.findings,
      error: input.fallbackReason || null,
      nonBlocking: true,
    });
  } catch (error) {
    console.warn('[psd-rebuild:audit]', safeError(error));
  }
}

export async function createPsdRebuildJob(input: CreatePsdRebuildJobInput): Promise<Record<string, unknown>> {
  const source = resolveSource(input);
  const jobId = crypto.randomUUID();
  const dir = rebuildDir(jobId);
  const layerManifestPath = path.join(dir, 'layer-manifest.json');
  const photoshopScriptPath = path.join(dir, 'rebuild.jsx');
  const outputPsdPath = path.join(dir, 'rebuilt.psd');
  const previewImagePath = path.join(dir, 'preview.png');
  const startedAt = Date.now();
  let analysisJson: Record<string, any> | null = null;
  let analysisRawText: string | null = null;
  let model: string | null = null;
  let selectedRole: string | null = null;
  let apiKeyEnv: string | null = null;
  let analysisUsage: Record<string, unknown> | null = null;
  let analysisAttempts: unknown = [];
  let analysisRequestImagePath: string | null = null;
  let analysisImageCompatibility: Record<string, unknown> | null = null;
  let fallbackReason: string | null = null;

  try {
    const result = await runVisionLayerAnalysis({
      imagePath: source.path,
      modelId: String(input.modelId || '').trim(),
      prompt: String(input.prompt || '').trim(),
    }) as Record<string, any>;
    const analysis = maybeRecord(result.analysis) || {};
    analysisRawText = String(analysis.rawText || '').trim() || null;
    analysisJson = analysisRawText ? parseAnalysisJson(analysisRawText) : null;
    model = analysis.model ? String(analysis.model) : null;
    selectedRole = analysis.selectedRole ? String(analysis.selectedRole) : null;
    apiKeyEnv = analysis.apiKeyEnv ? String(analysis.apiKeyEnv) : null;
    analysisUsage = maybeRecord(analysis.usage);
    analysisAttempts = Array.isArray(analysis.attempts) ? analysis.attempts : [];
    analysisRequestImagePath = analysis.requestImagePath ? String(analysis.requestImagePath) : null;
    analysisImageCompatibility = maybeRecord(analysis.imageCompatibility);
    if (!analysisJson) fallbackReason = '视觉模型返回了文本，但不是可解析的严格 JSON，已保留 rawAnalysisText 并使用单图层 fallback。';
  } catch (error) {
    const details = maybeRecord((error as { details?: unknown } | null)?.details) || {};
    analysisAttempts = Array.isArray(details.attempts)
      ? details.attempts
      : Array.isArray(details.failures)
        ? details.failures
        : [];
    fallbackReason = safeError(error);
  }

  const layers = layersFromAnalysis(analysisJson, source);
  const manifestStatus = analysisJson ? 'ai_analyzed' : 'single_raster_fallback';
  const manifest = buildManifest({
    jobId,
    source,
    analysisJson,
    analysisRawText,
    layers,
    status: manifestStatus,
    model,
    selectedRole,
    fallbackReason,
    analysisRequestImagePath,
    analysisImageCompatibility,
  });
  fs.writeFileSync(layerManifestPath, JSON.stringify(manifest, null, 2));
  writePhotoshopScript({
    source,
    sourceOpenPath: analysisRequestImagePath,
    layers,
    outputPsdPath,
    previewImagePath,
    manifestPath: layerManifestPath,
    scriptPath: photoshopScriptPath,
  });

  safeAddLayerAnalysisUsage({
    source,
    status: analysisJson ? 'completed' : 'fallback',
    model,
    selectedRole,
    apiKeyEnv,
    durationMs: Date.now() - startedAt,
    metadataPath: layerManifestPath,
    fallbackReason,
    attempts: analysisAttempts,
    usage: analysisUsage,
  });

  const findings: PsdRebuildJobRecord['findings'] = [];
  if (!analysisJson) {
    findings.push({
      code: 'single_raster_fallback',
      severity: 'warning',
      message: fallbackReason || '未得到结构化拆层 JSON，已生成真实单图层重建包。',
    });
  }
  findings.push({
    code: 'not_original_psd_layers',
    severity: 'info',
    message: '当前结果是 AI 重建层，不是从 JPG/PNG/WEBP 中恢复出的原始 PSD 图层。',
  });

  let photoshopResult: Awaited<ReturnType<typeof runPhotoshopScript>> | null = null;
  if (input.executePhotoshop) {
    photoshopResult = await runPhotoshopScript(photoshopScriptPath);
    if (!photoshopResult.ok) {
      findings.push({
        code: 'photoshop_rebuild_not_exported',
        severity: 'warning',
        message: photoshopResult.error || 'Photoshop 未导出 PSD；可用 JSX 脚本人工执行。',
      });
    }
  } else {
    findings.push({
      code: 'photoshop_execution_skipped',
      severity: 'info',
      message: '本次只生成重建包和 Photoshop JSX，未自动执行 Photoshop。',
    });
  }

  const outputPsdExists = fs.existsSync(outputPsdPath) && fs.statSync(outputPsdPath).isFile();
  const previewExists = fs.existsSync(previewImagePath) && fs.statSync(previewImagePath).isFile();
  const record = addPsdRebuildJob({
    id: jobId,
    status: outputPsdExists ? 'psd_exported' : analysisJson ? 'analyzed' : 'fallback',
    uploadId: source.uploadId,
    sourceImagePath: source.path,
    sourceImage: {
      width: source.width,
      height: source.height,
      mime: source.mime,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
    },
    layerManifestPath,
    photoshopScriptPath,
    outputPsdPath,
    outputPsdExists,
    previewImagePath: previewExists ? previewImagePath : null,
    layerCount: layers.length,
    textLayerCount: layers.filter((layer) => layer.type === 'text' && layer.text).length,
    model,
    selectedRole,
    apiKeyEnv,
    durationMs: Date.now() - startedAt,
    fallback: fallbackReason ? {
      mode: 'single_raster_manifest',
      reason: fallbackReason,
      nonBlocking: true,
    } : null,
    findings,
  });

  return {
    ok: true,
    job: record,
    layerManifest: manifest,
    photoshop: {
      executed: Boolean(input.executePhotoshop),
      result: photoshopResult,
      outputPsdExists,
      localOnly: true,
    },
  };
}
