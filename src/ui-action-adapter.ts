import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { BRIDGE_ROOT, runtimePath } from './config.js';

export type UiActionType =
  | 'text.replace'
  | 'text.clear'
  | 'image.replace.local'
  | 'image.replace.ai'
  | 'transform.update'
  | 'layer.hide';

export type UiAction = {
  id?: string;
  type?: UiActionType | string;
  slotKey?: string;
  value?: string;
  sourcePath?: string;
  sourceRef?: string;
  modelId?: string;
  prompt?: string;
  move?: { x?: number; y?: number };
  scalePercent?: number;
  rotateDeg?: number;
};

export type PhotoshopEditAction = {
  type: 'replace_text' | 'replace_image' | 'transform_layer' | 'toggle_layer' | 'export_profile';
  target?: string;
  value?: string;
  sourceRef?: string;
  scalePercent?: number;
  move?: { x?: number; y?: number };
  rotateDeg?: number;
  visible?: boolean;
  note?: string;
};

export type LayerBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type TextSlot = {
  key: string;
  layerPath: string;
  maxChars?: number;
  multiline?: boolean;
  bounds?: LayerBounds;
};

export type ImageSlot = {
  key: string;
  layerPath: string;
  replaceMode: string;
  bounds?: LayerBounds;
  targetSize?: { width: number; height: number };
  targetAspectRatio?: { width: number; height: number; label?: string };
};

export type TransformSlot = {
  key: string;
  layerPath: string;
  allowMove?: boolean;
  allowScale?: boolean;
  allowRotate?: boolean;
};

export type ToggleSlot = {
  key: string;
  layerPath: string;
  defaultVisible?: boolean;
};

export type PhotoshopTemplateManifest = {
  templateId?: string;
  displayName?: string;
  tags?: string[];
  texts?: TextSlot[];
  images?: ImageSlot[];
  transforms?: TransformSlot[];
  toggles?: ToggleSlot[];
  exports?: Record<string, unknown>;
};

export type UiSlotSummary = {
  key: string;
  layerPath: string;
  primaryType: 'text' | 'image' | 'transform' | 'toggle';
  capabilities: Array<'text' | 'image' | 'transform' | 'toggle'>;
  maxChars?: number;
  multiline?: boolean;
  bounds?: LayerBounds;
  boundsSource?: 'manifest' | 'layer_dump';
  boundsUnavailableReason?: string;
  previewText?: string;
  targetSize?: { width: number; height: number };
  targetAspectRatio?: { width: number; height: number; label?: string };
  replaceMode?: string;
};

export type ManifestInspection = {
  templateId: string | null;
  displayName: string | null;
  manifestPath: string;
  document: {
    width: number;
    height: number;
    sourcePath: string | null;
  } | null;
  previewImagePath: string | null;
  layerDump: {
    status: 'not_requested' | 'ready' | 'failed';
    path: string | null;
    source: 'cache' | 'generated' | null;
    textBoundsMatched: number;
    error: string | null;
  };
  counts: {
    text: number;
    image: number;
    transform: number;
    toggle: number;
  };
  capabilities: {
    textKeys: string[];
    imageKeys: string[];
    transformKeys: string[];
    toggleKeys: string[];
  };
  slots: UiSlotSummary[];
  manifest: PhotoshopTemplateManifest;
};

export type ManifestInspectionOptions = {
  psdPath?: string;
};

export type UiActionRejected = {
  index: number;
  code: string;
  message: string;
  action: UiAction;
};

export type UiActionFinding = {
  severity: 'info' | 'warning';
  code: string;
  message: string;
};

export type UiActionPreflight = {
  status: 'ready' | 'blocked';
  manifest: Omit<ManifestInspection, 'manifest'>;
  normalizedActions: PhotoshopEditAction[];
  resolvedAssetPaths: Record<string, string>;
  rejectedActions: UiActionRejected[];
  missing: string[];
  manualRequiredReasons: string[];
  findings: UiActionFinding[];
};

type LayerDumpLayer = {
  path?: string;
  kind?: string;
  bounds?: unknown;
  contents?: unknown;
};

type LayerDumpPayload = {
  documentWidth?: number;
  documentHeight?: number;
  layers?: LayerDumpLayer[];
};

type LayerDumpInspection = {
  status: 'not_requested' | 'ready' | 'failed';
  path: string | null;
  source: 'cache' | 'generated' | null;
  error: string | null;
  payload: LayerDumpPayload | null;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeLayerBounds(value: unknown): LayerBounds | null {
  const raw = asObject(value);
  const left = normalizeNumber(raw.left);
  const top = normalizeNumber(raw.top);
  const right = normalizeNumber(raw.right);
  const bottom = normalizeNumber(raw.bottom);
  const width = normalizeNumber(raw.width);
  const height = normalizeNumber(raw.height);
  if (
    typeof left !== 'number'
    || typeof top !== 'number'
    || typeof right !== 'number'
    || typeof bottom !== 'number'
    || typeof width !== 'number'
    || typeof height !== 'number'
    || right < left
    || bottom < top
    || width <= 0
    || height <= 0
  ) {
    return null;
  }
  return { left, top, right, bottom, width, height };
}

function normalizeMove(value: unknown): { x?: number; y?: number } | undefined {
  const raw = asObject(value);
  const x = normalizeNumber(raw.x);
  const y = normalizeNumber(raw.y);
  if (typeof x !== 'number' && typeof y !== 'number') return undefined;
  return { x, y };
}

function normalizeUiAction(value: unknown): UiAction {
  const raw = asObject(value);
  return {
    id: asString(raw.id) || undefined,
    type: asString(raw.type),
    slotKey: asString(raw.slotKey || raw.target).trim(),
    value: typeof raw.value === 'string' ? raw.value : undefined,
    sourcePath: asString(raw.sourcePath).trim() || undefined,
    sourceRef: asString(raw.sourceRef).trim() || undefined,
    modelId: asString(raw.modelId).trim() || undefined,
    prompt: asString(raw.prompt).trim() || undefined,
    move: normalizeMove(raw.move),
    scalePercent: normalizeNumber(raw.scalePercent),
    rotateDeg: normalizeNumber(raw.rotateDeg),
  };
}

function keyMap<T extends { key: string }>(items: T[] | undefined): Map<string, T> {
  return new Map((items || []).map((item) => [item.key, item]));
}

function cloneManifest(value: unknown): PhotoshopTemplateManifest {
  const raw = asObject(value);
  return {
    templateId: asString(raw.templateId) || undefined,
    displayName: asString(raw.displayName) || undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    texts: Array.isArray(raw.texts) ? raw.texts as TextSlot[] : [],
    images: Array.isArray(raw.images) ? raw.images as ImageSlot[] : [],
    transforms: Array.isArray(raw.transforms) ? raw.transforms as TransformSlot[] : [],
    toggles: Array.isArray(raw.toggles) ? raw.toggles as ToggleSlot[] : [],
    exports: asObject(raw.exports),
  };
}

function readPsdDocumentSize(psdPath: string | undefined): ManifestInspection['document'] {
  const resolvedPath = path.resolve(String(psdPath || '').trim());
  if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) return null;
  const header = Buffer.alloc(26);
  const fd = fs.openSync(resolvedPath, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString('ascii', 0, 4) !== '8BPS') return null;
  const height = header.readUInt32BE(14);
  const width = header.readUInt32BE(18);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, sourcePath: resolvedPath };
}

function layerDumpScriptPath(): string {
  return path.resolve(BRIDGE_ROOT, '..', 'scripts', 'photoshop-dump-psd-layers.py');
}

function layerDumpPythonCandidates(): string[] {
  const candidates = [
    String(process.env.PHOTOSHOP_PSD_TOOLS_PYTHON || '').trim(),
    path.resolve(BRIDGE_ROOT, '..', '.runtime', 'psd-tools-venv', 'bin', 'python'),
    'python3',
  ].filter(Boolean);
  return candidates.filter((candidate, index, list) => list.indexOf(candidate) === index);
}

function layerDumpCachePath(psdPath: string): string {
  const stat = fs.statSync(psdPath);
  const hash = crypto
    .createHash('sha1')
    .update(`${psdPath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  return runtimePath('layer-dumps', `${hash}.json`);
}

function summarizeSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  const stderr = String(result.stderr || '').trim();
  if (stderr) return stderr.split(/\r?\n/)[0] || stderr;
  const stdout = String(result.stdout || '').trim();
  if (stdout) return stdout.split(/\r?\n/)[0] || stdout;
  return `exit=${result.status}`;
}

function readLayerDumpPayload(filePath: string): LayerDumpPayload | null {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const raw = asObject(parsed);
  return {
    documentWidth: normalizeNumber(raw.documentWidth),
    documentHeight: normalizeNumber(raw.documentHeight),
    layers: Array.isArray(raw.layers) ? raw.layers as LayerDumpLayer[] : [],
  };
}

function loadLayerDumpForInspection(psdPath: string | undefined): LayerDumpInspection {
  const resolvedPsdPath = path.resolve(String(psdPath || '').trim());
  if (!resolvedPsdPath || !fs.existsSync(resolvedPsdPath) || !fs.statSync(resolvedPsdPath).isFile()) {
    return { status: 'not_requested', path: null, source: null, error: null, payload: null };
  }

  const scriptPath = layerDumpScriptPath();
  if (!fs.existsSync(scriptPath)) {
    return {
      status: 'failed',
      path: null,
      source: null,
      error: `离线 PSD layer-dump 脚本不存在：${scriptPath}`,
      payload: null,
    };
  }

  const outputPath = layerDumpCachePath(resolvedPsdPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) {
    return {
      status: 'ready',
      path: outputPath,
      source: 'cache',
      error: null,
      payload: readLayerDumpPayload(outputPath),
    };
  }

  const failures: string[] = [];
  for (const pythonPath of layerDumpPythonCandidates()) {
    if (pythonPath !== 'python3' && !fs.existsSync(pythonPath)) {
      failures.push(`${pythonPath}: not found`);
      continue;
    }
    const result = spawnSync(pythonPath, [scriptPath, resolvedPsdPath, '--out', outputPath], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (result.status === 0 && fs.existsSync(outputPath)) {
      return {
        status: 'ready',
        path: outputPath,
        source: 'generated',
        error: null,
        payload: readLayerDumpPayload(outputPath),
      };
    }
    failures.push(`${pythonPath}: ${summarizeSpawnFailure(result)}`);
  }

  return {
    status: 'failed',
    path: null,
    source: null,
    error: failures.join('; ') || '离线 PSD layer-dump 生成失败',
    payload: null,
  };
}

function isTextLayer(layer: LayerDumpLayer): boolean {
  return String(layer.kind || '').includes('TEXT') || typeof layer.contents === 'string';
}

function textLayerDumpByPath(layerDump: LayerDumpPayload | null): Map<string, { bounds: LayerBounds; contents?: string }> {
  const result = new Map<string, { bounds: LayerBounds; contents?: string }>();
  for (const layer of layerDump?.layers || []) {
    const layerPath = String(layer.path || '').trim();
    const bounds = normalizeLayerBounds(layer.bounds);
    if (!layerPath || !bounds || !isTextLayer(layer)) continue;
    result.set(layerPath, {
      bounds,
      ...(typeof layer.contents === 'string' ? { contents: layer.contents } : {}),
    });
  }
  return result;
}

function inferDocumentSize(manifest: PhotoshopTemplateManifest): ManifestInspection['document'] {
  const bounds = (manifest.images || [])
    .map((slot) => slot.bounds)
    .filter((item): item is LayerBounds => Boolean(item));
  if (bounds.length === 0) return null;
  const width = Math.ceil(Math.max(...bounds.map((item) => item.right), 1));
  const height = Math.ceil(Math.max(...bounds.map((item) => item.bottom), 1));
  return { width, height, sourcePath: null };
}

function resolvePreviewImagePath(manifestPath: string): string | null {
  const dir = path.dirname(manifestPath);
  const baseName = path.basename(manifestPath).replace(/\.psd\.auto\.json$/i, '').replace(/\.json$/i, '');
  const candidates = [
    'preview.jpg',
    'preview.jpeg',
    'preview.png',
    'preview.webp',
    `${baseName}.jpg`,
    `${baseName}.jpeg`,
    `${baseName}.png`,
    `${baseName}.webp`,
  ].map((name) => path.join(dir, name));
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return found ? path.resolve(found) : null;
}

export function readTemplateManifest(manifestPath: string): PhotoshopTemplateManifest {
  const resolvedPath = path.resolve(String(manifestPath || '').trim());
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error('manifestPath 不存在，无法读取真实模板 manifest。');
  }
  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error('manifestPath 不是文件。');
  }
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
  const manifest = cloneManifest(parsed);
  if (!manifest.texts?.length && !manifest.images?.length && !manifest.transforms?.length) {
    throw new Error('manifest 未包含可用的 texts/images/transforms 槽位。');
  }
  return manifest;
}

export function inspectTemplateManifest(
  manifestPath: string,
  options: ManifestInspectionOptions = {},
): ManifestInspection {
  const resolvedPath = path.resolve(String(manifestPath || '').trim());
  const manifest = readTemplateManifest(resolvedPath);
  const layerDumpInspection = loadLayerDumpForInspection(options.psdPath);
  const textLayerBounds = textLayerDumpByPath(layerDumpInspection.payload);
  let textBoundsMatched = 0;
  const slotByKey = new Map<string, UiSlotSummary>();

  function ensureSlot(key: string, layerPath: string, primaryType: UiSlotSummary['primaryType']): UiSlotSummary {
    const existing = slotByKey.get(key);
    if (existing) {
      if (!existing.capabilities.includes(primaryType)) existing.capabilities.push(primaryType);
      return existing;
    }
    const next: UiSlotSummary = {
      key,
      layerPath,
      primaryType,
      capabilities: [primaryType],
    };
    slotByKey.set(key, next);
    return next;
  }

  for (const slot of manifest.texts || []) {
    const summary = ensureSlot(slot.key, slot.layerPath, 'text');
    summary.maxChars = slot.maxChars;
    summary.multiline = slot.multiline;
    const manifestBounds = normalizeLayerBounds(slot.bounds);
    if (manifestBounds) {
      summary.bounds = manifestBounds;
      summary.boundsSource = 'manifest';
    } else {
      const dumpLayer = textLayerBounds.get(String(slot.layerPath || '').trim());
      if (dumpLayer) {
        summary.bounds = dumpLayer.bounds;
        summary.boundsSource = 'layer_dump';
        summary.previewText = dumpLayer.contents;
        textBoundsMatched += 1;
      } else {
        summary.boundsUnavailableReason = layerDumpInspection.status === 'failed'
          ? `文本图层 bounds 未读取：${layerDumpInspection.error || 'layer-dump 失败'}`
          : layerDumpInspection.status === 'not_requested'
            ? '文本 slot 未提供 bounds，且未提供真实 psdPath 生成 layer-dump。'
            : 'layer-dump 中未找到与该 layerPath 完全匹配的文本图层。';
      }
    }
  }
  for (const slot of manifest.images || []) {
    const summary = ensureSlot(slot.key, slot.layerPath, 'image');
    const bounds = normalizeLayerBounds(slot.bounds);
    if (bounds) {
      summary.bounds = bounds;
      summary.boundsSource = 'manifest';
    } else {
      summary.boundsUnavailableReason = '图片 slot 未在 manifest 中提供真实 bounds。';
    }
    summary.targetSize = slot.targetSize;
    summary.targetAspectRatio = slot.targetAspectRatio;
    summary.replaceMode = slot.replaceMode;
  }
  for (const slot of manifest.transforms || []) {
    ensureSlot(slot.key, slot.layerPath, 'transform');
  }
  for (const slot of manifest.toggles || []) {
    ensureSlot(slot.key, slot.layerPath, 'toggle');
  }

  const textKeys = (manifest.texts || []).map((item) => item.key);
  const imageKeys = (manifest.images || []).map((item) => item.key);
  const transformKeys = (manifest.transforms || []).map((item) => item.key);
  const toggleKeys = (manifest.toggles || []).map((item) => item.key);

  return {
    templateId: manifest.templateId || null,
    displayName: manifest.displayName || null,
    manifestPath: resolvedPath,
    document: readPsdDocumentSize(options.psdPath) || inferDocumentSize(manifest),
    previewImagePath: resolvePreviewImagePath(resolvedPath),
    layerDump: {
      status: layerDumpInspection.status,
      path: layerDumpInspection.path,
      source: layerDumpInspection.source,
      textBoundsMatched,
      error: layerDumpInspection.error,
    },
    counts: {
      text: textKeys.length,
      image: imageKeys.length,
      transform: transformKeys.length,
      toggle: toggleKeys.length,
    },
    capabilities: {
      textKeys,
      imageKeys,
      transformKeys,
      toggleKeys,
    },
    slots: Array.from(slotByKey.values()),
    manifest,
  };
}

function buildSourceRef(action: UiAction, index: number): string {
  if (action.sourceRef) return action.sourceRef;
  const base = `${action.slotKey || 'asset'}-${index + 1}`;
  return base.replace(/[^\p{L}\p{N}_-]+/gu, '-');
}

function pushRejected(
  rejectedActions: UiActionRejected[],
  index: number,
  action: UiAction,
  code: string,
  message: string,
): void {
  rejectedActions.push({ index, code, message, action });
}

function pushFinding(
  findings: UiActionFinding[],
  severity: UiActionFinding['severity'],
  code: string,
  message: string,
): void {
  findings.push({ severity, code, message });
}

export function preflightUiActions(manifestPath: string, rawActions: unknown[]): UiActionPreflight {
  const inspection = inspectTemplateManifest(manifestPath);
  const manifest = inspection.manifest;
  const textSlots = keyMap(manifest.texts);
  const imageSlots = keyMap(manifest.images);
  const transformSlots = keyMap(manifest.transforms);
  const toggleSlots = keyMap(manifest.toggles);
  const actions = rawActions.map(normalizeUiAction);
  const normalizedActions: PhotoshopEditAction[] = [];
  const resolvedAssetPaths: Record<string, string> = {};
  const rejectedActions: UiActionRejected[] = [];
  const missing: string[] = [];
  const manualRequiredReasons: string[] = [];
  const findings: UiActionFinding[] = [];

  actions.forEach((action, index) => {
    const slotKey = String(action.slotKey || '').trim();
    if (!slotKey) {
      pushRejected(rejectedActions, index, action, 'missing_slot', '动作缺少 slotKey。');
      return;
    }

    if (action.type === 'text.replace' || action.type === 'text.clear') {
      const slot = textSlots.get(slotKey);
      if (!slot) {
        pushRejected(rejectedActions, index, action, 'unknown_text_slot', `模板未定义文本槽位：${slotKey}`);
        return;
      }
      const value = action.type === 'text.clear' ? '' : String(action.value || '');
      if (typeof slot.maxChars === 'number' && value.length > slot.maxChars) {
        pushFinding(findings, 'warning', 'text_over_max_chars', `文本槽位「${slotKey}」当前 ${value.length} 字，超过建议上限 ${slot.maxChars} 字。`);
      }
      normalizedActions.push({
        type: 'replace_text',
        target: slotKey,
        value,
        note: action.type === 'text.clear' ? 'UI 清空文本' : 'UI 文本替换',
      });
      return;
    }

    if (action.type === 'image.replace.local' || action.type === 'image.replace.ai') {
      const slot = imageSlots.get(slotKey);
      if (!slot) {
        pushRejected(rejectedActions, index, action, 'unknown_image_slot', `模板未定义图片槽位：${slotKey}`);
        return;
      }
      const sourcePath = String(action.sourcePath || '').trim();
      if (!sourcePath) {
        const reason = action.type === 'image.replace.ai'
          ? `AI 生图动作「${slotKey}」尚未提供真实生成文件路径。`
          : `图片替换动作「${slotKey}」缺少真实本地素材路径。`;
        pushRejected(rejectedActions, index, action, 'missing_source_file', reason);
        missing.push(reason);
        return;
      }
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        const reason = `图片素材不存在或不是文件：${sourcePath}`;
        pushRejected(rejectedActions, index, action, 'source_file_not_found', reason);
        missing.push(reason);
        return;
      }
      if (action.type === 'image.replace.ai' && !action.modelId) {
        pushRejected(rejectedActions, index, action, 'model_not_configured', `AI 生图动作「${slotKey}」缺少已配置模型。`);
        return;
      }
      const sourceRef = buildSourceRef(action, index);
      resolvedAssetPaths[sourceRef] = path.resolve(sourcePath);
      normalizedActions.push({
        type: 'replace_image',
        target: slotKey,
        sourceRef,
        note: action.type === 'image.replace.ai'
          ? `UI AI 生图替换：${action.modelId || '未配置模型'}`
          : 'UI 本地图片替换',
      });
      return;
    }

    if (action.type === 'transform.update') {
      const slot = transformSlots.get(slotKey);
      if (!slot) {
        pushRejected(rejectedActions, index, action, 'unknown_transform_slot', `模板未定义可变换槽位：${slotKey}`);
        return;
      }
      const next: PhotoshopEditAction = { type: 'transform_layer', target: slotKey, note: 'UI 位置变换' };
      const move = action.move;
      if (move && (typeof move.x === 'number' || typeof move.y === 'number')) {
        if (!slot.allowMove) {
          pushRejected(rejectedActions, index, action, 'move_not_allowed', `槽位「${slotKey}」未声明允许移动。`);
          return;
        }
        next.move = move;
      }
      if (typeof action.scalePercent === 'number') {
        if (!slot.allowScale) {
          pushRejected(rejectedActions, index, action, 'scale_not_allowed', `槽位「${slotKey}」未声明允许缩放。`);
          return;
        }
        next.scalePercent = action.scalePercent;
      }
      if (typeof action.rotateDeg === 'number') {
        if (!slot.allowRotate) {
          pushRejected(rejectedActions, index, action, 'rotate_not_allowed', `槽位「${slotKey}」未声明允许旋转。`);
          return;
        }
        next.rotateDeg = action.rotateDeg;
      }
      if (!next.move && typeof next.scalePercent !== 'number' && typeof next.rotateDeg !== 'number') {
        pushRejected(rejectedActions, index, action, 'empty_transform', `槽位「${slotKey}」未设置移动、缩放或旋转参数。`);
        return;
      }
      normalizedActions.push(next);
      return;
    }

    if (action.type === 'layer.hide') {
      const slot = toggleSlots.get(slotKey);
      if (!slot) {
        const reason = `模板未定义显隐槽位「${slotKey}」；当前 v1 不会删除图层，也不会绕过 manifest 直接隐藏任意图层。`;
        pushRejected(rejectedActions, index, action, 'toggle_slot_missing', reason);
        manualRequiredReasons.push(reason);
        return;
      }
      normalizedActions.push({
        type: 'toggle_layer',
        target: slotKey,
        visible: false,
        note: 'UI 隐藏图层',
      });
      return;
    }

    pushRejected(rejectedActions, index, action, 'unsupported_action_type', `不支持的 UI action 类型：${action.type || '空'}`);
  });

  const { manifest: _manifest, ...manifestSummary } = inspection;
  return {
    status: rejectedActions.length > 0 ? 'blocked' : 'ready',
    manifest: manifestSummary,
    normalizedActions,
    resolvedAssetPaths,
    rejectedActions,
    missing,
    manualRequiredReasons,
    findings,
  };
}
