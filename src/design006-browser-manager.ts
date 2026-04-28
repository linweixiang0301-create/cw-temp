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
import { loadBrowserCdpBridge, loadDesign006Bridge, loadManagedChromeBridge, loadPhotoshopConfigBridge } from './bridge.js';
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

type LoginWindow = {
  id: string;
  createdAt: string;
  runtime: ManagedRuntime;
};

type LoginCheckStatus = 'logged_in' | 'not_logged_in' | 'unknown' | 'error';

type LoginCheckRecord = {
  status: LoginCheckStatus;
  loggedIn: boolean | null;
  checkedAt: string;
  profileDir: string;
  profileExists: boolean;
  port: number | null;
  windowOpen: boolean;
  pendingLoginId: string | null;
  summary: string;
  findings: string[];
  browserStatus?: Record<string, unknown> | null;
};

type DownloadPreflightCheck = {
  code: string;
  status: 'ready' | 'blocked' | 'warning';
  message: string;
};

type DownloadPreflightRecord = {
  id: string;
  status: 'ready' | 'blocked';
  createdAt: string;
  expiresAt: string;
  confirm: string;
  requiresConfirmation: true;
  candidate: any | null;
  detailUrl: string | null;
  templateRoots: string[];
  inboxRoot: string | null;
  loginCheck: LoginCheckRecord;
  checks: DownloadPreflightCheck[];
  rightsNotice: string;
  summary: string;
};

const DOWNLOAD_PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_CONFIRM_VALUE = 'download-design006-source';

function nowIso(): string {
  return new Date().toISOString();
}

function blockedError(message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function isLoginRequired(payload: unknown): boolean {
  const text = JSON.stringify(payload || '').toLowerCase();
  return /登录|未登录|请先登录|login/.test(text);
}

function collapseWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  private loginWindow: LoginWindow | null = null;
  private lastLoginCheck: LoginCheckRecord | null = null;
  private lastDownloadPreflight: DownloadPreflightRecord | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  status(): Record<string, unknown> {
    return {
      profileDir: DESIGN006_PROFILE_DIR,
      profileExists: fs.existsSync(DESIGN006_PROFILE_DIR),
      startPort: DESIGN006_START_PORT,
      loginCheck: this.lastLoginCheck,
      loginWindow: this.loginWindow
        ? {
            id: this.loginWindow.id,
            createdAt: this.loginWindow.createdAt,
            port: this.loginWindow.runtime.port,
            profileDir: this.loginWindow.runtime.profileDir,
          }
        : null,
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
      downloadPreflight: this.lastDownloadPreflight
        ? {
            id: this.lastDownloadPreflight.id,
            status: this.lastDownloadPreflight.status,
            createdAt: this.lastDownloadPreflight.createdAt,
            expiresAt: this.lastDownloadPreflight.expiresAt,
            detailUrl: this.lastDownloadPreflight.detailUrl,
            title: this.lastDownloadPreflight.candidate?.title || null,
          }
        : null,
    };
  }

  async resolve(detailUrl: string): Promise<any> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => {
      await this.assertLoggedInForAction('解析 design006 URL');
      const design006 = await loadDesign006Bridge();
      return this.withDesign006Browser(detailUrl, async () => (
        design006.resolveDesign006DetailCandidate(detailUrl)
      ));
    });
  }

  async search(query: string, limit = 6): Promise<any[]> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => {
      await this.assertLoggedInForAction('搜索 design006 模板');
      const design006 = await loadDesign006Bridge();
      return this.withDesign006Browser('https://www.design006.com', async () => (
        design006.searchDesign006Templates(query, {
          limit,
          channelType: 'local-ui',
          chatId: 'ps-automation-console',
        })
      ));
    });
  }

  async preflightDownload(input: { detailUrl?: string; candidate?: any }): Promise<DownloadPreflightRecord> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => {
      const createdAt = nowIso();
      const checks: DownloadPreflightCheck[] = [];
      const loginCheck = await this.checkLoginStatus();
      const loggedIn = loginCheck.status === 'logged_in';
      checks.push({
        code: 'login_status',
        status: loggedIn ? 'ready' : 'blocked',
        message: loginCheck.summary || 'design006 登录态未通过。',
      });

      const photoshopConfig = await loadPhotoshopConfigBridge();
      const config = photoshopConfig.readPhotoshopConfig();
      const templateRoots = Array.isArray(config.templateRoots) && config.templateRoots.length > 0
        ? config.templateRoots
        : TEMPLATE_ROOTS;
      const inboxRoot = templateRoots.find((item: string) => fs.existsSync(item)) || templateRoots[0] || null;
      checks.push({
        code: 'local_inbox_root',
        status: inboxRoot ? 'ready' : 'blocked',
        message: inboxRoot
          ? `下载源文件将只保存到本机收件箱根目录：${path.resolve(inboxRoot)}`
          : '未配置 Photoshop 模板根目录，无法写入本机 design006 收件箱。',
      });

      const rawDetailUrl = String(input.detailUrl || input.candidate?.detailUrl || '').trim();
      let candidate = input.candidate || null;
      if (!rawDetailUrl && !candidate) {
        checks.push({
          code: 'detail_url',
          status: 'blocked',
          message: '缺少 design006 详情页 URL 或已解析 candidate。',
        });
      } else if (!loggedIn) {
        checks.push({
          code: 'candidate_resolved',
          status: 'blocked',
          message: '登录态未通过，预检没有解析详情页，也没有执行下载动作。',
        });
      } else {
        try {
          const design006 = await loadDesign006Bridge();
          candidate = candidate || await this.withDesign006Browser(rawDetailUrl, async () => (
            design006.resolveDesign006DetailCandidate(rawDetailUrl)
          ));
          checks.push({
            code: 'candidate_resolved',
            status: candidate?.detailUrl && candidate?.workId ? 'ready' : 'blocked',
            message: [
              candidate?.title || 'design006 模板',
              candidate?.workForm || '',
              candidate?.sizeText || '',
              candidate?.fileNumber ? `编号 ${candidate.fileNumber}` : '',
            ].filter(Boolean).join(' · ') || '未解析到有效模板信息。',
          });
        } catch (error) {
          checks.push({
            code: 'candidate_resolved',
            status: 'blocked',
            message: `真实详情页解析失败：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      checks.push({
        code: 'rights_notice',
        status: 'warning',
        message: '预检没有调用 confirm_download、download_api 或 signed_url；确认下载后可能消耗 design006 积分、会员权益或下载额度。',
      });
      checks.push({
        code: 'local_only_boundary',
        status: 'ready',
        message: '下载产物只进入本机 PSD 收件箱，不会发送到飞书。',
      });

      const status: DownloadPreflightRecord['status'] = checks.some((check) => check.status === 'blocked')
        ? 'blocked'
        : 'ready';
      const record: DownloadPreflightRecord = {
        id: crypto.randomUUID(),
        status,
        createdAt,
        expiresAt: new Date(Date.now() + DOWNLOAD_PREFLIGHT_TTL_MS).toISOString(),
        confirm: DOWNLOAD_CONFIRM_VALUE,
        requiresConfirmation: true,
        candidate,
        detailUrl: String(candidate?.detailUrl || rawDetailUrl || '').trim() || null,
        templateRoots,
        inboxRoot: inboxRoot ? path.resolve(inboxRoot) : null,
        loginCheck,
        checks,
        rightsNotice: '确认下载后才会触发 design006 下载确认和源文件下载动作。',
        summary: status === 'ready'
          ? '下载前预检通过，请确认后再执行真实下载。'
          : '下载前预检被阻断，没有执行下载动作。',
      };
      this.lastDownloadPreflight = record;
      return record;
    });
  }

  async download(input: { detailUrl?: string; candidate?: any; preflightId?: string; confirm?: string }): Promise<Record<string, unknown>> {
    this.assertNoPendingLogin();
    return this.runExclusive(async () => {
      const confirmedPreflight = this.requireConfirmedDownloadPreflight(input);
      await this.assertLoggedInForAction('下载 design006 模板');
      const design006 = await loadDesign006Bridge();
      const templateRoots = confirmedPreflight.templateRoots.length > 0
        ? confirmedPreflight.templateRoots
        : TEMPLATE_ROOTS;

      const detailUrl = String(input.detailUrl || confirmedPreflight.detailUrl || '');
      const candidate = confirmedPreflight.candidate || input.candidate || await this.withDesign006Browser(detailUrl, async () => (
        design006.resolveDesign006DetailCandidate(detailUrl)
      ));
      const runtime = this.loginWindow?.runtime || await this.startBrowser(candidate.detailUrl || 'https://www.design006.com');
      const env = this.envForRuntime(runtime);
      const shouldCloseRuntime = !this.loginWindow;
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
        if (shouldCloseRuntime) await runtime.close();
        const record = buildDownloadRecord(candidate, result);
        addDownload(record);
        this.lastDownloadPreflight = null;
        return { ok: result.status !== 'failed', candidate, result, record };
      } catch (error) {
        if (shouldCloseRuntime) await runtime.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async checkLogin(): Promise<LoginCheckRecord> {
    return this.runExclusive(() => this.checkLoginStatus());
  }

  async openLoginWindow(): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      if (this.pendingLogin) {
        return {
          ok: false,
          status: 'pending_download_login',
          message: '已有下载登录窗口等待继续，请先完成登录继续或取消该挂起任务。',
          pendingLogin: this.status().pendingLogin,
          loginCheck: await this.checkLoginStatus(),
        };
      }
      if (!this.loginWindow) {
        const runtime = await this.startBrowser('https://www.design006.com');
        this.loginWindow = {
          id: crypto.randomUUID(),
          createdAt: nowIso(),
          runtime,
        };
      }
      const loginCheck = await this.checkLoginStatus();
      return {
        ok: true,
        status: this.loginWindow ? 'open' : 'closed',
        loginWindow: this.status().loginWindow,
        loginCheck,
      };
    });
  }

  async closeLoginWindow(): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      const current = this.loginWindow;
      if (!current) return { ok: true, status: 'closed', loginCheck: this.lastLoginCheck };
      this.loginWindow = null;
      await current.runtime.close().catch(() => undefined);
      return {
        ok: true,
        status: 'closed',
        closedWindow: {
          id: current.id,
          port: current.runtime.port,
          profileDir: current.runtime.profileDir,
        },
        loginCheck: this.lastLoginCheck,
      };
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

  private async assertLoggedInForAction(actionLabel: string): Promise<void> {
    const loginCheck = await this.checkLoginStatus();
    if (loginCheck.status !== 'logged_in') {
      const detail = loginCheck.summary || 'design006 登录态未通过。';
      throw new Error(`${actionLabel} 已阻断：${detail} 请先在登录态验证分区完成登录检查。`);
    }
  }

  private requireConfirmedDownloadPreflight(input: {
    detailUrl?: string;
    preflightId?: string;
    confirm?: string;
  }): DownloadPreflightRecord {
    const preflight = this.lastDownloadPreflight;
    if (!preflight || preflight.id !== String(input.preflightId || '').trim()) {
      throw blockedError('下载 design006 模板已阻断：请先运行下载前预检，并使用最新预检 ID 确认。');
    }
    if (preflight.status !== 'ready') {
      throw blockedError('下载 design006 模板已阻断：最近一次下载前预检未通过。');
    }
    if (String(input.confirm || '').trim() !== DOWNLOAD_CONFIRM_VALUE) {
      throw blockedError('下载 design006 模板已阻断：缺少显式确认值。');
    }
    const expiresAt = Date.parse(preflight.expiresAt);
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      throw blockedError('下载 design006 模板已阻断：下载前预检已过期，请重新预检。');
    }
    const requestedDetailUrl = String(input.detailUrl || '').trim();
    if (requestedDetailUrl && preflight.detailUrl && requestedDetailUrl !== preflight.detailUrl) {
      throw blockedError('下载 design006 模板已阻断：当前 URL 与最近一次预检 URL 不一致，请重新预检。');
    }
    return preflight;
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

  private async checkLoginStatus(): Promise<LoginCheckRecord> {
    const activeRuntime = this.pendingLogin?.runtime || this.loginWindow?.runtime || null;
    const runtime = activeRuntime || await this.startBrowser('https://www.design006.com');
    const shouldCloseRuntime = !activeRuntime;
    try {
      const browserStatus = await this.probeLoginViaRuntime(runtime);
      const loggedIn = browserStatus.loggedIn;
      const status: LoginCheckStatus = loggedIn === true
        ? 'logged_in'
        : loggedIn === false
          ? 'not_logged_in'
          : 'unknown';
      const record: LoginCheckRecord = {
        status,
        loggedIn,
        checkedAt: nowIso(),
        profileDir: DESIGN006_PROFILE_DIR,
        profileExists: fs.existsSync(DESIGN006_PROFILE_DIR),
        port: runtime.port,
        windowOpen: Boolean(this.pendingLogin || this.loginWindow),
        pendingLoginId: this.pendingLogin?.id || null,
        summary: browserStatus.summary,
        findings: browserStatus.findings,
        browserStatus,
      };
      this.lastLoginCheck = record;
      return record;
    } catch (error) {
      const record: LoginCheckRecord = {
        status: 'error',
        loggedIn: null,
        checkedAt: nowIso(),
        profileDir: DESIGN006_PROFILE_DIR,
        profileExists: fs.existsSync(DESIGN006_PROFILE_DIR),
        port: runtime.port,
        windowOpen: Boolean(this.pendingLogin || this.loginWindow),
        pendingLoginId: this.pendingLogin?.id || null,
        summary: `design006 登录态探测失败：${error instanceof Error ? error.message : String(error)}`,
        findings: [error instanceof Error ? error.message : String(error)],
        browserStatus: null,
      };
      this.lastLoginCheck = record;
      return record;
    } finally {
      if (shouldCloseRuntime) await runtime.close().catch(() => undefined);
    }
  }

  private async probeLoginViaRuntime(runtime: ManagedRuntime): Promise<{
    loggedIn: boolean | null;
    summary: string;
    findings: string[];
    responseStatus?: number;
    responseUrl?: string;
  }> {
    const cdp = await loadBrowserCdpBridge();
    const client = await cdp.connectBrowserPage({
      port: runtime.port,
      urlPattern: 'design006.com',
      fallbackUrl: 'https://www.design006.com',
      timeoutMs: 12_000,
    });
    try {
      await client.navigate('https://www.design006.com');
      const result = await client.eval(`(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const response = await fetch('https://www.design006.com/Home/Account/index', {
          credentials: 'include',
          redirect: 'follow'
        });
        const text = await response.text();
        return {
          status: response.status,
          url: response.url,
          text: text.slice(0, 20000)
        };
      })()`, 20_000) as {
        status: number;
        url: string;
        text: string;
      };
      const text = collapseWhitespace(result.text || '');
      const accountSignal = /我的积分|我的作品|我的收藏|我的记录|我的信息|立即续费/.test(text);
      const loginSignal = /login|登录|注册/i.test(result.url || '') || /登录|注册/.test(text);
      const loggedIn = result.status >= 200 && result.status < 400 && accountSignal
        ? true
        : loginSignal && !accountSignal
          ? false
          : null;
      const loginText = loggedIn === true ? '已登录' : loggedIn === false ? '未登录' : '登录态未知';
      return {
        loggedIn,
        summary: `design006 专用 Chrome 已打开，${loginText}。`,
        findings: loggedIn === null ? ['账号页返回内容未命中登录/未登录特征，请在登录窗口中人工确认。'] : [],
        responseStatus: result.status,
        responseUrl: result.url,
      };
    } finally {
      client.close();
    }
  }

  private async withDesign006Browser<T>(
    startUrl: string,
    fn: (runtime: ManagedRuntime) => Promise<T>,
  ): Promise<T> {
    if (this.loginWindow) {
      return withProcessEnv(this.envForRuntime(this.loginWindow.runtime), async () => fn(this.loginWindow!.runtime));
    }
    return this.withTemporaryBrowser(startUrl, fn);
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
