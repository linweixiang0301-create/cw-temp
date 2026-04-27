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

type StateShape = {
  downloads: DownloadRecord[];
  jobs: ConsoleJobRecord[];
  presets: ActionPresetRecord[];
  derivedTargets: DerivedTargetRecord[];
};

const STATE_PATH = runtimePath('console-state.json');

function emptyState(): StateShape {
  return { downloads: [], jobs: [], presets: [], derivedTargets: [] };
}

function normalizeState(raw: Partial<StateShape> | null | undefined): StateShape {
  return {
    downloads: Array.isArray(raw?.downloads) ? raw.downloads : [],
    jobs: Array.isArray(raw?.jobs) ? raw.jobs : [],
    presets: Array.isArray(raw?.presets) ? raw.presets : [],
    derivedTargets: Array.isArray(raw?.derivedTargets) ? raw.derivedTargets : [],
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
