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
  layers: RebuildLayer[];
  outputPsdPath: string;
  previewImagePath: string;
  manifestPath: string;
  scriptPath: string;
}): void {
  const textLayers = input.layers.filter((layer) => layer.type === 'text' && String(layer.text || '').trim());
  const script = `#target photoshop
app.displayDialogs = DialogModes.NO;
var sourceFile = File(${jsxString(input.source.path)});
var outputFile = File(${jsxString(input.outputPsdPath)});
var previewFile = File(${jsxString(input.previewImagePath)});
var manifestFile = File(${jsxString(input.manifestPath)});
if (!sourceFile.exists) {
  throw new Error("Source image missing: " + sourceFile.fsName);
}
var doc = app.open(sourceFile);
try {
  doc.activeLayer.name = "Original flattened image";
} catch (renameError) {}
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
    `set jsFile to POSIX file ${JSON.stringify(scriptPath)}`,
    `tell application ${JSON.stringify(appName)}`,
    'activate',
    'do javascript jsFile',
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
