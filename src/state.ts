import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { runtimePath } from './config.js';
import type { UiAction } from './ui-action-adapter.js';

export type DownloadRecord = {
  id: string;
  createdAt: string;
  status: string;
  title: string;
  detailUrl: string;
  inboxDir?: string;
  previewImagePath?: string | null;
  downloadedFilePath?: string | null;
  primaryPsdPath?: string | null;
  draftPath?: string | null;
  findings: string[];
};

export type ConsoleJobRecord = {
  id: string;
  createdAt: string;
  sessionId: string;
  status: string;
  templateDisplayName?: string;
  originalPsdPath: string;
  workingPsdPath: string;
};

export type ActionPresetRecord = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  templateId?: string | null;
  templateDisplayName?: string | null;
  actionCount: number;
  slotKeys: string[];
  uiActions: UiAction[];
};

export type DerivedTargetRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastLoadedAt?: string | null;
  sourcePreset: {
    id: string;
    name: string;
    actionCount: number;
    slotKeys: string[];
  };
  targetPreset: {
    id: string;
    name: string;
    actionCount: number;
    slotKeys: string[];
  };
  targetManifest: {
    templateId: string | null;
    displayName: string | null;
    manifestPath: string;
    psdPath: string | null;
  };
  appliedMappings: Array<{
    sourceSlotKey: string;
    capability: string;
    targetSlotKey: string;
    targetLayerPath?: string;
  }>;
};

export type FeishuTargetRecord = {
  id: string;
  type: 'chat' | 'user';
  value: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
};

export type FeishuQualityGateRecord = {
  status: 'completed' | 'fallback' | 'skipped';
  checkedAt?: string | null;
  model?: string | null;
  selectedRole?: string | null;
  apiKeyEnv?: string | null;
  routePrimary?: string | null;
  routeFallback?: string | null;
  durationMs?: number | null;
  imagePath?: string | null;
  summaryPreview?: string | null;
  usage?: Record<string, unknown> | null;
  fallback?: {
    mode?: string | null;
    reason?: string | null;
    nonBlocking?: boolean;
  } | null;
  nonBlocking: boolean;
};

export type FeishuSendRecord = {
  id: string;
  createdAt: string;
  status: 'sent' | 'failed';
  target: {
    type: 'chat' | 'user' | null;
    value: string | null;
    source?: string | null;
  } | null;
  finalImage: {
    path: string | null;
    fileName?: string | null;
    sizeBytes?: number | null;
    delivery?: string | null;
  };
  messageCount?: number | null;
  messageIds?: string[];
  messages?: Array<{
    messageId?: string | null;
    type?: string | null;
    createTime?: string | null;
  }>;
  preflightStatus?: string | null;
  error?: string | null;
  findings?: Array<{ code?: string; message?: string }>;
  qualityGate?: FeishuQualityGateRecord | null;
  psdDelivery: 'local_only';
};

export type ModelRouteKey = 'instruction' | 'image' | 'vision';

export type ModelRouteProvider = 'openai-compatible' | 'codex-login';

export type ModelRouteRecord = {
  key: ModelRouteKey;
  provider: ModelRouteProvider;
  primary: string;
  fallback?: string | null;
  source?: string | null;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  modelApiKeyEnvs?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModelUsageRecord = {
  id: string;
  createdAt: string;
  operation: 'image.generate' | 'vision.qa' | 'vision.layer_analysis';
  routeKey: ModelRouteKey;
  status: 'generated' | 'completed' | 'fallback' | 'failed';
  model?: string | null;
  provider?: ModelRouteProvider | null;
  sourceKind?: 'local' | 'env' | 'codex' | 'none' | null;
  durationMs?: number | null;
  input?: {
    promptPreview?: string | null;
    slotKey?: string | null;
    imagePath?: string | null;
    requestedModel?: string | null;
  } | null;
  artifact?: {
    path?: string | null;
    metadataPath?: string | null;
    sizeBytes?: number | null;
    mime?: string | null;
  } | null;
  fallback?: {
    mode?: string | null;
    reason?: string | null;
  } | null;
  audit?: {
    routePrimary?: string | null;
    routeFallback?: string | null;
    selectedRole?: string | null;
    apiKeyEnv?: string | null;
    usage?: Record<string, unknown> | null;
    attempts?: Array<{
      model?: string | null;
      role?: string | null;
      apiKeyEnv?: string | null;
      endpointKind?: string | null;
      status?: string | null;
      durationMs?: number | null;
      error?: string | null;
    }>;
  } | null;
  findings?: Array<{ code?: string; message?: string; severity?: string }>;
  error?: string | null;
  nonBlocking: boolean;
};

export type ImageUploadRecord = {
  id: string;
  createdAt: string;
  originalName: string;
  storedPath: string;
  metadataPath: string;
  mime: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  label?: string | null;
};

export type PsdRebuildJobRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'psd_exported' | 'analyzed' | 'fallback' | 'failed';
  uploadId?: string | null;
  sourceImagePath: string;
  sourceImage: {
    width: number;
    height: number;
    mime: string;
    sizeBytes: number;
    sha256?: string | null;
  };
  layerManifestPath: string;
  photoshopScriptPath?: string | null;
  outputPsdPath?: string | null;
  outputPsdExists?: boolean;
  previewImagePath?: string | null;
  layerCount: number;
  textLayerCount: number;
  model?: string | null;
  selectedRole?: string | null;
  apiKeyEnv?: string | null;
  durationMs?: number | null;
  fallback?: {
    mode?: string | null;
    reason?: string | null;
    nonBlocking?: boolean;
  } | null;
  findings: Array<{ code?: string; message?: string; severity?: string }>;
  psdDelivery: 'local_only';
};

type StateShape = {
  downloads: DownloadRecord[];
  jobs: ConsoleJobRecord[];
  presets: ActionPresetRecord[];
  derivedTargets: DerivedTargetRecord[];
  feishuTargets: FeishuTargetRecord[];
  feishuSendHistory: FeishuSendRecord[];
  modelRoutes: ModelRouteRecord[];
  modelUsageHistory: ModelUsageRecord[];
  imageUploads: ImageUploadRecord[];
  psdRebuildJobs: PsdRebuildJobRecord[];
};

const STATE_PATH = runtimePath('console-state.json');

function emptyState(): StateShape {
  return {
    downloads: [],
    jobs: [],
    presets: [],
    derivedTargets: [],
    feishuTargets: [],
    feishuSendHistory: [],
    modelRoutes: [],
    modelUsageHistory: [],
    imageUploads: [],
    psdRebuildJobs: [],
  };
}

function normalizeState(raw: Partial<StateShape> | null | undefined): StateShape {
  return {
    downloads: Array.isArray(raw?.downloads) ? raw.downloads : [],
    jobs: Array.isArray(raw?.jobs) ? raw.jobs : [],
    presets: Array.isArray(raw?.presets) ? raw.presets : [],
    derivedTargets: Array.isArray(raw?.derivedTargets) ? raw.derivedTargets : [],
    feishuTargets: Array.isArray(raw?.feishuTargets) ? raw.feishuTargets : [],
    feishuSendHistory: Array.isArray(raw?.feishuSendHistory) ? raw.feishuSendHistory : [],
    modelRoutes: Array.isArray(raw?.modelRoutes) ? raw.modelRoutes : [],
    modelUsageHistory: Array.isArray(raw?.modelUsageHistory) ? raw.modelUsageHistory : [],
    imageUploads: Array.isArray(raw?.imageUploads) ? raw.imageUploads : [],
    psdRebuildJobs: Array.isArray(raw?.psdRebuildJobs) ? raw.psdRebuildJobs : [],
  };
}

function readState(): StateShape {
  try {
    if (!fs.existsSync(STATE_PATH)) return emptyState();
    return normalizeState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as Partial<StateShape>);
  } catch {
    return emptyState();
  }
}

function writeState(state: StateShape): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function listDownloads(): DownloadRecord[] {
  return readState().downloads.slice(0, 50);
}

export function addDownload(record: DownloadRecord): void {
  const state = readState();
  state.downloads.unshift(record);
  state.downloads = state.downloads.slice(0, 100);
  writeState(state);
}

export function listJobs(): ConsoleJobRecord[] {
  return readState().jobs.slice(0, 50);
}

export function addJob(record: ConsoleJobRecord): void {
  const state = readState();
  state.jobs.unshift(record);
  state.jobs = state.jobs.slice(0, 100);
  writeState(state);
}

function actionSlotKeys(uiActions: UiAction[]): string[] {
  return [...new Set(uiActions.map((action) => String(action.slotKey || '').trim()).filter(Boolean))];
}

export function listPresets(): ActionPresetRecord[] {
  return readState().presets.slice(0, 100);
}

export function savePreset(input: {
  name: string;
  description?: string;
  templateId?: string | null;
  templateDisplayName?: string | null;
  uiActions: UiAction[];
}): ActionPresetRecord {
  const name = input.name.trim();
  if (!name) throw new Error('Preset 名称不能为空。');
  if (!Array.isArray(input.uiActions) || input.uiActions.length === 0) {
    throw new Error('当前动作队列为空，不能保存 preset。');
  }

  const state = readState();
  const now = new Date().toISOString();
  const existing = state.presets.find((preset) => preset.name === name);
  const record: ActionPresetRecord = {
    id: existing?.id || crypto.randomUUID(),
    name,
    description: input.description?.trim() || undefined,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    templateId: input.templateId ?? null,
    templateDisplayName: input.templateDisplayName ?? null,
    actionCount: input.uiActions.length,
    slotKeys: actionSlotKeys(input.uiActions),
    uiActions: input.uiActions.map((action) => ({ ...action, id: undefined })),
  };

  state.presets = [record, ...state.presets.filter((preset) => preset.id !== record.id && preset.name !== name)].slice(0, 100);
  writeState(state);
  return record;
}

export function deletePreset(id: string): boolean {
  const state = readState();
  const before = state.presets.length;
  state.presets = state.presets.filter((preset) => preset.id !== id);
  state.derivedTargets = state.derivedTargets.filter((record) => record.targetPreset.id !== id);
  writeState(state);
  return state.presets.length !== before;
}

export function listDerivedTargets(): DerivedTargetRecord[] {
  return readState().derivedTargets.slice(0, 50);
}

export function saveDerivedTarget(input: {
  sourcePreset: ActionPresetRecord;
  targetPreset: ActionPresetRecord;
  targetManifest: DerivedTargetRecord['targetManifest'];
  appliedMappings?: DerivedTargetRecord['appliedMappings'];
}): DerivedTargetRecord {
  const state = readState();
  const now = new Date().toISOString();
  const existing = state.derivedTargets.find((record) => record.targetPreset.id === input.targetPreset.id);
  const record: DerivedTargetRecord = {
    id: existing?.id || crypto.randomUUID(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastLoadedAt: existing?.lastLoadedAt || null,
    sourcePreset: {
      id: input.sourcePreset.id,
      name: input.sourcePreset.name,
      actionCount: input.sourcePreset.actionCount || input.sourcePreset.uiActions.length,
      slotKeys: actionSlotKeys(input.sourcePreset.uiActions),
    },
    targetPreset: {
      id: input.targetPreset.id,
      name: input.targetPreset.name,
      actionCount: input.targetPreset.actionCount || input.targetPreset.uiActions.length,
      slotKeys: actionSlotKeys(input.targetPreset.uiActions),
    },
    targetManifest: input.targetManifest,
    appliedMappings: Array.isArray(input.appliedMappings) ? input.appliedMappings : [],
  };

  state.derivedTargets = [
    record,
    ...state.derivedTargets.filter((item) => item.id !== record.id && item.targetPreset.id !== record.targetPreset.id),
  ].slice(0, 50);
  writeState(state);
  return record;
}

export function markDerivedTargetLoaded(id: string): DerivedTargetRecord | null {
  const state = readState();
  const now = new Date().toISOString();
  let updated: DerivedTargetRecord | null = null;
  state.derivedTargets = state.derivedTargets.map((record) => {
    if (record.id !== id) return record;
    updated = { ...record, updatedAt: now, lastLoadedAt: now };
    return updated;
  });
  if (!updated) return null;
  writeState(state);
  return updated;
}

export function deleteDerivedTarget(id: string): boolean {
  const state = readState();
  const before = state.derivedTargets.length;
  state.derivedTargets = state.derivedTargets.filter((record) => record.id !== id);
  writeState(state);
  return state.derivedTargets.length !== before;
}

export function listFeishuTargets(): FeishuTargetRecord[] {
  return readState().feishuTargets.slice(0, 30);
}

export function saveFeishuTarget(input: {
  type: FeishuTargetRecord['type'];
  value: string;
  label?: string;
}): FeishuTargetRecord {
  const value = input.value.trim();
  if (!value) throw new Error('飞书目标 ID 不能为空。');
  const state = readState();
  const now = new Date().toISOString();
  const existing = state.feishuTargets.find((target) => target.type === input.type && target.value === value);
  const record: FeishuTargetRecord = {
    id: existing?.id || crypto.randomUUID(),
    type: input.type,
    value,
    label: input.label?.trim() || existing?.label || undefined,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || null,
  };
  state.feishuTargets = [
    record,
    ...state.feishuTargets.filter((target) => target.id !== record.id && !(target.type === record.type && target.value === record.value)),
  ].slice(0, 30);
  writeState(state);
  return record;
}

export function markFeishuTargetUsed(input: {
  type: FeishuTargetRecord['type'];
  value: string;
}): FeishuTargetRecord | null {
  const state = readState();
  const now = new Date().toISOString();
  let updated: FeishuTargetRecord | null = null;
  state.feishuTargets = state.feishuTargets.map((target) => {
    if (target.type !== input.type || target.value !== input.value) return target;
    updated = { ...target, updatedAt: now, lastUsedAt: now };
    return updated;
  });
  if (!updated) return null;
  state.feishuTargets = [updated, ...state.feishuTargets.filter((target) => target.id !== updated?.id)].slice(0, 30);
  writeState(state);
  return updated;
}

export function deleteFeishuTarget(id: string): boolean {
  const state = readState();
  const before = state.feishuTargets.length;
  state.feishuTargets = state.feishuTargets.filter((target) => target.id !== id);
  writeState(state);
  return state.feishuTargets.length !== before;
}

export function listFeishuSendHistory(): FeishuSendRecord[] {
  return readState().feishuSendHistory.slice(0, 50);
}

export function addFeishuSendRecord(input: Omit<FeishuSendRecord, 'id' | 'createdAt'> & {
  createdAt?: string;
}): FeishuSendRecord {
  const state = readState();
  const record: FeishuSendRecord = {
    id: crypto.randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
    status: input.status,
    target: input.target || null,
    finalImage: input.finalImage || { path: null },
    messageCount: input.messageCount ?? null,
    messageIds: Array.isArray(input.messageIds) ? input.messageIds : [],
    messages: Array.isArray(input.messages) ? input.messages : [],
    preflightStatus: input.preflightStatus ?? null,
    error: input.error ?? null,
    findings: Array.isArray(input.findings) ? input.findings : [],
    qualityGate: input.qualityGate || null,
    psdDelivery: 'local_only',
  };
  state.feishuSendHistory = [record, ...state.feishuSendHistory].slice(0, 100);
  writeState(state);
  return record;
}

function isModelRouteKey(value: string): value is ModelRouteKey {
  return value === 'instruction' || value === 'image' || value === 'vision';
}

function isModelRouteProvider(value: string): value is ModelRouteProvider {
  return value === 'openai-compatible' || value === 'codex-login';
}

function normalizeModelRoute(record: ModelRouteRecord): ModelRouteRecord | null {
  const key = String(record.key || '').trim();
  const provider = String(record.provider || 'openai-compatible').trim();
  const primary = String(record.primary || '').trim();
  if (!isModelRouteKey(key) || !isModelRouteProvider(provider) || !primary) return null;
  if (provider === 'codex-login' && key !== 'instruction') return null;
  const now = new Date().toISOString();
  const modelApiKeyEnvs = Object.entries(record.modelApiKeyEnvs || {}).reduce<Record<string, string>>((acc, [model, envName]) => {
    const normalizedModel = String(model || '').trim();
    const normalizedEnvName = String(envName || '').trim();
    if (normalizedModel && normalizedEnvName) acc[normalizedModel] = normalizedEnvName;
    return acc;
  }, {});
  return {
    key,
    provider,
    primary,
    fallback: record.fallback ? String(record.fallback).trim() : null,
    source: record.source ? String(record.source).trim() : null,
    baseUrl: record.baseUrl ? String(record.baseUrl).trim() : null,
    apiKeyEnv: record.apiKeyEnv ? String(record.apiKeyEnv).trim() : null,
    modelApiKeyEnvs,
    enabled: record.enabled !== false,
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
  };
}

export function listModelRoutes(): ModelRouteRecord[] {
  return readState().modelRoutes
    .map((record) => normalizeModelRoute(record))
    .filter((record): record is ModelRouteRecord => Boolean(record));
}

export function saveModelRoute(input: {
  key: ModelRouteKey;
  provider?: ModelRouteProvider;
  primary: string;
  fallback?: string | null;
  source?: string | null;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  modelApiKeyEnvs?: Record<string, string> | null;
  enabled?: boolean;
}): ModelRouteRecord {
  const primary = input.primary.trim();
  if (!primary) throw new Error('模型主路由不能为空。');
  const state = readState();
  const now = new Date().toISOString();
  const existing = state.modelRoutes.find((route) => route.key === input.key);
  const record: ModelRouteRecord = {
    key: input.key,
    provider: input.provider || 'openai-compatible',
    primary,
    fallback: input.fallback?.trim() || null,
    source: input.source?.trim() || null,
    baseUrl: input.baseUrl?.trim() || null,
    apiKeyEnv: input.apiKeyEnv?.trim() || null,
    modelApiKeyEnvs: input.modelApiKeyEnvs || {},
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const normalized = normalizeModelRoute(record);
  if (!normalized) throw new Error('模型路由配置无效。');
  state.modelRoutes = [
    normalized,
    ...state.modelRoutes.filter((route) => route.key !== input.key),
  ].slice(0, 10);
  writeState(state);
  return normalized;
}

export function listModelUsageHistory(): ModelUsageRecord[] {
  return readState().modelUsageHistory.slice(0, 100);
}

export function addModelUsageRecord(input: Omit<ModelUsageRecord, 'id' | 'createdAt' | 'nonBlocking'> & {
  createdAt?: string;
  nonBlocking?: boolean;
}): ModelUsageRecord {
  const state = readState();
  const record: ModelUsageRecord = {
    id: crypto.randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
    operation: input.operation,
    routeKey: input.routeKey,
    status: input.status,
    model: input.model ?? null,
    provider: input.provider ?? null,
    sourceKind: input.sourceKind ?? null,
    durationMs: input.durationMs ?? null,
    input: input.input || null,
    artifact: input.artifact || null,
    fallback: input.fallback || null,
    audit: input.audit || null,
    findings: Array.isArray(input.findings) ? input.findings : [],
    error: input.error ?? null,
    nonBlocking: input.nonBlocking !== false,
  };
  state.modelUsageHistory = [record, ...state.modelUsageHistory].slice(0, 100);
  writeState(state);
  return record;
}

export function listImageUploads(): ImageUploadRecord[] {
  return readState().imageUploads.slice(0, 50);
}

export function getImageUpload(id: string): ImageUploadRecord | null {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return null;
  return readState().imageUploads.find((record) => record.id === normalizedId) || null;
}

export function addImageUpload(input: Omit<ImageUploadRecord, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: string;
}): ImageUploadRecord {
  const state = readState();
  const record: ImageUploadRecord = {
    id: input.id || crypto.randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
    originalName: input.originalName,
    storedPath: input.storedPath,
    metadataPath: input.metadataPath,
    mime: input.mime,
    extension: input.extension,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    width: input.width,
    height: input.height,
    label: input.label || null,
  };
  state.imageUploads = [record, ...state.imageUploads.filter((item) => item.id !== record.id)].slice(0, 100);
  writeState(state);
  return record;
}

export function listPsdRebuildJobs(): PsdRebuildJobRecord[] {
  return readState().psdRebuildJobs.slice(0, 50);
}

export function addPsdRebuildJob(input: Omit<PsdRebuildJobRecord, 'id' | 'createdAt' | 'updatedAt' | 'psdDelivery'> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  psdDelivery?: 'local_only';
}): PsdRebuildJobRecord {
  const state = readState();
  const now = new Date().toISOString();
  const record: PsdRebuildJobRecord = {
    id: input.id || crypto.randomUUID(),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    status: input.status,
    uploadId: input.uploadId || null,
    sourceImagePath: input.sourceImagePath,
    sourceImage: input.sourceImage,
    layerManifestPath: input.layerManifestPath,
    photoshopScriptPath: input.photoshopScriptPath || null,
    outputPsdPath: input.outputPsdPath || null,
    outputPsdExists: Boolean(input.outputPsdExists),
    previewImagePath: input.previewImagePath || null,
    layerCount: input.layerCount,
    textLayerCount: input.textLayerCount,
    model: input.model || null,
    selectedRole: input.selectedRole || null,
    apiKeyEnv: input.apiKeyEnv || null,
    durationMs: input.durationMs ?? null,
    fallback: input.fallback || null,
    findings: Array.isArray(input.findings) ? input.findings : [],
    psdDelivery: 'local_only',
  };
  state.psdRebuildJobs = [record, ...state.psdRebuildJobs.filter((item) => item.id !== record.id)].slice(0, 100);
  writeState(state);
  return record;
}
