import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  loadPhotoshopAssetsBridge,
  loadPhotoshopConfigBridge,
  loadPhotoshopJobsBridge,
  loadPhotoshopSessionsBridge,
} from './bridge.js';
import { addJob, listJobs } from './state.js';
import { preflightUiActions, type UiActionPreflight } from './ui-action-adapter.js';

type CreateJobInput = {
  manifestPath?: string;
  originalPsdPath?: string;
  templateId?: string;
  templateDisplayName?: string;
  resolvedAssetPaths?: Record<string, string>;
  normalizedActions?: unknown[];
  uiActions?: unknown[];
};

export async function preflightPhotoshopJob(input: CreateJobInput): Promise<UiActionPreflight> {
  const manifestPath = String(input.manifestPath || '').trim();
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error('manifestPath 不存在，无法预检真实模板。');
  }
  return preflightUiActions(manifestPath, Array.isArray(input.uiActions) ? input.uiActions : []);
}

export async function getPhotoshopStatus(): Promise<Record<string, unknown>> {
  const configBridge = await loadPhotoshopConfigBridge();
  const config = configBridge.readPhotoshopConfig();
  return {
    configured: Boolean(config.configured),
    unavailableReason: config.unavailableReason || null,
    appPath: config.appPath,
    templateRoots: config.templateRoots,
    jobsDir: config.jobsDir,
    baseUrl: config.baseUrl,
  };
}

export async function createPhotoshopJob(input: CreateJobInput): Promise<Record<string, unknown>> {
  const manifestPath = String(input.manifestPath || '').trim();
  const originalPsdPath = String(input.originalPsdPath || '').trim();
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error('manifestPath 不存在，无法创建真实 Photoshop 任务。');
  }
  if (!originalPsdPath || !fs.existsSync(originalPsdPath)) {
    throw new Error('originalPsdPath 不存在，无法创建真实 Photoshop 任务。');
  }

  const configBridge = await loadPhotoshopConfigBridge();
  const assetsBridge = await loadPhotoshopAssetsBridge();
  const sessionsBridge = await loadPhotoshopSessionsBridge();
  const jobsBridge = await loadPhotoshopJobsBridge();
  const config = configBridge.readPhotoshopConfig();
  if (!config.configured) {
    throw new Error(config.unavailableReason || 'Photoshop 自动化未配置完成。');
  }
  const hasUiActions = Array.isArray(input.uiActions);
  const preflight = hasUiActions ? preflightUiActions(manifestPath, input.uiActions || []) : null;
  if (preflight && preflight.status !== 'ready') {
    const error = new Error('UI action 预检未通过，已阻止创建 Photoshop job。') as Error & {
      statusCode?: number;
      details?: UiActionPreflight;
    };
    error.statusCode = 400;
    error.details = preflight;
    throw error;
  }
  const normalizedActions = preflight
    ? preflight.normalizedActions
    : (Array.isArray(input.normalizedActions) ? input.normalizedActions : []);
  const resolvedAssetPaths = {
    ...(input.resolvedAssetPaths || {}),
    ...(preflight?.resolvedAssetPaths || {}),
  };

  const chatId = `local-ui-${crypto.randomUUID()}`;
  const workingPsdPath = assetsBridge.createWorkingPhotoshopCopy('local-ui', chatId, originalPsdPath);
  const session = sessionsBridge.photoshopSessions.createSession({
    channelType: 'local-ui',
    chatId,
    codepilotSessionId: '',
    userPrompt: 'local-ui job',
    sourceType: 'local_template',
    templateId: input.templateId || undefined,
    templateDisplayName: input.templateDisplayName || undefined,
    templateManifestPath: manifestPath,
    originalPsdPath,
    workingPsdPath,
    resolvedAssetPaths,
    normalizedActions,
    executionReport: undefined,
  });
  jobsBridge.queuePhotoshopJob(session, 'preview');
  const queued = sessionsBridge.photoshopSessions.markQueued(session.sessionId) || session;
  const wakeResult = assetsBridge.wakePhotoshopApp(config.appPath);
  const openResult = assetsBridge.openLocalFileInPhotoshop(queued.workingPsdPath, config.appPath);

  addJob({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sessionId: queued.sessionId,
    status: queued.status,
    templateDisplayName: queued.templateDisplayName,
    originalPsdPath: queued.originalPsdPath,
    workingPsdPath: queued.workingPsdPath,
  });

  return { session: queued, wakeResult, openResult, preflight };
}

export async function getPhotoshopJob(sessionId: string): Promise<Record<string, unknown>> {
  const sessionsBridge = await loadPhotoshopSessionsBridge();
  const jobsBridge = await loadPhotoshopJobsBridge();
  const session = sessionsBridge.photoshopSessions.getById(sessionId);
  if (!session) throw new Error('Photoshop session 不存在。');
  return {
    session,
    jobState: jobsBridge.readPhotoshopJobState(sessionId),
  };
}

function fileMeta(filePath: string | undefined): Record<string, unknown> | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  return {
    path: filePath,
    size: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

export async function getLatestFinalPhotoshopJob(): Promise<Record<string, unknown>> {
  const sessionsBridge = await loadPhotoshopSessionsBridge();
  const jobsBridge = await loadPhotoshopJobsBridge();
  for (const record of listJobs()) {
    const jobState = jobsBridge.readPhotoshopJobState(record.sessionId);
    const result = jobState?.result;
    const artifacts = result?.artifacts || {};
    const finalImage = fileMeta(artifacts.finalImagePath);
    const editablePsd = fileMeta(artifacts.editablePsdPath);
    if (result?.status !== 'final_exported' || !finalImage) continue;
    const session = sessionsBridge.photoshopSessions.getById(record.sessionId) || {
      sessionId: record.sessionId,
      channelType: 'local-ui',
      templateDisplayName: record.templateDisplayName,
      originalPsdPath: record.originalPsdPath,
      workingPsdPath: record.workingPsdPath,
      status: record.status,
      createdAt: Date.parse(record.createdAt) || 0,
      updatedAt: result.updatedAt || Date.parse(record.createdAt) || 0,
    };
    return {
      found: true,
      source: 'console-job-history',
      session,
      jobState,
      artifacts: {
        finalImagePath: finalImage.path,
        editablePsdPath: editablePsd?.path || artifacts.editablePsdPath || null,
      },
      files: {
        finalImage,
        editablePsd,
      },
    };
  }

  const sessions = typeof sessionsBridge.photoshopSessions.listSessions === 'function'
    ? sessionsBridge.photoshopSessions.listSessions()
    : [];
  const candidates = sessions
    .map((session: Record<string, unknown>) => {
      const sessionId = String(session.sessionId || '').trim();
      if (!sessionId) return null;
      const jobState = jobsBridge.readPhotoshopJobState(sessionId);
      const result = jobState?.result;
      const artifacts = result?.artifacts || {};
      const finalImage = fileMeta(artifacts.finalImagePath);
      const editablePsd = fileMeta(artifacts.editablePsdPath);
      if (result?.status !== 'final_exported' || !finalImage) return null;
      return {
        session,
        jobState,
        artifacts: {
          finalImagePath: finalImage.path,
          editablePsdPath: editablePsd?.path || artifacts.editablePsdPath || null,
        },
        files: {
          finalImage,
          editablePsd,
        },
        sortAt: Number(result.updatedAt || session.updatedAt || session.createdAt || 0),
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.sortAt - a.sortAt);

  const latest = candidates[0] as Record<string, unknown> | undefined;
  if (!latest) return { found: false, reason: '没有找到已完成高清导出的 Photoshop job。' };
  const { sortAt: _sortAt, ...payload } = latest;
  return { found: true, source: 'bridge-session-history', ...payload };
}

export async function confirmFinalExport(sessionId: string): Promise<Record<string, unknown>> {
  const sessionsBridge = await loadPhotoshopSessionsBridge();
  const jobsBridge = await loadPhotoshopJobsBridge();
  const session = sessionsBridge.photoshopSessions.getById(sessionId);
  if (!session) throw new Error('Photoshop session 不存在。');
  const job = jobsBridge.preparePhotoshopFinalExport(session);
  const queued = sessionsBridge.photoshopSessions.markQueued(sessionId) || session;
  return { session: queued, job };
}
