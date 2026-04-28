import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(APP_ROOT, '.env.local'));

export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const BRIDGE_ROOT = process.env.PS_AUTOMATION_BRIDGE_ROOT
  || path.join(os.homedir(), 'Desktop', '飞书Claude', 'claude-feishu-bridge');

export const RUNTIME_ROOT = process.env.PS_AUTOMATION_HOME
  || path.join(os.homedir(), '.codex', 'ps-automation');

export const DESIGN006_PROFILE_DIR = process.env.PS_AUTOMATION_DESIGN006_PROFILE_DIR
  || path.join(RUNTIME_ROOT, 'design006-profile');

export const DESIGN006_START_PORT = Number.parseInt(
  process.env.PS_AUTOMATION_DESIGN006_START_PORT || '9232',
  10,
);

export const DEFAULT_HOST = process.env.PS_AUTOMATION_HOST || '127.0.0.1';
export const DEFAULT_PORT = Number.parseInt(process.env.PS_AUTOMATION_PORT || '3498', 10);
export const TEMPLATE_ROOTS = pathListFromEnv('PS_AUTOMATION_TEMPLATE_ROOTS', [
  path.join(os.homedir(), 'Desktop'),
]);
export const MANIFEST_DISCOVERY_ROOTS = pathListFromEnv('PS_AUTOMATION_MANIFEST_ROOTS', [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
]);

export type ModelRouteStatus = {
  key: string;
  label: string;
  configured: boolean;
  primary: string | null;
  fallback: string | null;
  source: string | null;
};

function envValue(name: string): string | null {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function pathListFromEnv(name: string, fallback: string[]): string[] {
  const raw = String(process.env[name] || '').trim();
  const entries = raw
    ? raw.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean)
    : fallback;
  return [...new Set(entries.map((entry) => path.resolve(expandHome(entry))))];
}

export function getModelRoutingStatus(): ModelRouteStatus[] {
  return [
    {
      key: 'instruction',
      label: '指令解析模型',
      configured: Boolean(envValue('PS_AUTOMATION_INSTRUCTION_MODEL')),
      primary: envValue('PS_AUTOMATION_INSTRUCTION_MODEL'),
      fallback: envValue('PS_AUTOMATION_INSTRUCTION_FALLBACK_MODEL'),
      source: envValue('PS_AUTOMATION_INSTRUCTION_MODEL_SOURCE'),
    },
    {
      key: 'image',
      label: '生图 / 图生图模型',
      configured: Boolean(envValue('PS_AUTOMATION_IMAGE_MODEL')),
      primary: envValue('PS_AUTOMATION_IMAGE_MODEL'),
      fallback: envValue('PS_AUTOMATION_IMAGE_FALLBACK_MODEL'),
      source: envValue('PS_AUTOMATION_IMAGE_MODEL_SOURCE'),
    },
    {
      key: 'vision',
      label: '预览 / 最终质检模型',
      configured: Boolean(envValue('PS_AUTOMATION_VISION_MODEL')),
      primary: envValue('PS_AUTOMATION_VISION_MODEL'),
      fallback: envValue('PS_AUTOMATION_VISION_FALLBACK_MODEL'),
      source: envValue('PS_AUTOMATION_VISION_MODEL_SOURCE'),
    },
  ];
}

export function ensureRuntimeDirs(): void {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  fs.mkdirSync(DESIGN006_PROFILE_DIR, { recursive: true });
}

export function runtimePath(...segments: string[]): string {
  return path.join(RUNTIME_ROOT, ...segments);
}
