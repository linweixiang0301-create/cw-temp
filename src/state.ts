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

type StateShape = {
  downloads: DownloadRecord[];
  jobs: ConsoleJobRecord[];
  presets: ActionPresetRecord[];
};

const STATE_PATH = runtimePath('console-state.json');

function emptyState(): StateShape {
  return { downloads: [], jobs: [], presets: [] };
}

function normalizeState(raw: Partial<StateShape> | null | undefined): StateShape {
  return {
    downloads: Array.isArray(raw?.downloads) ? raw.downloads : [],
    jobs: Array.isArray(raw?.jobs) ? raw.jobs : [],
    presets: Array.isArray(raw?.presets) ? raw.presets : [],
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
  writeState(state);
  return state.presets.length !== before;
}
