import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runtimePath } from './config.js';
import {
  listModelRoutes,
  type ModelRouteKey,
  type ModelRouteProvider,
  type ModelRouteRecord,
} from './state.js';

type RouteMeta = {
  key: ModelRouteKey;
  label: string;
  envPrefix: string;
};

export type ResolvedModelRoute = {
  key: ModelRouteKey;
  label: string;
  configured: boolean;
  ready: boolean;
  enabled: boolean;
  primary: string | null;
  fallback: string | null;
  source: string | null;
  sourceKind: 'local' | 'env' | 'codex' | 'none';
  provider: ModelRouteProvider | null;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  modelApiKeyEnvs: Record<string, string>;
  models: string[];
  codexAuth?: CodexAuthStatus | null;
  findings: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'error' }>;
};

type ModelRequestResult = {
  model: string;
  route: ResolvedModelRoute;
  response: unknown;
  selectedRole: ModelRouteAttempt['role'];
  apiKeyEnv: string | null;
  usage: Record<string, unknown> | null;
  attempts: ModelRouteAttempt[];
};

type ImageRequestResult = ModelRequestResult & {
  endpointKind: 'images' | 'chat';
  image: {
    buffer: Buffer;
    source: string;
  };
};

type ModelRouteAttempt = {
  model: string;
  role: 'primary' | 'fallback' | 'requested';
  apiKeyEnv: string | null;
  endpointKind?: 'images' | 'chat';
  status: 'success' | 'failed';
  durationMs: number;
  error?: string;
};

type ImageGenerationInput = {
  prompt: string;
  modelId?: string;
  size?: string;
  slotKey?: string;
};

type VisionQaInput = {
  imagePath: string;
  modelId?: string;
  prompt?: string;
};

type CodexAuthStatus = {
  checkedAt: string;
  status: 'logged_in' | 'not_logged_in' | 'missing' | 'unknown';
  authMode: string | null;
  configModel: string | null;
  configProvider: string | null;
  lastRefresh: string | null;
  authPath: string;
  configPath: string;
  findings: string[];
};

export type ModelRouteProbeResult = {
  key: ModelRouteKey;
  label: string;
  checkedAt: string;
  status: 'ready' | 'blocked' | 'skipped';
  routeReady: boolean;
  endpoint?: string | null;
  latencyMs?: number | null;
  modelCount?: number | null;
  configuredModels?: string[];
  matchedModels?: string[];
  findings: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'error' }>;
  error?: string | null;
};

const ROUTES: RouteMeta[] = [
  { key: 'instruction', label: '指令解析模型', envPrefix: 'PS_AUTOMATION_INSTRUCTION' },
  { key: 'image', label: '生图 / 图生图模型', envPrefix: 'PS_AUTOMATION_IMAGE' },
  { key: 'vision', label: '预览 / 最终质检模型', envPrefix: 'PS_AUTOMATION_VISION' },
];

const DEFAULT_IMAGE_SIZE = '1024x1024';
const DEFAULT_VISION_PROMPT = [
  '请质检这张 Photoshop 最终 PNG。',
  '请用中文返回：整体是否可投递、明显文字/图像异常、是否需要人工复核。',
  '如果无法判断，请明确说明原因。',
].join('\n');

function codexHome(): string {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function simpleTomlValue(content: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = content.match(pattern);
  if (!match) return null;
  const raw = String(match[1] || '').replace(/\s+#.*$/, '').trim();
  if (!raw) return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim() || null;
  }
  return raw.trim() || null;
}

function readCodexAuthStatus(): CodexAuthStatus {
  const home = codexHome();
  const authPath = path.join(home, 'auth.json');
  const configPath = path.join(home, 'config.toml');
  const findings: string[] = [];
  let authMode: string | null = null;
  let lastRefresh: string | null = null;
  let tokenPresent = false;
  let configModel: string | null = null;
  let configProvider: string | null = null;

  try {
    if (!fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
      findings.push('未找到本地 Codex auth.json。');
      return {
        checkedAt: new Date().toISOString(),
        status: 'missing',
        authMode,
        configModel,
        configProvider,
        lastRefresh,
        authPath,
        configPath,
        findings,
      };
    }
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens as Record<string, unknown> : {};
    authMode = String(auth.auth_mode || '').trim() || null;
    lastRefresh = String(auth.last_refresh || '').trim() || null;
    tokenPresent = Boolean(String(tokens.access_token || '').trim() || String(tokens.refresh_token || '').trim());
  } catch (error) {
    findings.push(`读取本地 Codex auth 状态失败：${error instanceof Error ? error.message : String(error)}`);
    return {
      checkedAt: new Date().toISOString(),
      status: 'unknown',
      authMode,
      configModel,
      configProvider,
      lastRefresh,
      authPath,
      configPath,
      findings,
    };
  }

  try {
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      const config = fs.readFileSync(configPath, 'utf8');
      configModel = simpleTomlValue(config, 'model');
      configProvider = simpleTomlValue(config, 'model_provider');
    } else {
      findings.push('未找到本地 Codex config.toml，使用默认模型名。');
    }
  } catch (error) {
    findings.push(`读取本地 Codex config 状态失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!tokenPresent) findings.push('本地 Codex 未检测到 ChatGPT 登录 token。');
  if (authMode && authMode !== 'chatgpt') findings.push(`当前 Codex auth_mode=${authMode}，不是 ChatGPT 登录态。`);

  return {
    checkedAt: new Date().toISOString(),
    status: tokenPresent && (!authMode || authMode === 'chatgpt') ? 'logged_in' : 'not_logged_in',
    authMode,
    configModel,
    configProvider,
    lastRefresh,
    authPath,
    configPath,
    findings,
  };
}

export class ModelRouteError extends Error {
  statusCode: number;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function envValue(name: string): string | null {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

function envModelApiKeyEnvs(meta: RouteMeta): Record<string, string> {
  const raw = envValue(`${meta.envPrefix}_MODEL_API_KEY_ENVS`);
  if (!raw) return {};
  return raw.split(/[,\n]/).reduce<Record<string, string>>((acc, entry) => {
    const line = entry.trim();
    if (!line || line.startsWith('#')) return acc;
    const separatorIndex = line.includes('=') ? line.indexOf('=') : line.indexOf(':');
    if (separatorIndex <= 0) return acc;
    const model = line.slice(0, separatorIndex).trim();
    const envName = line.slice(separatorIndex + 1).trim();
    if (model && envName) acc[model] = envName;
    return acc;
  }, {});
}

function routeMeta(key: ModelRouteKey): RouteMeta {
  return ROUTES.find((item) => item.key === key) || ROUTES[0]!;
}

function envRoute(meta: RouteMeta): ModelRouteRecord | null {
  const primary = envValue(`${meta.envPrefix}_MODEL`);
  if (!primary) return null;
  const now = new Date().toISOString();
  return {
    key: meta.key,
    provider: 'openai-compatible',
    primary,
    fallback: envValue(`${meta.envPrefix}_FALLBACK_MODEL`),
    source: envValue(`${meta.envPrefix}_MODEL_SOURCE`) || 'env',
    baseUrl: envValue(`${meta.envPrefix}_BASE_URL`),
    apiKeyEnv: envValue(`${meta.envPrefix}_API_KEY_ENV`)
      || (envValue(`${meta.envPrefix}_API_KEY`) ? `${meta.envPrefix}_API_KEY` : null),
    modelApiKeyEnvs: envModelApiKeyEnvs(meta),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function codexLoginRoute(meta: RouteMeta, auth: CodexAuthStatus): ModelRouteRecord | null {
  if (meta.key !== 'instruction' || auth.status === 'missing') return null;
  const now = new Date().toISOString();
  return {
    key: meta.key,
    provider: 'codex-login',
    primary: auth.configModel || 'gpt-5.5',
    fallback: null,
    source: 'local-codex-login',
    baseUrl: null,
    apiKeyEnv: null,
    modelApiKeyEnvs: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function localRoute(key: ModelRouteKey): ModelRouteRecord | null {
  return listModelRoutes().find((record) => record.key === key) || null;
}

function routeModels(record: ModelRouteRecord | null): string[] {
  if (!record || record.enabled === false) return [];
  return [...new Set([record.primary, record.fallback].map((item) => String(item || '').trim()).filter(Boolean))];
}

function isLocalBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(baseUrl);
}

function likelyNeedsApiKey(baseUrl: string | null): boolean {
  if (!baseUrl || isLocalBaseUrl(baseUrl)) return false;
  return /openai\.com|api\./i.test(baseUrl);
}

function modelApiKeyEnvForRoute(route: ResolvedModelRoute, model?: string | null): string | null {
  const modelName = String(model || '').trim();
  return (modelName && route.modelApiKeyEnvs[modelName]) || route.apiKeyEnv || null;
}

function credentialForRoute(route: ResolvedModelRoute, model?: string | null): { apiKey: string | null; apiKeyEnv: string | null } {
  const meta = routeMeta(route.key);
  const modelApiKeyEnv = modelApiKeyEnvForRoute(route, model);
  const candidates = [
    modelApiKeyEnv,
    `${meta.envPrefix}_API_KEY`,
    route.baseUrl?.includes('openai.com') ? 'OPENAI_API_KEY' : '',
  ].filter(Boolean) as string[];
  for (const name of [...new Set(candidates)]) {
    const value = envValue(name);
    if (value) return { apiKey: value, apiKeyEnv: name };
  }
  return { apiKey: null, apiKeyEnv: modelApiKeyEnv || route.apiKeyEnv || null };
}

function findingsForRoute(route: ResolvedModelRoute): ResolvedModelRoute['findings'] {
  const findings: ResolvedModelRoute['findings'] = [];
  if (!route.enabled) {
    findings.push({ code: 'route_disabled', severity: 'warning', message: '本地模型路由已禁用。' });
  }
  if (route.provider === 'codex-login' && route.key !== 'instruction') {
    findings.push({ code: 'provider_role_mismatch', severity: 'error', message: 'codex-login 仅允许用于指令解析模型。' });
  }
  if (!route.primary) {
    findings.push({ code: 'model_missing', severity: 'error', message: '未设置主模型。' });
  }
  if (route.provider === 'codex-login') {
    const auth = route.codexAuth || readCodexAuthStatus();
    if (auth.status !== 'logged_in') {
      findings.push({
        code: 'codex_login_missing',
        severity: 'error',
        message: auth.findings[0] || '本地 Codex 登录态未通过。',
      });
    }
    return findings;
  }
  if ((route.key === 'image' || route.key === 'vision') && !route.baseUrl) {
    findings.push({ code: 'base_url_missing', severity: 'error', message: '真实模型调用需要 OpenAI-compatible Base URL。' });
  }
  const credential = credentialForRoute(route, route.primary);
  if (likelyNeedsApiKey(route.baseUrl) && !credential.apiKey) {
    findings.push({
      code: 'api_key_missing',
      severity: 'error',
      message: `当前 Base URL 通常需要 API Key，请设置 ${credential.apiKeyEnv || 'OPENAI_API_KEY'}。`,
    });
  }
  if (route.apiKeyEnv && !envValue(route.apiKeyEnv) && !isLocalBaseUrl(route.baseUrl)) {
    findings.push({
      code: 'api_key_env_missing',
      severity: 'warning',
      message: `未读取到环境变量 ${route.apiKeyEnv}，真实调用可能失败。`,
    });
  }
  const missingModelCredentialEnvs = Object.entries(route.modelApiKeyEnvs)
    .filter(([, envName]) => !envValue(envName));
  for (const [model, envName] of missingModelCredentialEnvs) {
    findings.push({
      code: 'model_api_key_env_missing',
      severity: 'warning',
      message: `${model} 指定的环境变量 ${envName} 未读取到，调用该模型时会失败并回退。`,
    });
  }
  return findings;
}

function resolveRoute(meta: RouteMeta): ResolvedModelRoute {
  const auth = meta.key === 'instruction' ? readCodexAuthStatus() : null;
  const local = localRoute(meta.key);
  const env = envRoute(meta);
  const codex = auth ? codexLoginRoute(meta, auth) : null;
  const record = local || env || codex;
  const sourceKind: ResolvedModelRoute['sourceKind'] = local
    ? 'local'
    : env
      ? 'env'
      : codex
        ? 'codex'
        : 'none';
  const base: ResolvedModelRoute = {
    key: meta.key,
    label: meta.label,
    configured: Boolean(record?.enabled !== false && record?.primary),
    ready: false,
    enabled: record?.enabled !== false,
    primary: record?.primary || null,
    fallback: record?.fallback || null,
    source: record?.source || null,
    sourceKind,
    provider: record?.provider || null,
    baseUrl: record?.baseUrl || null,
    apiKeyEnv: record?.apiKeyEnv || null,
    modelApiKeyEnvs: record?.modelApiKeyEnvs || {},
    models: routeModels(record),
    codexAuth: record?.provider === 'codex-login' ? auth : null,
    findings: [],
  };
  const findings = findingsForRoute(base);
  return {
    ...base,
    findings,
    ready: base.configured && !findings.some((item) => item.severity === 'error'),
  };
}

export function getResolvedModelRoutes(): ResolvedModelRoute[] {
  return ROUTES.map((meta) => resolveRoute(meta));
}

export function getResolvedModelRoute(key: ModelRouteKey): ResolvedModelRoute {
  return resolveRoute(routeMeta(key));
}

function endpointFor(route: ResolvedModelRoute, suffix: string): string {
  const baseUrl = String(route.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new ModelRouteError('模型 Base URL 未配置。', { route });
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return baseUrl.endsWith('/v1') ? `${baseUrl}${normalizedSuffix}` : `${baseUrl}/v1${normalizedSuffix}`;
}

function headersFor(route: ResolvedModelRoute, model?: string | null): Record<string, string> {
  const credential = credentialForRoute(route, model);
  return {
    'Content-Type': 'application/json',
    ...(credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {}),
  };
}

function roleForModel(route: ResolvedModelRoute, model: string): ModelRouteAttempt['role'] {
  if (model === route.primary) return 'primary';
  if (model === route.fallback) return 'fallback';
  return 'requested';
}

function usageFromResponse(payload: unknown): Record<string, unknown> | null {
  const usage = objectValue(payload).usage;
  return usage && typeof usage === 'object' ? usage as Record<string, unknown> : null;
}

async function fetchJsonWithTimeout(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new ModelRouteError(`模型请求失败：HTTP ${response.status}`, {
        status: response.status,
        endpoint: url,
        response: payload,
      }, response.status >= 400 && response.status < 500 ? 400 : 502);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonGetWithTimeout(url: string, headers: Record<string, string>): Promise<{ payload: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new ModelRouteError(`模型 provider 连通性检查失败：HTTP ${response.status}`, {
        status: response.status,
        endpoint: url,
        response: payload,
        latencyMs,
      }, response.status >= 400 && response.status < 500 ? 400 : 502);
    }
    return { payload, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

function modelIdsFromPayload(payload: unknown): string[] {
  const raw = objectValue(payload);
  const data = Array.isArray(raw.data) ? raw.data : [];
  const models = Array.isArray(raw.models) ? raw.models : [];
  return [...new Set([...data, ...models].map((item) => {
    const rawItem = objectValue(item);
    return String(rawItem.id || rawItem.name || '').trim();
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function probeOneRoute(route: ResolvedModelRoute): Promise<ModelRouteProbeResult> {
  const checkedAt = new Date().toISOString();
  const configuredModels = route.models || [];
  const base = {
    key: route.key,
    label: route.label,
    checkedAt,
    routeReady: route.ready,
    configuredModels,
    matchedModels: [] as string[],
  };
  if (!route.configured) {
    return {
      ...base,
      status: 'skipped',
      findings: [{ code: 'route_not_configured', severity: 'info', message: '未配置模型路由，跳过 live probe。' }],
    };
  }
  if (route.provider === 'codex-login') {
    const auth = route.codexAuth || readCodexAuthStatus();
    return {
      ...base,
      status: route.ready ? 'ready' : 'blocked',
      endpoint: 'local-codex-login',
      latencyMs: 0,
      modelCount: configuredModels.length,
      matchedModels: route.ready ? configuredModels : [],
      findings: route.ready
        ? [{
            code: 'codex_login_ready',
            severity: 'info',
            message: `本地 Codex 登录态已通过，当前模型 ${auth.configModel || route.primary || '-'}.`,
          }]
        : route.findings,
    };
  }
  if (!route.baseUrl) {
    return {
      ...base,
      status: 'skipped',
      findings: [{ code: 'base_url_missing', severity: 'info', message: '没有 Base URL，无法真实请求 provider。' }],
    };
  }

  const endpoint = endpointFor(route, '/models');
  if (!route.ready) {
    return {
      ...base,
      status: 'blocked',
      endpoint,
      findings: route.findings,
    };
  }

  try {
    const uniqueCredentialEnvs = [...new Set(configuredModels.map((model) => credentialForRoute(route, model).apiKeyEnv || '__none__'))];
    const credentialProbes: Array<{ apiKeyEnv: string; latencyMs: number | null; models: string[]; error: string | null }> = await Promise.all(uniqueCredentialEnvs.map(async (apiKeyEnv) => {
      const modelForCredential = configuredModels.find((model) => (credentialForRoute(route, model).apiKeyEnv || '__none__') === apiKeyEnv);
      try {
        const response = await fetchJsonGetWithTimeout(endpoint, headersFor(route, modelForCredential));
        return {
          apiKeyEnv,
          latencyMs: response.latencyMs,
          models: modelIdsFromPayload(response.payload),
          error: null,
        };
      } catch (error) {
        return {
          apiKeyEnv,
          latencyMs: null,
          models: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    const primaryCredentialEnv = credentialForRoute(route, route.primary).apiKeyEnv || '__none__';
    const primaryProbe = credentialProbes.find((probe) => probe.apiKeyEnv === primaryCredentialEnv);
    if (primaryProbe?.error) {
      return {
        ...base,
        status: 'blocked',
        endpoint,
        findings: [{
          code: 'provider_probe_failed',
          severity: 'error',
          message: primaryProbe.error,
        }],
        error: primaryProbe.error,
      };
    }
    const matchedModels = configuredModels.filter((model) => {
      const apiKeyEnv = credentialForRoute(route, model).apiKeyEnv || '__none__';
      return credentialProbes.find((probe) => probe.apiKeyEnv === apiKeyEnv)?.models.includes(model);
    });
    const missingModels = configuredModels.filter((model) => !matchedModels.includes(model));
    const failedFallbackCredentials = credentialProbes.filter((probe) => probe.error && probe.apiKeyEnv !== primaryCredentialEnv);
    const latencies = credentialProbes.map((probe) => probe.latencyMs).filter((latency): latency is number => typeof latency === 'number');
    return {
      ...base,
      status: 'ready',
      endpoint,
      latencyMs: latencies.length ? Math.max(...latencies) : null,
      modelCount: [...new Set(credentialProbes.flatMap((probe) => probe.models))].length,
      matchedModels,
      findings: [
        ...failedFallbackCredentials.map((probe) => ({
          code: 'fallback_provider_probe_failed',
          severity: 'warning' as const,
          message: `备选模型凭据 ${probe.apiKeyEnv} 连通性检查失败：${probe.error}`,
        })),
        ...(missingModels.length ? [{
            code: 'configured_model_not_listed',
            severity: 'warning' as const,
            message: `provider 可连通，但未在 /v1/models 返回中看到：${missingModels.join(', ')}`,
          }] : []),
      ],
    };
  } catch (error) {
    return {
      ...base,
      status: 'blocked',
      endpoint,
      findings: [{
        code: 'provider_probe_failed',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      }],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeModelRoutes(): Promise<ModelRouteProbeResult[]> {
  return Promise.all(getResolvedModelRoutes().map((route) => probeOneRoute(route)));
}

async function callModels(
  route: ResolvedModelRoute,
  preferredModel: string | undefined,
  makeRequest: (model: string) => { endpoint: string; payload: unknown },
): Promise<ModelRequestResult> {
  if (!route.ready) {
    throw new ModelRouteError(`${route.label}未就绪。`, { route, findings: route.findings });
  }
  const models = [...new Set([preferredModel, route.primary, route.fallback].map((item) => String(item || '').trim()).filter(Boolean))];
  const attempts: ModelRouteAttempt[] = [];
  for (const model of models) {
    const role = roleForModel(route, model);
    const apiKeyEnv = credentialForRoute(route, model).apiKeyEnv;
    const startedAt = Date.now();
    try {
      const request = makeRequest(model);
      const response = await fetchJsonWithTimeout(request.endpoint, request.payload, headersFor(route, model));
      attempts.push({ model, role, apiKeyEnv, status: 'success', durationMs: Date.now() - startedAt });
      return {
        model,
        route,
        response,
        selectedRole: role,
        apiKeyEnv,
        usage: usageFromResponse(response),
        attempts,
      };
    } catch (error) {
      attempts.push({
        model,
        role,
        apiKeyEnv,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new ModelRouteError('主模型与备选模型均未生成可用结果。', { route, failures: attempts, attempts }, 502);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nestedCandidates(payload: unknown): unknown[] {
  const raw = objectValue(payload);
  const data = Array.isArray(raw.data) ? raw.data : [];
  const images = Array.isArray(raw.images) ? raw.images : [];
  return [raw, ...data, ...images];
}

function dataUrlBuffer(value: string): Buffer | null {
  const match = value.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return Buffer.from(match[2] || '', 'base64');
}

function imageExtension(buffer: Buffer): { extension: string; mime: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: '.webp', mime: 'image/webp' };
  }
  return null;
}

async function imageBufferFromUrl(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new ModelRouteError(`模型返回的图片 URL 下载失败：HTTP ${response.status}`, { url }, 502);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function extractGeneratedImage(payload: unknown): Promise<{ buffer: Buffer; source: string }> {
  for (const candidate of nestedCandidates(payload)) {
    const raw = objectValue(candidate);
    const b64 = String(raw.b64_json || raw.base64 || raw.image_base64 || '').trim();
    if (b64) {
      const buffer = dataUrlBuffer(b64) || Buffer.from(b64, 'base64');
      return { buffer, source: 'base64' };
    }
    const url = String(raw.url || raw.image_url || '').trim();
    if (url) return { buffer: await imageBufferFromUrl(url), source: 'url' };
  }
  throw new ModelRouteError('模型响应中没有找到真实图片数据。', { responseShape: Object.keys(objectValue(payload)) }, 502);
}

async function callImageGenerationModels(
  route: ResolvedModelRoute,
  input: ImageGenerationInput,
): Promise<ImageRequestResult> {
  if (!route.ready) {
    throw new ModelRouteError(`${route.label}未就绪。`, { route, findings: route.findings });
  }
  const prompt = String(input.prompt || '').trim();
  const size = input.size || DEFAULT_IMAGE_SIZE;
  const models = [...new Set([input.modelId, route.primary, route.fallback].map((item) => String(item || '').trim()).filter(Boolean))];
  const attempts: ModelRouteAttempt[] = [];

  for (const model of models) {
    const role = roleForModel(route, model);
    const apiKeyEnv = credentialForRoute(route, model).apiKeyEnv;
    const endpointAttempts: Array<{ endpointKind: 'images' | 'chat'; endpoint: string; payload: unknown }> = [
      {
        endpointKind: 'images',
        endpoint: endpointFor(route, '/images/generations'),
        payload: {
          model,
          prompt,
          size,
          n: 1,
          response_format: 'b64_json',
        },
      },
      {
        endpointKind: 'chat',
        endpoint: endpointFor(route, '/chat/completions'),
        payload: {
          model,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  prompt,
                  `Target output size: ${size}.`,
                  'Return a real generated image. Avoid poster text, logos, QR codes, and watermarks unless explicitly requested.',
                ].join('\n'),
              },
            ],
          }],
          max_tokens: 4096,
        },
      },
    ];

    for (const attempt of endpointAttempts) {
      const startedAt = Date.now();
      try {
        const response = await fetchJsonWithTimeout(attempt.endpoint, attempt.payload, headersFor(route, model));
        const image = await extractGeneratedImage(response);
        attempts.push({
          model,
          role,
          apiKeyEnv,
          endpointKind: attempt.endpointKind,
          status: 'success',
          durationMs: Date.now() - startedAt,
        });
        return {
          model,
          route,
          response,
          selectedRole: role,
          apiKeyEnv,
          usage: usageFromResponse(response),
          attempts,
          endpointKind: attempt.endpointKind,
          image,
        };
      } catch (error) {
        attempts.push({
          model,
          role,
          apiKeyEnv,
          endpointKind: attempt.endpointKind,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throw new ModelRouteError('主模型与备选模型均未生成可用图片。', { route, failures: attempts, attempts }, 502);
}

function sanitizeName(value: string): string {
  const compact = value.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return compact || 'generated';
}

function modelArtifactDir(kind: 'image' | 'vision'): string {
  const dir = runtimePath('model-artifacts', kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function generateImageArtifact(input: ImageGenerationInput): Promise<Record<string, unknown>> {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new ModelRouteError('生图 prompt 不能为空。');
  const route = getResolvedModelRoute('image');
  const request = await callImageGenerationModels(route, input);
  const detected = imageExtension(request.image.buffer);
  if (!detected) {
    throw new ModelRouteError('模型返回内容不是受支持的真实图片格式。', { model: request.model, source: request.image.source }, 502);
  }
  const id = crypto.randomUUID();
  const baseName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeName(input.slotKey || request.model)}-${id.slice(0, 8)}`;
  const outputPath = path.join(modelArtifactDir('image'), `${baseName}${detected.extension}`);
  fs.writeFileSync(outputPath, request.image.buffer);
  const metadataPath = path.join(modelArtifactDir('image'), `${baseName}.json`);
  const stat = fs.statSync(outputPath);
  const metadata = {
    id,
    kind: 'image_generation',
    createdAt: new Date().toISOString(),
    model: request.model,
    route: {
      key: request.route.key,
      provider: request.route.provider,
      sourceKind: request.route.sourceKind,
      source: request.route.source,
    },
    prompt,
    slotKey: input.slotKey || null,
    outputPath,
    sizeBytes: stat.size,
    mime: detected.mime,
    source: request.image.source,
    endpointKind: request.endpointKind,
    selectedRole: request.selectedRole,
    apiKeyEnv: request.apiKeyEnv,
    usage: request.usage,
    attempts: request.attempts,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  return {
    status: 'generated',
    artifact: {
      ...metadata,
      metadataPath,
    },
  };
}

function fileMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function textFromModelResponse(payload: unknown): string {
  const raw = objectValue(payload);
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const first = objectValue(choices[0]);
  const message = objectValue(first.message);
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => {
      const rawItem = objectValue(item);
      return String(rawItem.text || rawItem.content || '').trim();
    }).filter(Boolean).join('\n').trim();
  }
  return String(raw.output_text || raw.text || '').trim();
}

export async function runVisionQualityCheck(input: VisionQaInput): Promise<Record<string, unknown>> {
  const imagePath = path.resolve(String(input.imagePath || '').trim());
  if (!imagePath || !fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
    throw new ModelRouteError('质检图片不存在，无法调用视觉模型。', { imagePath });
  }
  const route = getResolvedModelRoute('vision');
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const prompt = String(input.prompt || '').trim() || DEFAULT_VISION_PROMPT;
  const request = await callModels(route, input.modelId, (model) => ({
    endpoint: endpointFor(route, '/chat/completions'),
    payload: {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${fileMime(imagePath)};base64,${imageBase64}` } },
        ],
      }],
      temperature: 0.2,
      max_tokens: 700,
    },
  }));
  const summary = textFromModelResponse(request.response);
  if (!summary) {
    throw new ModelRouteError('视觉模型没有返回可读质检文本。', { model: request.model }, 502);
  }
  return {
    status: 'completed',
    qa: {
      checkedAt: new Date().toISOString(),
      model: request.model,
      selectedRole: request.selectedRole,
      apiKeyEnv: request.apiKeyEnv,
      usage: request.usage,
      attempts: request.attempts,
      provider: request.route.provider,
      sourceKind: request.route.sourceKind,
      imagePath,
      summary,
      nonBlocking: true,
    },
  };
}
