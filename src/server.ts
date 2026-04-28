import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT, MANIFEST_DISCOVERY_ROOTS, PUBLIC_DIR, ensureRuntimeDirs } from './config.js';
import { Design006BrowserManager } from './design006-browser-manager.js';
import { getFeishuStatus, preflightFinalToFeishu, sendFinalToFeishu } from './feishu-output.js';
import { readJsonBody, sendFile, sendJson, sendText } from './http.js';
import { generateImageArtifact, getResolvedModelRoute, getResolvedModelRoutes, probeModelRoutes, runVisionQualityCheck } from './model-routing.js';
import {
  confirmFinalExport,
  getPhotoshopJobArtifactCenter,
  getLatestFinalPhotoshopJob,
  createPhotoshopJob,
  getPhotoshopJob,
  getPhotoshopStatus,
  preflightPhotoshopJob,
} from './photoshop-service.js';
import {
  addFeishuSendRecord,
  addModelUsageRecord,
  deleteDerivedTarget,
  deleteFeishuTarget,
  deletePreset,
  listFeishuSendHistory,
  listModelUsageHistory,
  listModelRoutes,
  listFeishuTargets,
  listDerivedTargets,
  listDownloads,
  listJobs,
  listPresets,
  markFeishuTargetUsed,
  markDerivedTargetLoaded,
  saveDerivedTarget,
  saveFeishuTarget,
  saveModelRoute,
  savePreset,
  type ActionPresetRecord,
  type ModelRouteKey,
  type ModelRouteProvider,
} from './state.js';
import {
  inspectTemplateManifest,
  preflightUiActions,
  type UiAction,
  type UiActionPreflight,
  type UiActionRejected,
  type UiSlotSummary,
} from './ui-action-adapter.js';

const design006 = new Design006BrowserManager();
const LOCAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MANIFEST_DISCOVERY_LIMIT = 80;
const MANIFEST_DISCOVERY_MAX_DEPTH = 6;

type ManifestInspectionPayload = ReturnType<typeof inspectTemplateManifest>;
type SlotCapability = UiSlotSummary['capabilities'][number];
type ManifestSummary = {
  templateId: string | null;
  displayName: string | null;
  manifestPath: string;
  psdPath: string | null;
  counts: ManifestInspectionPayload['counts'];
  slotCount: number;
  document: ManifestInspectionPayload['document'];
};
type ConfirmedSlotMapping = {
  sourceSlotKey: string;
  capability: SlotCapability;
  targetSlotKey: string;
};
type DerivedActionChange = {
  index: number;
  type: string;
  capability: SlotCapability | null;
  sourceSlotKey: string;
  targetSlotKey: string;
  mode: 'kept' | 'mapped' | 'unmapped' | 'ignored';
};

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function badRequest(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

function errorStatusCode(error: unknown): number {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : 500;
}

function errorDetails(error: unknown): unknown {
  return (error as { details?: unknown } | null)?.details;
}

function isSupportedLocalImage(filePath: string): boolean {
  return LOCAL_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function isManifestFile(filePath: string): boolean {
  return /\.auto\.json$/i.test(filePath) || /\.psd\.auto\.json$/i.test(filePath);
}

function shouldSkipDiscoveryDir(name: string): boolean {
  return new Set(['node_modules', '.git', '.runtime', 'Library', 'Applications']).has(name);
}

function discoverManifestFilesInRoot(root: string, limit: number): string[] {
  const found: string[] = [];
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) return found;

  function walk(dir: string, depth: number): void {
    if (found.length >= limit || depth > MANIFEST_DISCOVERY_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDiscoveryDir(entry.name)) walk(next, depth + 1);
        continue;
      }
      if (entry.isFile() && isManifestFile(next)) found.push(path.resolve(next));
    }
  }

  walk(resolvedRoot, 0);
  return found;
}

function pairedPsdPath(manifestPath: string): string | null {
  const dir = path.dirname(manifestPath);
  const name = path.basename(manifestPath);
  const candidates = [
    name.replace(/\.psd\.auto\.json$/i, '.psd'),
    name.replace(/\.psb\.auto\.json$/i, '.psb'),
    name.replace(/\.auto\.json$/i, '.psd'),
  ].filter((candidate) => candidate !== name).map((candidate) => path.join(dir, candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }

  let siblingPsds: string[] = [];
  try {
    siblingPsds = fs.readdirSync(dir)
      .filter((entry) => /\.(psd|psb)$/i.test(entry))
      .map((entry) => path.join(dir, entry));
  } catch {
    return null;
  }
  return siblingPsds.length === 1 ? path.resolve(siblingPsds[0] || '') : null;
}

function summarizeManifestInspection(inspection: ManifestInspectionPayload, psdPath: string | null): ManifestSummary {
  return {
    templateId: inspection.templateId,
    displayName: inspection.displayName,
    manifestPath: inspection.manifestPath,
    psdPath,
    counts: inspection.counts,
    slotCount: inspection.slots.length,
    document: inspection.document,
  };
}

function manifestDiscoveryItem(manifestPath: string): Record<string, unknown> | null {
  try {
    const resolved = path.resolve(manifestPath);
    const psdPath = pairedPsdPath(resolved);
    const inspection = inspectTemplateManifest(resolved);
    return {
      ...summarizeManifestInspection(inspection, psdPath),
      label: `${inspection.templateId || path.basename(path.dirname(resolved))} · ${inspection.displayName || '未命名模板'}`,
    };
  } catch (error) {
    return {
      manifestPath: path.resolve(manifestPath),
      error: safeError(error),
    };
  }
}

function discoverManifestItems(root?: string): Record<string, unknown>[] {
  const roots = uniqueStrings(root ? [root] : MANIFEST_DISCOVERY_ROOTS);
  const files = uniqueStrings(roots.flatMap((entry) => discoverManifestFilesInRoot(entry, MANIFEST_DISCOVERY_LIMIT)));
  return files
    .slice(0, MANIFEST_DISCOVERY_LIMIT)
    .map((filePath) => manifestDiscoveryItem(filePath))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function countByCode(items: UiActionRejected[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.code, (counts.get(item.code) || 0) + 1);
  return Array.from(counts.entries()).map(([code, count]) => ({ code, count }));
}

function slotKeysForCodes(items: UiActionRejected[], codes: Set<string>): string[] {
  return [...new Set(items
    .filter((item) => codes.has(item.code))
    .map((item) => String(item.action?.slotKey || '').trim())
    .filter(Boolean))];
}

function actionCapability(action: UiAction): SlotCapability | null {
  if (action.type === 'text.replace' || action.type === 'text.clear') return 'text';
  if (action.type === 'image.replace.local' || action.type === 'image.replace.ai') return 'image';
  if (action.type === 'transform.update') return 'transform';
  if (action.type === 'layer.hide') return 'toggle';
  return null;
}

function isSlotCapability(value: string): value is SlotCapability {
  return value === 'text' || value === 'image' || value === 'transform' || value === 'toggle';
}

function isFeishuTargetType(value: string): value is 'chat' | 'user' {
  return value === 'chat' || value === 'user';
}

function isModelRouteKey(value: string): value is ModelRouteKey {
  return value === 'instruction' || value === 'image' || value === 'vision';
}

function isModelRouteProvider(value: string): value is ModelRouteProvider {
  return value === 'openai-compatible';
}

function feishuTargetLooksValid(type: 'chat' | 'user', value: string): boolean {
  if (type === 'chat') return /^oc_[A-Za-z0-9_-]+$/.test(value);
  return /^ou_[A-Za-z0-9_-]+$/.test(value);
}

function feishuSendRecordFromPayload(payload: Record<string, unknown>): Parameters<typeof addFeishuSendRecord>[0] {
  const receipt = (payload.receipt || {}) as Record<string, any>;
  const finalImage = (receipt.finalImage || {}) as Record<string, any>;
  const target = (receipt.target || null) as Record<string, any> | null;
  const preflight = (payload.preflight || {}) as Record<string, any>;
  const messages = Array.isArray(receipt.messages) ? receipt.messages : [];
  const messageIds = Array.isArray(receipt.messageIds)
    ? receipt.messageIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
    : messages.map((message: Record<string, any>) => String(message?.messageId || '').trim()).filter(Boolean);
  return {
    status: 'sent',
    createdAt: String(receipt.sentAt || new Date().toISOString()),
    target: target
      ? {
          type: isFeishuTargetType(String(target.type || '')) ? target.type : null,
          value: target.value ? String(target.value) : null,
          source: target.source ? String(target.source) : null,
        }
      : null,
    finalImage: {
      path: finalImage.path ? String(finalImage.path) : null,
      fileName: finalImage.fileName ? String(finalImage.fileName) : null,
      sizeBytes: typeof finalImage.sizeBytes === 'number' ? finalImage.sizeBytes : null,
      delivery: finalImage.delivery ? String(finalImage.delivery) : null,
    },
    messageCount: typeof receipt.messageCount === 'number' ? receipt.messageCount : null,
    messageIds,
    messages: messages.map((message: Record<string, any>) => ({
      messageId: message?.messageId ? String(message.messageId) : null,
      type: message?.type ? String(message.type) : null,
      createTime: message?.createTime ? String(message.createTime) : null,
    })),
    preflightStatus: preflight.status ? String(preflight.status) : null,
    error: null,
    findings: [],
    psdDelivery: 'local_only',
  };
}

function feishuSendRecordFromError(
  error: unknown,
  body: Record<string, unknown> = {},
): Parameters<typeof addFeishuSendRecord>[0] {
  const details = errorDetails(error) as Record<string, any> | undefined;
  const target = (details?.target || null) as Record<string, any> | null;
  const bodyChatId = String(body.chatId || '').trim();
  const bodyUserId = String(body.userId || '').trim();
  const fallbackTarget = bodyChatId
    ? { type: 'chat' as const, value: bodyChatId, source: 'body' }
    : bodyUserId
      ? { type: 'user' as const, value: bodyUserId, source: 'body' }
      : null;
  const artifact = Array.isArray(details?.artifacts)
    ? details.artifacts.find((item: Record<string, any>) => item?.key === 'imagePath')
    : null;
  const imagePath = artifact?.path ? String(artifact.path) : String(body.imagePath || '').trim();
  return {
    status: 'failed',
    target: target
      ? {
          type: isFeishuTargetType(String(target.type || '')) ? target.type : null,
          value: target.value ? String(target.value) : null,
          source: target.source ? String(target.source) : null,
        }
      : fallbackTarget,
    finalImage: {
      path: imagePath || null,
      fileName: imagePath ? path.basename(imagePath) : null,
      sizeBytes: typeof artifact?.sizeBytes === 'number' ? artifact.sizeBytes : null,
      delivery: artifact?.delivery ? String(artifact.delivery) : null,
    },
    messageCount: 0,
    messageIds: [],
    messages: [],
    preflightStatus: details?.status ? String(details.status) : null,
    error: safeError(error),
    findings: Array.isArray(details?.findings) ? details.findings.map((item: Record<string, any>) => ({
      code: item?.code ? String(item.code) : undefined,
      message: item?.message ? String(item.message) : undefined,
    })) : [],
    psdDelivery: 'local_only',
  };
}

function normalizeMaybePath(value: unknown): string {
  const raw = String(value || '').trim();
  return raw ? path.resolve(raw) : '';
}

function findDuplicateFeishuSend(preflight: Record<string, any>): Record<string, unknown> | null {
  if (preflight.status !== 'ready') return null;
  const target = preflight.target as Record<string, any> | null;
  const artifact = Array.isArray(preflight.artifacts)
    ? preflight.artifacts.find((item: Record<string, any>) => item?.key === 'imagePath')
    : null;
  const imagePath = normalizeMaybePath(artifact?.path);
  if (!target?.type || !target?.value || !imagePath) return null;
  const duplicate = listFeishuSendHistory().find((record) => (
    record.status === 'sent'
    && record.target?.type === target.type
    && record.target?.value === target.value
    && normalizeMaybePath(record.finalImage?.path) === imagePath
  ));
  if (!duplicate) return null;
  return {
    id: duplicate.id,
    sentAt: duplicate.createdAt,
    target: duplicate.target,
    finalImage: duplicate.finalImage,
    messageCount: duplicate.messageCount ?? null,
    messageIds: duplicate.messageIds || [],
    psdDelivery: duplicate.psdDelivery,
  };
}

function addDuplicateSendInfo(preflight: Record<string, unknown>): Record<string, unknown> {
  const duplicateSend = findDuplicateFeishuSend(preflight as Record<string, any>);
  return {
    ...preflight,
    duplicateSend,
  };
}

function duplicateSendError(preflight: Record<string, unknown>): Error {
  const error = new Error('同一飞书目标已发送过当前 final.png；如需再次投递，请明确选择“再次发送”。') as Error & {
    statusCode: number;
    details: unknown;
  };
  error.statusCode = 409;
  error.details = preflight;
  return error;
}

function fileExists(filePath: unknown): boolean {
  const resolved = String(filePath || '').trim();
  return Boolean(resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile());
}

function newestFeishuTargetRecord(): ReturnType<typeof listFeishuTargets>[number] | null {
  return [...listFeishuTargets()].sort((a, b) => {
    const aTime = Date.parse(a.lastUsedAt || a.updatedAt || a.createdAt || '') || 0;
    const bTime = Date.parse(b.lastUsedAt || b.updatedAt || b.createdAt || '') || 0;
    return bTime - aTime;
  })[0] || null;
}

function relatedFeishuHistoryForImage(imagePath: unknown): ReturnType<typeof listFeishuSendHistory> {
  const normalized = normalizeMaybePath(imagePath);
  if (!normalized) return [];
  return listFeishuSendHistory().filter((record) => normalizeMaybePath(record.finalImage?.path) === normalized);
}

function candidatePresetsForJob(center: Record<string, any>): ActionPresetRecord[] {
  const template = center.template || {};
  const templateId = String(template.templateId || '').trim();
  const displayName = String(template.templateDisplayName || '').trim();
  return listPresets().filter((preset) => (
    (templateId && preset.templateId === templateId)
    || (displayName && preset.templateDisplayName === displayName)
  )).slice(0, 8);
}

async function artifactCenterPayload(sessionId: string): Promise<Record<string, unknown>> {
  const center = await getPhotoshopJobArtifactCenter(sessionId) as Record<string, any>;
  const finalImagePath = center.artifacts?.finalImagePath || null;
  const relatedFeishuSendHistory = relatedFeishuHistoryForImage(finalImagePath);
  return {
    ok: true,
    artifactCenter: {
      ...center,
      candidatePresets: candidatePresetsForJob(center).map((preset) => ({
        id: preset.id,
        name: preset.name,
        templateId: preset.templateId || null,
        templateDisplayName: preset.templateDisplayName || null,
        actionCount: preset.actionCount,
        slotKeys: preset.slotKeys,
      })),
      relatedFeishuSendHistory,
      audit: {
        generatedAt: new Date().toISOString(),
        finalImagePath,
        sendRecordCount: relatedFeishuSendHistory.length,
        sentCount: relatedFeishuSendHistory.filter((record) => record.status === 'sent').length,
        failedCount: relatedFeishuSendHistory.filter((record) => record.status === 'failed').length,
        psdDelivery: 'local_only',
      },
    },
  };
}

function buildSafeRerunPreflight(center: Record<string, any>): Record<string, unknown> {
  const template = center.template || {};
  const artifacts = center.artifacts || {};
  const capabilities = center.rerunCapabilities || {};
  const checks = [
    {
      code: 'manifest_available',
      status: fileExists(template.manifestPath) ? 'ready' : 'blocked',
      message: template.manifestPath || '缺少 manifest 路径。',
    },
    {
      code: 'original_psd_available',
      status: fileExists(template.originalPsdPath) ? 'ready' : 'blocked',
      message: template.originalPsdPath || '缺少原始 PSD 路径。',
    },
    {
      code: 'final_png_available',
      status: fileExists(artifacts.finalImagePath) ? 'ready' : 'warning',
      message: artifacts.finalImagePath || '当前 job 还没有 final.png。',
    },
    {
      code: 'export_final_available',
      status: capabilities.exportFinal ? 'ready' : 'warning',
      message: capabilities.exportFinal ? '当前 session 可重新排队高清导出。' : (capabilities.exportFinalReason || '当前 session 不支持直接复跑高清导出。'),
    },
    {
      code: 'psd_delivery',
      status: 'ready',
      message: 'editable.psd 仅本地保存，不进入飞书发送 payload。',
    },
  ];
  return {
    status: checks.some((check) => check.status === 'blocked') ? 'blocked' : 'ready',
    checks,
  };
}

async function safeRerunPayload(sessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(body.action || '').trim();
  if (!['preflight', 'export-final', 'feishu-preflight'].includes(action)) {
    throw badRequest('安全复跑 action 必须是 preflight、export-final 或 feishu-preflight。');
  }
  const center = await getPhotoshopJobArtifactCenter(sessionId) as Record<string, any>;
  if (action === 'preflight') {
    return { ok: true, action, preflight: buildSafeRerunPreflight(center), artifactCenter: center };
  }
  if (action === 'feishu-preflight') {
    const imagePath = String(center.artifacts?.finalImagePath || '').trim();
    if (!imagePath) throw badRequest('当前 job 没有 final.png，无法进行飞书发送前预检。');
    const preflight = addDuplicateSendInfo(await preflightFinalToFeishu({
      chatId: String(body.chatId || '').trim(),
      userId: String(body.userId || '').trim(),
      imagePath,
    }));
    return { ok: true, action, preflight, artifactCenter: center };
  }
  if (body.confirm !== 'export-final') {
    throw badRequest('重新生成 final.png 需要显式提交 confirm=export-final。');
  }
  return { ok: true, action, ...(await confirmFinalExport(sessionId)) };
}

function feishuAuditExportPayload(): Record<string, unknown> {
  const records = listFeishuSendHistory();
  return {
    ok: true,
    audit: {
      generatedAt: new Date().toISOString(),
      scope: 'feishu-send-history',
      count: records.length,
      sentCount: records.filter((record) => record.status === 'sent').length,
      failedCount: records.filter((record) => record.status === 'failed').length,
      boundary: {
        finalPngDelivery: 'text_summary_plus_final_png',
        psdDelivery: 'local_only',
      },
      records,
    },
  };
}

async function feishuOutputRegressionPayload(): Promise<Record<string, unknown>> {
  const latestFinalJob = await getLatestFinalPhotoshopJob() as Record<string, any>;
  const finalImagePath = latestFinalJob?.artifacts?.finalImagePath || null;
  const editablePsdPath = latestFinalJob?.artifacts?.editablePsdPath || null;
  const targets = listFeishuTargets();
  const newestTarget = newestFeishuTargetRecord();
  const history = listFeishuSendHistory();
  const preflight = finalImagePath && newestTarget
    ? addDuplicateSendInfo(await preflightFinalToFeishu({
      chatId: newestTarget.type === 'chat' ? newestTarget.value : '',
      userId: newestTarget.type === 'user' ? newestTarget.value : '',
      imagePath: finalImagePath,
    }))
    : null;
  const duplicateSend = preflight ? (preflight as Record<string, unknown>).duplicateSend || null : null;
  const checks = [
    {
      code: 'latest_final_job',
      status: latestFinalJob?.found ? 'ready' : 'blocked',
      message: latestFinalJob?.found ? String(latestFinalJob.session?.sessionId || '-') : String(latestFinalJob?.reason || '没有最近 final.png。'),
    },
    {
      code: 'final_png_exists',
      status: fileExists(finalImagePath) ? 'ready' : 'blocked',
      message: finalImagePath || '缺少 final.png 路径。',
    },
    {
      code: 'final_png_previewable',
      status: finalImagePath && isSupportedLocalImage(finalImagePath) && fileExists(finalImagePath) ? 'ready' : 'blocked',
      message: finalImagePath || '缺少可预览图片。',
    },
    {
      code: 'feishu_target_available',
      status: targets.length > 0 ? 'ready' : 'warning',
      message: newestTarget ? `${newestTarget.type}:${newestTarget.value}` : '没有本地保存目标；仍可手动填写。',
    },
    {
      code: 'duplicate_guard',
      status: duplicateSend ? 'ready' : 'ready',
      message: duplicateSend ? '已命中重复发送记录，默认会阻断再次投递。' : '未命中重复发送记录。',
    },
    {
      code: 'send_history_present',
      status: history.length > 0 ? 'ready' : 'warning',
      message: `${history.length} 条发送审计记录。`,
    },
    {
      code: 'psd_local_only',
      status: 'ready',
      message: editablePsdPath ? `PSD 仅本地保存：${editablePsdPath}` : '没有 editable PSD 路径，但发送 payload 仍只使用 final.png。',
    },
  ];
  return {
    ok: true,
    regression: {
      generatedAt: new Date().toISOString(),
      status: checks.some((check) => check.status === 'blocked') ? 'blocked' : 'ready',
      checks,
      latestFinalJob,
      newestTarget,
      sendHistoryCount: history.length,
      latestSendRecord: history[0] || null,
      preflight,
      safety: {
        noMockData: true,
        psdDelivery: 'local_only',
        sendApiDefault: 'duplicate_guarded',
      },
    },
  };
}

function previewText(value: unknown, limit = 160): string | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function safeAddModelUsageRecord(input: Parameters<typeof addModelUsageRecord>[0]): void {
  try {
    addModelUsageRecord(input);
  } catch (error) {
    console.warn('[model-routing:audit]', safeError(error));
  }
}

function recordModelImageSuccess(body: Record<string, unknown>, result: Record<string, unknown>, durationMs: number): void {
  const route = getResolvedModelRoute('image');
  const artifact = (result.artifact || {}) as Record<string, any>;
  safeAddModelUsageRecord({
    operation: 'image.generate',
    routeKey: 'image',
    status: 'generated',
    model: String(artifact.model || body.modelId || route.primary || '').trim() || null,
    provider: route.provider,
    sourceKind: route.sourceKind,
    durationMs,
    input: {
      promptPreview: previewText(body.prompt),
      slotKey: previewText(body.slotKey, 80),
      requestedModel: previewText(body.modelId, 120),
    },
    artifact: {
      path: artifact.outputPath || null,
      metadataPath: artifact.metadataPath || null,
      sizeBytes: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : null,
      mime: artifact.mime || null,
    },
    nonBlocking: true,
  });
}

function recordModelImageFallback(body: Record<string, unknown>, error: unknown, durationMs: number): void {
  const route = getResolvedModelRoute('image');
  safeAddModelUsageRecord({
    operation: 'image.generate',
    routeKey: 'image',
    status: 'fallback',
    model: previewText(body.modelId, 120),
    provider: route.provider,
    sourceKind: route.sourceKind,
    durationMs,
    input: {
      promptPreview: previewText(body.prompt),
      slotKey: previewText(body.slotKey, 80),
      requestedModel: previewText(body.modelId, 120),
    },
    fallback: {
      mode: 'manual_file',
      reason: safeError(error),
    },
    findings: route.findings,
    error: safeError(error),
    nonBlocking: true,
  });
}

function recordModelVisionSuccess(body: Record<string, unknown>, result: Record<string, unknown>, durationMs: number): void {
  const route = getResolvedModelRoute('vision');
  const qa = (result.qa || {}) as Record<string, any>;
  safeAddModelUsageRecord({
    operation: 'vision.qa',
    routeKey: 'vision',
    status: 'completed',
    model: String(qa.model || body.modelId || route.primary || '').trim() || null,
    provider: route.provider,
    sourceKind: route.sourceKind,
    durationMs,
    input: {
      imagePath: previewText(body.imagePath, 300),
      requestedModel: previewText(body.modelId, 120),
    },
    artifact: {
      path: qa.imagePath || null,
    },
    nonBlocking: qa.nonBlocking !== false,
  });
}

function recordModelVisionFallback(body: Record<string, unknown>, error: unknown, durationMs: number): void {
  const route = getResolvedModelRoute('vision');
  safeAddModelUsageRecord({
    operation: 'vision.qa',
    routeKey: 'vision',
    status: 'fallback',
    model: previewText(body.modelId, 120),
    provider: route.provider,
    sourceKind: route.sourceKind,
    durationMs,
    input: {
      imagePath: previewText(body.imagePath, 300),
      requestedModel: previewText(body.modelId, 120),
    },
    fallback: {
      mode: 'manual_review',
      reason: safeError(error),
    },
    findings: route.findings,
    error: safeError(error),
    nonBlocking: true,
  });
}

async function modelRoutingRegressionPayload(): Promise<Record<string, unknown>> {
  const routes = getResolvedModelRoutes();
  const probes = await probeModelRoutes();
  const history = listModelUsageHistory();
  const blockedConfiguredProbeCount = probes.filter((probe) => (
    probe.status === 'blocked' && routes.find((route) => route.key === probe.key)?.configured
  )).length;
  const checks = [
    {
      code: 'route_inventory',
      status: routes.length === 3 ? 'ready' : 'blocked',
      message: `读取到 ${routes.length} 条模型路由。`,
    },
    {
      code: 'provider_live_probe',
      status: blockedConfiguredProbeCount > 0 ? 'blocked' : probes.some((probe) => probe.status === 'ready') ? 'ready' : 'warning',
      message: blockedConfiguredProbeCount > 0
        ? `${blockedConfiguredProbeCount} 条已配置 provider 连通性失败。`
        : probes.some((probe) => probe.status === 'ready')
          ? '至少一条 provider live probe 已连通。'
          : '当前没有可 live probe 的真实 provider。未配置时保持人工回退。',
    },
    {
      code: 'image_fallback_policy',
      status: 'ready',
      message: 'image 生成失败或未配置时返回 manual_file，不生成假文件。',
    },
    {
      code: 'vision_non_blocking_policy',
      status: 'ready',
      message: 'vision 质检失败或未配置时返回 manual_review，不阻断 Photoshop / 飞书主链路。',
    },
    {
      code: 'usage_audit',
      status: history.length > 0 ? 'ready' : 'warning',
      message: history.length > 0 ? `${history.length} 条模型调用审计记录。` : '尚无模型调用审计记录，首次 image/vision 调用后会写入。',
    },
  ];
  return {
    ok: true,
    regression: {
      generatedAt: new Date().toISOString(),
      status: checks.some((check) => check.status === 'blocked') ? 'blocked' : 'ready',
      checks,
      routes,
      probes,
      usageHistoryCount: history.length,
      latestUsageRecord: history[0] || null,
      safety: {
        noMockData: true,
        imageFallback: 'manual_file',
        visionFallback: 'manual_review',
        mainChainBlocking: false,
      },
    },
  };
}

function mappingKey(slotKey: string, capability: SlotCapability): string {
  return `${capability}:${slotKey}`;
}

function normalizeConfirmedMappings(value: unknown): ConfirmedSlotMapping[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const mappings: ConfirmedSlotMapping[] = [];
  for (const item of value) {
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const sourceSlotKey = String(raw.sourceSlotKey || '').trim();
    const capability = String(raw.capability || '').trim();
    const targetSlotKey = String(raw.targetSlotKey || '').trim();
    if (!sourceSlotKey || !targetSlotKey || !isSlotCapability(capability)) continue;
    const key = mappingKey(sourceSlotKey, capability);
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push({ sourceSlotKey, capability, targetSlotKey });
  }
  return mappings;
}

function slotsWithCapability(inspection: ManifestInspectionPayload, capability: SlotCapability): UiSlotSummary[] {
  return inspection.slots.filter((slot) => slot.capabilities.includes(capability));
}

function slotWithCapability(
  inspection: ManifestInspectionPayload | null,
  slotKey: string,
  capability: SlotCapability,
): UiSlotSummary | null {
  if (!inspection) return null;
  return inspection.slots.find((slot) => slot.key === slotKey && slot.capabilities.includes(capability)) || null;
}

function normalizeCompareText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\-_·・/|]+/g, '');
}

function layerPathLeaf(layerPath: string): string {
  return String(layerPath || '').split('/').pop() || '';
}

function candidateScore(sourceSlot: UiSlotSummary | null, targetSlot: UiSlotSummary, sourceSlotKey: string): {
  score: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
} {
  if (sourceSlot && sourceSlot.layerPath && sourceSlot.layerPath === targetSlot.layerPath) {
    return { score: 100, reason: '同能力 layerPath 精确匹配', confidence: 'high' };
  }
  if (normalizeCompareText(sourceSlotKey) && normalizeCompareText(sourceSlotKey) === normalizeCompareText(targetSlot.key)) {
    return { score: 82, reason: 'slot key 文案一致', confidence: 'medium' };
  }
  const sourceLeaf = normalizeCompareText(layerPathLeaf(sourceSlot?.layerPath || ''));
  const targetLeaf = normalizeCompareText(layerPathLeaf(targetSlot.layerPath || ''));
  if (sourceLeaf && sourceLeaf === targetLeaf) {
    return { score: 72, reason: '图层末级名称一致', confidence: 'medium' };
  }
  return { score: 20, reason: '同能力候选，需要人工确认', confidence: 'low' };
}

function buildMappingSuggestions(
  actions: UiAction[],
  sourceInspection: ManifestInspectionPayload | null,
  targetInspection: ManifestInspectionPayload,
  rejected: UiActionRejected[],
): Record<string, unknown>[] {
  const missingCodes = new Set(['unknown_text_slot', 'unknown_image_slot', 'unknown_transform_slot', 'toggle_slot_missing']);
  const suggestions: Record<string, unknown>[] = [];
  for (const item of rejected.filter((entry) => missingCodes.has(entry.code))) {
    const slotKey = String(item.action?.slotKey || '').trim();
    const capability = actionCapability(item.action);
    if (!slotKey || !capability) continue;
    const sourceSlot = slotWithCapability(sourceInspection, slotKey, capability);
    const targetCandidates = slotsWithCapability(targetInspection, capability)
      .map((slot) => {
        const scored = candidateScore(sourceSlot, slot, slotKey);
        return {
          targetSlotKey: slot.key,
          targetLayerPath: slot.layerPath,
          confidence: scored.confidence,
          reason: scored.reason,
          score: scored.score,
        };
      })
      .sort((a, b) => b.score - a.score || a.targetSlotKey.localeCompare(b.targetSlotKey, 'zh-Hans-CN'))
      .slice(0, 5)
      .map(({ score: _score, ...candidate }) => candidate);

    suggestions.push({
      sourceSlotKey: slotKey,
      sourceLayerPath: sourceSlot?.layerPath || null,
      actionTypes: uniqueStrings(actions
        .filter((action) => String(action.slotKey || '').trim() === slotKey)
        .map((action) => String(action.type || '').trim())),
      capability,
      confirmRequired: true,
      candidates: targetCandidates,
    });
  }
  return suggestions;
}

function deriveActionsForTarget(
  preset: ActionPresetRecord,
  targetInspection: ManifestInspectionPayload,
  mappings: ConfirmedSlotMapping[],
): {
  uiActions: UiAction[];
  changes: DerivedActionChange[];
  appliedMappings: Array<ConfirmedSlotMapping & { targetLayerPath: string }>;
  unmappedRequired: DerivedActionChange[];
} {
  const mappingByKey = new Map(mappings.map((mapping) => [mappingKey(mapping.sourceSlotKey, mapping.capability), mapping]));
  const appliedByKey = new Map<string, ConfirmedSlotMapping & { targetLayerPath: string }>();
  const changes: DerivedActionChange[] = [];
  const uiActions = preset.uiActions.map((action, index) => {
    const capability = actionCapability(action);
    const sourceSlotKey = String(action.slotKey || '').trim();
    const type = String(action.type || '');
    if (!sourceSlotKey || !capability) {
      changes.push({ index, type, capability, sourceSlotKey, targetSlotKey: sourceSlotKey, mode: 'ignored' });
      return { ...action, id: undefined };
    }

    if (slotWithCapability(targetInspection, sourceSlotKey, capability)) {
      changes.push({ index, type, capability, sourceSlotKey, targetSlotKey: sourceSlotKey, mode: 'kept' });
      return { ...action, id: undefined };
    }

    const mapping = mappingByKey.get(mappingKey(sourceSlotKey, capability));
    if (!mapping) {
      changes.push({ index, type, capability, sourceSlotKey, targetSlotKey: sourceSlotKey, mode: 'unmapped' });
      return { ...action, id: undefined };
    }

    const targetSlot = slotWithCapability(targetInspection, mapping.targetSlotKey, capability);
    if (!targetSlot) {
      throw new Error(`映射无效：目标模板没有 ${capability} 槽位「${mapping.targetSlotKey}」。`);
    }

    const appliedKey = mappingKey(sourceSlotKey, capability);
    appliedByKey.set(appliedKey, { ...mapping, targetLayerPath: targetSlot.layerPath });
    changes.push({
      index,
      type,
      capability,
      sourceSlotKey,
      targetSlotKey: mapping.targetSlotKey,
      mode: 'mapped',
    });
    return { ...action, id: undefined, slotKey: mapping.targetSlotKey };
  });

  return {
    uiActions,
    changes,
    appliedMappings: Array.from(appliedByKey.values()),
    unmappedRequired: changes.filter((change) => change.mode === 'unmapped'),
  };
}

function draftPresetRecord(input: {
  name: string;
  preset: ActionPresetRecord;
  targetInspection: ManifestInspectionPayload;
  uiActions: UiAction[];
}): ActionPresetRecord {
  const now = new Date().toISOString();
  return {
    id: `${input.preset.id}:derived-preview`,
    name: input.name,
    description: `派生自 ${input.preset.name}`,
    createdAt: now,
    updatedAt: now,
    templateId: input.targetInspection.templateId,
    templateDisplayName: input.targetInspection.displayName,
    actionCount: input.uiActions.length,
    slotKeys: uniqueStrings(input.uiActions.map((action) => String(action.slotKey || '').trim())),
    uiActions: input.uiActions,
  };
}

function summarizePresetCompatibility(preset: ActionPresetRecord, preflight: UiActionPreflight): Record<string, unknown> {
  const rejected = preflight.rejectedActions || [];
  const missingSlotCodes = new Set(['unknown_text_slot', 'unknown_image_slot', 'unknown_transform_slot']);
  const missingAssetCodes = new Set(['missing_source_file', 'source_file_not_found']);
  return {
    presetId: preset.id,
    name: preset.name,
    status: preflight.status === 'blocked'
      ? 'blocked'
      : preflight.findings.length > 0
        ? 'warning'
        : 'ready',
    actionCount: preset.actionCount || preset.uiActions.length,
    normalizedCount: preflight.normalizedActions.length,
    slotKeys: preset.slotKeys,
    rejectedCount: rejected.length,
    rejectedCodes: countByCode(rejected),
    missingSlotKeys: slotKeysForCodes(rejected, missingSlotCodes),
    missingAssetSlotKeys: slotKeysForCodes(rejected, missingAssetCodes),
    modelIssueSlotKeys: slotKeysForCodes(rejected, new Set(['model_not_configured'])),
    toggleMissingSlotKeys: slotKeysForCodes(rejected, new Set(['toggle_slot_missing'])),
    unsupportedActionSlotKeys: slotKeysForCodes(rejected, new Set(['unsupported_action_type'])),
    missing: preflight.missing,
    manualRequiredReasons: preflight.manualRequiredReasons,
    findings: preflight.findings,
    rejectedActions: rejected.map((item) => ({
      index: item.index,
      code: item.code,
      message: item.message,
      slotKey: item.action?.slotKey || '',
      type: item.action?.type || '',
    })),
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        design006: design006.status(),
        photoshop: await getPhotoshopStatus(),
        feishu: await getFeishuStatus(),
        models: getResolvedModelRoutes(),
        downloads: listDownloads(),
        jobs: listJobs(),
        presets: listPresets(),
        derivedTargets: listDerivedTargets(),
        feishuTargets: listFeishuTargets(),
        feishuSendHistory: listFeishuSendHistory(),
        modelUsageHistory: listModelUsageHistory(),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/model-routes') {
      sendJson(res, 200, {
        ok: true,
        routes: getResolvedModelRoutes(),
        savedRoutes: listModelRoutes(),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/model-routes') {
      const body = await readJsonBody<{
        key?: string;
        provider?: string;
        primary?: string;
        fallback?: string | null;
        source?: string | null;
        baseUrl?: string | null;
        apiKeyEnv?: string | null;
        enabled?: boolean;
      }>(req);
      const key = String(body.key || '').trim();
      const provider = String(body.provider || 'openai-compatible').trim();
      const primary = String(body.primary || '').trim();
      if (!isModelRouteKey(key)) throw badRequest('模型路由 key 必须是 instruction、image 或 vision。');
      if (!isModelRouteProvider(provider)) throw badRequest('当前只支持 openai-compatible provider。');
      if (!primary) throw badRequest('模型主路由不能为空。');
      const route = saveModelRoute({
        key,
        provider,
        primary,
        fallback: body.fallback,
        source: body.source,
        baseUrl: body.baseUrl,
        apiKeyEnv: body.apiKeyEnv,
        enabled: body.enabled !== false,
      });
      sendJson(res, 200, {
        ok: true,
        route,
        routes: getResolvedModelRoutes(),
        savedRoutes: listModelRoutes(),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/model-routes/preflight') {
      sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        routes: getResolvedModelRoutes(),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/model-routes/live-probe') {
      sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        probes: await probeModelRoutes(),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/model-routes/usage-history') {
      sendJson(res, 200, {
        ok: true,
        history: listModelUsageHistory(),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/models/image/generate') {
      const body = await readJsonBody<{
        prompt?: string;
        modelId?: string;
        size?: string;
        slotKey?: string;
      }>(req);
      if (!String(body.prompt || '').trim()) throw badRequest('生图 prompt 不能为空。');
      const startedAt = Date.now();
      try {
        const result = await generateImageArtifact({
          prompt: String(body.prompt || '').trim(),
          modelId: String(body.modelId || '').trim(),
          size: String(body.size || '').trim(),
          slotKey: String(body.slotKey || '').trim(),
        });
        recordModelImageSuccess(body as Record<string, unknown>, result, Date.now() - startedAt);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        recordModelImageFallback(body as Record<string, unknown>, error, Date.now() - startedAt);
        sendJson(res, 200, {
          ok: true,
          status: 'fallback',
          fallback: {
            mode: 'manual_file',
            reason: safeError(error),
            route: getResolvedModelRoute('image'),
            details: errorDetails(error) || null,
          },
        });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/models/vision/qa') {
      const body = await readJsonBody<{
        imagePath?: string;
        modelId?: string;
        prompt?: string;
      }>(req);
      if (!String(body.imagePath || '').trim()) throw badRequest('缺少要质检的 final.png 路径。');
      const startedAt = Date.now();
      try {
        const result = await runVisionQualityCheck({
          imagePath: String(body.imagePath || '').trim(),
          modelId: String(body.modelId || '').trim(),
          prompt: String(body.prompt || '').trim(),
        });
        recordModelVisionSuccess(body as Record<string, unknown>, result, Date.now() - startedAt);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        recordModelVisionFallback(body as Record<string, unknown>, error, Date.now() - startedAt);
        sendJson(res, 200, {
          ok: true,
          status: 'fallback',
          fallback: {
            mode: 'manual_review',
            reason: safeError(error),
            route: getResolvedModelRoute('vision'),
            details: errorDetails(error) || null,
            nonBlocking: true,
          },
        });
      }
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/presets') {
      sendJson(res, 200, { ok: true, presets: listPresets() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/derived-targets') {
      sendJson(res, 200, { ok: true, derivedTargets: listDerivedTargets() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/feishu/targets') {
      sendJson(res, 200, { ok: true, targets: listFeishuTargets() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/feishu/send-history') {
      sendJson(res, 200, { ok: true, history: listFeishuSendHistory() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/feishu/send-history/export') {
      sendJson(res, 200, feishuAuditExportPayload());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/regression/feishu-output') {
      sendJson(res, 200, await feishuOutputRegressionPayload());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/regression/model-routing') {
      sendJson(res, 200, await modelRoutingRegressionPayload());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/feishu/targets') {
      const body = await readJsonBody<{ type?: string; value?: string; label?: string }>(req);
      const type = String(body.type || '').trim();
      const value = String(body.value || '').trim();
      if (!isFeishuTargetType(type)) throw badRequest('飞书目标类型必须是 chat 或 user。');
      if (!feishuTargetLooksValid(type, value)) {
        throw badRequest(`${type === 'chat' ? 'Chat ID' : 'User ID'} 格式不符合预期。`);
      }
      sendJson(res, 200, {
        ok: true,
        target: saveFeishuTarget({ type, value, label: body.label }),
        targets: listFeishuTargets(),
      });
      return true;
    }

    const feishuTargetMatch = url.pathname.match(/^\/api\/feishu\/targets\/([^/]+)$/);
    if (feishuTargetMatch && req.method === 'DELETE') {
      sendJson(res, 200, {
        ok: true,
        deleted: deleteFeishuTarget(decodeURIComponent(feishuTargetMatch[1] || '')),
        targets: listFeishuTargets(),
      });
      return true;
    }

    const derivedTargetLoadedMatch = url.pathname.match(/^\/api\/derived-targets\/([^/]+)\/loaded$/);
    if (derivedTargetLoadedMatch && req.method === 'POST') {
      const record = markDerivedTargetLoaded(decodeURIComponent(derivedTargetLoadedMatch[1] || ''));
      if (!record) throw new Error('派生目标记录不存在，无法更新载入时间。');
      sendJson(res, 200, { ok: true, derivedTarget: record });
      return true;
    }

    const derivedTargetMatch = url.pathname.match(/^\/api\/derived-targets\/([^/]+)$/);
    if (derivedTargetMatch && req.method === 'DELETE') {
      sendJson(res, 200, { ok: true, deleted: deleteDerivedTarget(decodeURIComponent(derivedTargetMatch[1] || '')) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/manifests/discover') {
      const root = String(url.searchParams.get('root') || '').trim();
      sendJson(res, 200, {
        ok: true,
        roots: uniqueStrings(root ? [root] : MANIFEST_DISCOVERY_ROOTS),
        manifests: discoverManifestItems(root || undefined),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/presets/compatibility') {
      const body = await readJsonBody<{ manifestPath?: string; presetId?: string }>(req);
      const manifestPath = String(body.manifestPath || '').trim();
      if (!manifestPath || !fs.existsSync(manifestPath)) {
        throw new Error('manifestPath 不存在，无法检查 preset 兼容性。');
      }
      const presets = listPresets();
      const selected = body.presetId
        ? presets.filter((preset) => preset.id === body.presetId)
        : presets;
      if (body.presetId && selected.length === 0) {
        throw new Error('preset 不存在，无法检查兼容性。');
      }
      sendJson(res, 200, {
        ok: true,
        manifestPath: path.resolve(manifestPath),
        compatibilities: selected.map((preset) => summarizePresetCompatibility(
          preset,
          preflightUiActions(manifestPath, preset.uiActions),
        )),
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/presets/cross-template') {
      const body = await readJsonBody<{
        currentManifestPath?: string;
        manifestPaths?: string[];
        presetId?: string;
      }>(req);
      const presetId = String(body.presetId || '').trim();
      if (!presetId) throw new Error('缺少 presetId，无法进行跨模板验证。');
      const preset = listPresets().find((item) => item.id === presetId);
      if (!preset) throw new Error('preset 不存在，无法进行跨模板验证。');
      const manifestPaths = uniqueStrings(Array.isArray(body.manifestPaths) ? body.manifestPaths : []);
      if (manifestPaths.length === 0) throw new Error('请至少导入一个真实 manifest 路径。');

      const currentManifestPath = String(body.currentManifestPath || '').trim();
      const sourceInspection = currentManifestPath && fs.existsSync(currentManifestPath)
        ? inspectTemplateManifest(currentManifestPath)
        : null;
      const sourceManifest = sourceInspection
        ? summarizeManifestInspection(sourceInspection, pairedPsdPath(sourceInspection.manifestPath))
        : null;

      const results = manifestPaths.map((targetPath) => {
        const resolvedTarget = path.resolve(targetPath);
        const targetPsdPath = pairedPsdPath(resolvedTarget);
        try {
          const targetInspection = inspectTemplateManifest(resolvedTarget);
          const preflight = preflightUiActions(resolvedTarget, preset.uiActions);
          return {
            manifest: summarizeManifestInspection(targetInspection, targetPsdPath),
            ...summarizePresetCompatibility(preset, preflight),
            mappingSuggestions: buildMappingSuggestions(
              preset.uiActions,
              sourceInspection,
              targetInspection,
              preflight.rejectedActions,
            ),
          };
        } catch (error) {
          return {
            manifest: {
              templateId: null,
              displayName: null,
              manifestPath: resolvedTarget,
              psdPath: targetPsdPath,
              counts: { text: 0, image: 0, transform: 0, toggle: 0 },
              slotCount: 0,
              document: null,
            },
            presetId: preset.id,
            name: preset.name,
            status: 'blocked',
            actionCount: preset.actionCount || preset.uiActions.length,
            normalizedCount: 0,
            rejectedCount: preset.uiActions.length,
            rejectedCodes: [{ code: 'manifest_error', count: 1 }],
            missingSlotKeys: [],
            missingAssetSlotKeys: [],
            modelIssueSlotKeys: [],
            toggleMissingSlotKeys: [],
            unsupportedActionSlotKeys: [],
            missing: [],
            manualRequiredReasons: [],
            findings: [],
            rejectedActions: [{
              index: -1,
              code: 'manifest_error',
              message: safeError(error),
              slotKey: '',
              type: '',
            }],
            mappingSuggestions: [],
          };
        }
      });

      sendJson(res, 200, {
        ok: true,
        preset: {
          id: preset.id,
          name: preset.name,
          actionCount: preset.actionCount,
          slotKeys: preset.slotKeys,
        },
        sourceManifest,
        results,
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/presets/derive-cross-template') {
      const body = await readJsonBody<{
        mappings?: unknown[];
        name?: string;
        presetId?: string;
        targetManifestPath?: string;
      }>(req);
      const presetId = String(body.presetId || '').trim();
      if (!presetId) throw new Error('缺少 presetId，无法派生目标 preset。');
      const preset = listPresets().find((item) => item.id === presetId);
      if (!preset) throw new Error('preset 不存在，无法派生目标 preset。');
      const targetManifestPath = String(body.targetManifestPath || '').trim();
      if (!targetManifestPath || !fs.existsSync(targetManifestPath)) {
        throw new Error('targetManifestPath 不存在，无法派生目标 preset。');
      }

      const targetInspection = inspectTemplateManifest(targetManifestPath);
      const targetTemplateName = targetInspection.templateId || path.basename(path.dirname(targetInspection.manifestPath));
      const derivedName = String(body.name || '').trim() || `${preset.name} -> ${targetTemplateName}`;
      const mappings = normalizeConfirmedMappings(body.mappings);
      const derived = deriveActionsForTarget(preset, targetInspection, mappings);
      const draft = draftPresetRecord({
        name: derivedName,
        preset,
        targetInspection,
        uiActions: derived.uiActions,
      });
      const preflight = preflightUiActions(targetInspection.manifestPath, derived.uiActions);
      const compatibility = summarizePresetCompatibility(draft, preflight);

      if (preflight.status === 'blocked') {
        sendJson(res, 200, {
          ok: true,
          saved: false,
          reason: '目标 manifest 二次预检仍被阻断，未保存 preset。',
          preset: null,
          sourcePreset: {
            id: preset.id,
            name: preset.name,
            actionCount: preset.actionCount,
            slotKeys: preset.slotKeys,
          },
          targetManifest: summarizeManifestInspection(targetInspection, pairedPsdPath(targetInspection.manifestPath)),
          compatibility,
          changes: derived.changes,
          appliedMappings: derived.appliedMappings,
          unmappedRequired: derived.unmappedRequired,
        });
        return true;
      }

      const targetManifest = summarizeManifestInspection(targetInspection, pairedPsdPath(targetInspection.manifestPath));
      const savedPreset = savePreset({
        name: derivedName,
        description: `从 preset「${preset.name}」派生到目标模板「${targetTemplateName}」。`,
        templateId: targetInspection.templateId,
        templateDisplayName: targetInspection.displayName,
        uiActions: derived.uiActions,
      });
      const derivedTargetRecord = saveDerivedTarget({
        sourcePreset: preset,
        targetPreset: savedPreset,
        targetManifest: {
          templateId: targetManifest.templateId,
          displayName: targetManifest.displayName,
          manifestPath: targetManifest.manifestPath,
          psdPath: targetManifest.psdPath,
        },
        appliedMappings: derived.appliedMappings,
      });
      sendJson(res, 200, {
        ok: true,
        saved: true,
        reason: '目标 manifest 二次预检通过，已保存目标模板专用 preset。',
        preset: savedPreset,
        sourcePreset: {
          id: preset.id,
          name: preset.name,
          actionCount: preset.actionCount,
          slotKeys: preset.slotKeys,
        },
        targetManifest,
        derivedTargetRecord,
        compatibility: summarizePresetCompatibility(savedPreset, preflight),
        changes: derived.changes,
        appliedMappings: derived.appliedMappings,
        unmappedRequired: derived.unmappedRequired,
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/presets') {
      const body = await readJsonBody<{
        name?: string;
        description?: string;
        templateId?: string | null;
        templateDisplayName?: string | null;
        uiActions?: unknown[];
      }>(req);
      sendJson(res, 200, { ok: true, preset: savePreset({
        name: String(body.name || '').trim(),
        description: body.description,
        templateId: body.templateId,
        templateDisplayName: body.templateDisplayName,
        uiActions: Array.isArray(body.uiActions) ? body.uiActions as UiAction[] : [],
      }) });
      return true;
    }

    const presetMatch = url.pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (presetMatch && req.method === 'DELETE') {
      sendJson(res, 200, { ok: true, deleted: deletePreset(decodeURIComponent(presetMatch[1] || '')) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/local-image') {
      const filePath = path.resolve(String(url.searchParams.get('path') || '').trim());
      if (!filePath || !isSupportedLocalImage(filePath)) {
        sendJson(res, 400, { ok: false, error: '只允许读取本地 PNG/JPG/WEBP/GIF 预览图。' });
        return true;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { ok: false, error: '本地预览图不存在。' });
        return true;
      }
      sendFile(res, filePath);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/design006/resolve') {
      const body = await readJsonBody<{ url?: string }>(req);
      const detailUrl = String(body.url || '').trim();
      if (!detailUrl) throw new Error('缺少 design006 详情页 URL。');
      sendJson(res, 200, { ok: true, candidate: await design006.resolve(detailUrl) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/design006/search') {
      const body = await readJsonBody<{ query?: string; limit?: number }>(req);
      const query = String(body.query || '').trim();
      if (!query) throw new Error('缺少 design006 搜索关键词。');
      sendJson(res, 200, { ok: true, candidates: await design006.search(query, Number(body.limit || 6)) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/design006/download') {
      const body = await readJsonBody<{ url?: string; candidate?: Record<string, unknown> }>(req);
      const detailUrl = String(body.url || '').trim();
      if (!detailUrl && !body.candidate) throw new Error('缺少 URL 或 candidate。');
      sendJson(res, 200, await design006.download({ detailUrl, candidate: body.candidate }));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/design006/login/continue') {
      const body = await readJsonBody<{ pendingId?: string }>(req);
      sendJson(res, 200, await design006.continueLogin(String(body.pendingId || '').trim()));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/design006/login/cancel') {
      sendJson(res, 200, { ok: await design006.cancelPendingLogin() });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      sendJson(res, 200, { ok: true, ...(await createPhotoshopJob(await readJsonBody(req))) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs/preflight') {
      sendJson(res, 200, { ok: true, preflight: await preflightPhotoshopJob(await readJsonBody(req)) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs/latest-final') {
      sendJson(res, 200, { ok: true, latestFinalJob: await getLatestFinalPhotoshopJob() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs/latest-artifact-center') {
      const latest = await getLatestFinalPhotoshopJob() as Record<string, any>;
      const sessionId = String(latest?.session?.sessionId || '').trim();
      if (!latest?.found || !sessionId) {
        sendJson(res, 200, { ok: true, artifactCenter: null, latestFinalJob: latest });
        return true;
      }
      sendJson(res, 200, {
        ...(await artifactCenterPayload(sessionId)),
        latestFinalJob: latest,
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/manifest/inspect') {
      const body = await readJsonBody<{ manifestPath?: string; psdPath?: string }>(req);
      const manifestPath = String(body.manifestPath || '').trim();
      if (!manifestPath) throw new Error('缺少 manifestPath。');
      sendJson(res, 200, { ok: true, inspection: inspectTemplateManifest(manifestPath, { psdPath: body.psdPath }) });
      return true;
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(confirm-final))?$/);
    if (jobMatch && req.method === 'GET' && !jobMatch[2]) {
      sendJson(res, 200, { ok: true, ...(await getPhotoshopJob(decodeURIComponent(jobMatch[1] || ''))) });
      return true;
    }
    if (jobMatch && req.method === 'POST' && jobMatch[2] === 'confirm-final') {
      sendJson(res, 200, { ok: true, ...(await confirmFinalExport(decodeURIComponent(jobMatch[1] || ''))) });
      return true;
    }

    const jobArtifactMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/artifact-center$/);
    if (jobArtifactMatch && req.method === 'GET') {
      sendJson(res, 200, await artifactCenterPayload(decodeURIComponent(jobArtifactMatch[1] || '')));
      return true;
    }

    const safeRerunMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/safe-rerun$/);
    if (safeRerunMatch && req.method === 'POST') {
      sendJson(res, 200, await safeRerunPayload(
        decodeURIComponent(safeRerunMatch[1] || ''),
        await readJsonBody(req),
      ));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/feishu/send-final') {
      const body = await readJsonBody(req);
      try {
        const preflight = addDuplicateSendInfo(await preflightFinalToFeishu(body));
        if ((preflight as { duplicateSend?: unknown }).duplicateSend && !(body as { forceResend?: boolean }).forceResend) {
          throw duplicateSendError(preflight);
        }
        const payload = await sendFinalToFeishu(body);
        payload.preflight = addDuplicateSendInfo(payload.preflight as Record<string, unknown>);
        const target = (payload.receipt as { target?: { type?: string; value?: string } } | undefined)?.target;
        const targetType = String(target?.type || '').trim();
        const targetValue = String(target?.value || '').trim();
        if (isFeishuTargetType(targetType) && targetValue) {
          markFeishuTargetUsed({ type: targetType, value: targetValue });
        }
        addFeishuSendRecord(feishuSendRecordFromPayload(payload));
        sendJson(res, 200, payload);
      } catch (error) {
        addFeishuSendRecord(feishuSendRecordFromError(error, body));
        throw error;
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/feishu/preflight-final') {
      sendJson(res, 200, { ok: true, preflight: addDuplicateSendInfo(await preflightFinalToFeishu(await readJsonBody(req))) });
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'api not found' });
    return true;
  } catch (error) {
    const details = errorDetails(error);
    sendJson(res, errorStatusCode(error), {
      ok: false,
      error: safeError(error),
      ...(details === undefined ? {} : { details }),
    });
    return true;
  }
}

function serveStatic(res: http.ServerResponse, url: URL): void {
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  if (requested === '/favicon.ico') {
    sendText(res, 204, '');
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (requested === '/local-defaults.json') {
      sendJson(res, 200, {});
      return;
    }
    sendText(res, 404, 'not found');
    return;
  }
  sendFile(res, filePath);
}

async function main(): Promise<void> {
  ensureRuntimeDirs();
  const host = DEFAULT_HOST;
  const port = DEFAULT_PORT;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (!req.url) {
        sendText(res, 400, 'bad request');
        return;
      }
      const url = new URL(req.url, `http://${host}:${port}`);
      if (await handleApi(req, res, url)) return;
      serveStatic(res, url);
    })().catch((error) => {
      sendJson(res, 500, { ok: false, error: safeError(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  console.log(`PS automation console listening on http://${host}:${port}`);
}

void main().catch((error) => {
  console.error(safeError(error));
  process.exit(1);
});
