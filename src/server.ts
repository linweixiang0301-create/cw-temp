import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_HOST, DEFAULT_PORT, MANIFEST_DISCOVERY_ROOTS, PUBLIC_DIR, ensureRuntimeDirs, getModelRoutingStatus } from './config.js';
import { Design006BrowserManager } from './design006-browser-manager.js';
import { getFeishuStatus, preflightFinalToFeishu, sendFinalToFeishu } from './feishu-output.js';
import { readJsonBody, sendFile, sendJson, sendText } from './http.js';
import {
  confirmFinalExport,
  getLatestFinalPhotoshopJob,
  createPhotoshopJob,
  getPhotoshopJob,
  getPhotoshopStatus,
  preflightPhotoshopJob,
} from './photoshop-service.js';
import {
  deleteDerivedTarget,
  deletePreset,
  listDerivedTargets,
  listDownloads,
  listJobs,
  listPresets,
  markDerivedTargetLoaded,
  saveDerivedTarget,
  savePreset,
  type ActionPresetRecord,
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
        models: getModelRoutingStatus(),
        downloads: listDownloads(),
        jobs: listJobs(),
        presets: listPresets(),
        derivedTargets: listDerivedTargets(),
      });
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

    if (req.method === 'POST' && url.pathname === '/api/feishu/send-final') {
      sendJson(res, 200, await sendFinalToFeishu(await readJsonBody(req)));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/feishu/preflight-final') {
      sendJson(res, 200, { ok: true, preflight: await preflightFinalToFeishu(await readJsonBody(req)) });
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
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
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
