import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN006_PROFILE_DIR,
  DESIGN006_START_PORT,
  TEMPLATE_ROOTS,
  ensureRuntimeDirs,
} from './config.js';
import { withProcessEnv } from './env.js';
import { loadDesign006Bridge, loadManagedChromeBridge, loadPhotoshopConfigBridge } from './bridge.js';
import { addDownload, type DownloadRecord } from './state.js';

type ManagedRuntime = {
  port: number;
  pid: number | null;
  profileDir: string;
  close: () => Promise<void>;
};

type PendingLogin = {
  id: string;
  createdAt: string;
  runtime: ManagedRuntime;
  env: Record<string, string>;
  kind: 'download';
  candidate: any;
  templateRoots: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function isLoginRequired(payload: unknown): boolean {
  const text = JSON.stringify(payload || '').toLowerCase();
  return /登录|未登录|请先登录|login/.test(text);
}

function buildDownloadRecord(candidate: any, result: any): DownloadRecord {
  return {
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    status: String(result?.status || 'unknown'),
    title: String(candidate?.title || 'design006 模板'),
    detailUrl: String(result?.detailUrl || candidate?.detailUrl || ''),
    inboxDir: result?.inboxDir || undefined,
    previewImagePath: result?.previewImagePath || null,
    downloadedFilePath: result?.downloadedFilePath || null,
    primaryPsdPath: result?.primaryPsdPath || null,
    draftPath: result?.draftPath || null,
    findings: Array.isArray(result?.findings) ? result.findings.map(String) : [],
  };
}

export class Design006BrowserManager {
  private pendingLogin: PendingLogin | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  status(): Record<string, unknown> {
    return {
      profileDir: DESIGN006_PROFILE_DIR,
      profileExists: fs.existsSync(DESIGN006_PROFILE_DIR),
      startPort: DESIGN006_START_PORT,
      pendingLogin: this.pendingLogin
        ? {
            id: this.pendingLogin.id,
            createdAt: this.pendingLogin.createdAt,
            port: this.pendingLogin.runtime.port,
            profileDir: this.pendingLogin.runtime.profileDir,
            detailUrl: this.pendingLogin.candidate?.detailUrl || null,
            title: this.pendingLogin.candidate?.title || null,
          }
        : null,
    };
  }

  async resolve(detailUrl: string): Promise<any> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => this.withTemporaryBrowser(detailUrl, async () => {
      const design006 = await loadDesign006Bridge();
      return design006.resolveDesign006DetailCandidate(detailUrl);
    }));
  }

  async search(query: string, limit = 6): Promise<any[]> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => this.withTemporaryBrowser('https://www.design006.com', async () => {
      const design006 = await loadDesign006Bridge();
      return design006.searchDesign006Templates(query, {
        limit,
        channelType: 'local-ui',
        chatId: 'ps-automation-console',
      });
    }));
  }

  async download(input: { detailUrl?: string; candidate?: any }): Promise<Record<string, unknown>> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => {
      const design006 = await loadDesign006Bridge();
      const photoshopConfig = await loadPhotoshopConfigBridge();
      const config = photoshopConfig.readPhotoshopConfig();
      const templateRoots = Array.isArray(config.templateRoots) && config.templateRoots.length > 0
        ? config.templateRoots
        : TEMPLATE_ROOTS;

      const candidate = input.candidate || await design006.resolveDesign006DetailCandidate(String(input.detailUrl || ''));
      const runtime = await this.startBrowser(candidate.detailUrl || 'https://www.design006.com');
      const env = this.envForRuntime(runtime);
      try {
        const result = await withProcessEnv(env, async () => (
          design006.downloadDesign006Template(candidate, { templateRoots })
        ));
        if (isLoginRequired(result)) {
          const pendingId = crypto.randomUUID();
          this.pendingLogin = {
            id: pendingId,
            createdAt: nowIso(),
            runtime,
            env,
            kind: 'download',
            candidate,
            templateRoots,
          };
          return {
            ok: false,
            requiresLogin: true,
            pendingId,
            port: runtime.port,
            profileDir: runtime.profileDir,
            result,
            message: 'design006 需要登录；请在已打开的临时 Chrome 窗口完成登录，然后点击“已登录继续”。',
          };
        }
        await runtime.close();
        const record = buildDownloadRecord(candidate, result);
        addDownload(record);
        return { ok: result.status !== 'failed', candidate, result, record };
      } catch (error) {
        await runtime.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async continueLogin(pendingId: string): Promise<Record<string, unknown>> {
    const pending = this.pendingLogin;
    if (!pending || pending.id !== pendingId) {
      throw new Error('没有匹配的 design006 挂起登录任务。');
    }
    this.pendingLogin = null;
    try {
      const design006 = await loadDesign006Bridge();
      const result = await withProcessEnv(pending.env, async () => (
        design006.downloadDesign006Template(pending.candidate, {
          templateRoots: pending.templateRoots,
        })
      ));
      const record = buildDownloadRecord(pending.candidate, result);
      addDownload(record);
      return { ok: result.status !== 'failed', candidate: pending.candidate, result, record };
    } finally {
      await pending.runtime.close().catch(() => undefined);
    }
  }

  async cancelPendingLogin(): Promise<boolean> {
    const pending = this.pendingLogin;
    if (!pending) return false;
    this.pendingLogin = null;
    await pending.runtime.close().catch(() => undefined);
    return true;
  }

  private assertNoPendingLogin(): void {
    if (this.pendingLogin) {
      throw new Error('已有 design006 登录窗口等待继续，请先完成登录、继续或取消。');
    }
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.operation.catch(() => undefined);
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async startBrowser(startUrl: string): Promise<ManagedRuntime> {
    ensureRuntimeDirs();
    const chrome = await loadManagedChromeBridge();
    return chrome.startManagedChromeRuntime({
      port: DESIGN006_START_PORT,
      strictPort: false,
      profileDir: DESIGN006_PROFILE_DIR,
      startUrl,
      timeoutMs: 30_000,
    });
  }

  private async withTemporaryBrowser<T>(
    startUrl: string,
    fn: (runtime: ManagedRuntime) => Promise<T>,
  ): Promise<T> {
    const runtime = await this.startBrowser(startUrl);
    try {
      return await withProcessEnv(this.envForRuntime(runtime), async () => fn(runtime));
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }

  private envForRuntime(runtime: ManagedRuntime): Record<string, string> {
    return {
      DESIGN006_MANAGED_BROWSER_PORT: String(runtime.port),
      DESIGN006_BROWSER_PROFILE_DIR: path.resolve(runtime.profileDir),
      DESIGN006_REUSE_OPEN_BROWSER: '1',
    };
  }
}
