import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FEISHU_IMAGE_MESSAGE_MAX_BYTES = 5 * 1024 * 1024;
const FEISHU_FILE_MESSAGE_MAX_BYTES = 20 * 1024 * 1024;

type SendFinalInput = {
  chatId?: string;
  userId?: string;
  text?: string;
  imagePath?: string;
  filePath?: string;
  forceResend?: boolean;
};

type FeishuTarget = {
  args: string[];
  type: 'chat' | 'user';
  value: string;
  source: 'body' | 'env';
};

async function runLarkCli(args: string[], options: { cwd?: string } = {}): Promise<Record<string, unknown>> {
  const { stdout, stderr } = await execFileAsync('lark-cli', args, {
    maxBuffer: 20 * 1024 * 1024,
    cwd: options.cwd,
  });
  const raw = stdout.trim() || stderr.trim();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

function localFileForLarkCli(filePath: string): { arg: string; cwd: string } {
  return {
    arg: `./${path.basename(filePath)}`,
    cwd: path.dirname(filePath),
  };
}

function resolveTarget(input: SendFinalInput): FeishuTarget | null {
  const bodyChatId = String(input.chatId || '').trim();
  const bodyUserId = String(input.userId || '').trim();
  const envChatId = String(process.env.PS_AUTOMATION_FEISHU_CHAT_ID || '').trim();
  const envUserId = String(process.env.PS_AUTOMATION_FEISHU_USER_ID || '').trim();
  if (bodyChatId) return { args: ['--chat-id', bodyChatId], type: 'chat', value: bodyChatId, source: 'body' };
  if (bodyUserId) return { args: ['--user-id', bodyUserId], type: 'user', value: bodyUserId, source: 'body' };
  if (envChatId) return { args: ['--chat-id', envChatId], type: 'chat', value: envChatId, source: 'env' };
  if (envUserId) return { args: ['--user-id', envUserId], type: 'user', value: envUserId, source: 'env' };
  return null;
}

function preflightError(message: string, details: unknown): Error {
  const error = new Error(message) as Error & { statusCode: number; details: unknown };
  error.statusCode = 400;
  error.details = details;
  return error;
}

function targetLooksValid(target: FeishuTarget): boolean {
  if (target.type === 'chat') return /^oc_[A-Za-z0-9_-]+$/.test(target.value);
  return /^ou_[A-Za-z0-9_-]+$/.test(target.value);
}

function messageReceipt(payload: Record<string, unknown>, fallbackType: string): Record<string, unknown> {
  const data = (payload.data || {}) as Record<string, unknown>;
  return {
    messageId: data.message_id ? String(data.message_id) : null,
    type: fallbackType,
    createTime: data.create_time ? String(data.create_time) : null,
    chatId: data.chat_id ? String(data.chat_id) : null,
  };
}

export async function getFeishuStatus(): Promise<Record<string, unknown>> {
  return {
    hasChatTarget: Boolean(process.env.PS_AUTOMATION_FEISHU_CHAT_ID),
    hasUserTarget: Boolean(process.env.PS_AUTOMATION_FEISHU_USER_ID),
    sender: 'lark-cli --as bot',
  };
}

export async function preflightFinalToFeishu(input: SendFinalInput): Promise<Record<string, unknown>> {
  const target = resolveTarget(input);
  const findings: Array<{ code: string; message: string }> = [];
  const artifacts = [
    { key: 'imagePath', label: '最终 PNG', path: String(input.imagePath || '').trim(), required: true },
  ];

  if (!target) {
    findings.push({
      code: 'feishu_target_missing',
      message: '缺少飞书输出目标：请填写 Chat ID/User ID，或设置 PS_AUTOMATION_FEISHU_CHAT_ID / PS_AUTOMATION_FEISHU_USER_ID。',
    });
  } else if (!targetLooksValid(target)) {
    findings.push({
      code: 'feishu_target_format_invalid',
      message: `${target.type === 'chat' ? 'Chat ID' : 'User ID'} 格式不符合预期：${target.value}`,
    });
  }

  for (const artifact of artifacts) {
    if (!artifact.path) {
      if (artifact.required) {
        findings.push({ code: `${artifact.key}_missing`, message: `缺少${artifact.label}路径。` });
      }
      continue;
    }
    if (!fs.existsSync(artifact.path)) {
      findings.push({ code: `${artifact.key}_not_found`, message: `${artifact.label}不存在：${artifact.path}` });
      continue;
    }
    const size = fs.statSync(artifact.path).size;
    if (artifact.key === 'imagePath' && size > FEISHU_FILE_MESSAGE_MAX_BYTES) {
      findings.push({
        code: 'imagePath_too_large_for_png_output',
        message: `${artifact.label}大小为 ${(size / 1024 / 1024).toFixed(1)}MB，超过飞书 PNG 文件发送约 20MB 上限；请先压缩 PNG 后再发送。`,
      });
    }
  }

  return {
    status: findings.length === 0 ? 'ready' : 'blocked',
    target: target ? { type: target.type, value: target.value, source: target.source } : null,
    artifacts: artifacts.map((artifact) => ({
      key: artifact.key,
      path: artifact.path || null,
      fileName: artifact.path ? path.basename(artifact.path) : null,
      exists: artifact.path ? fs.existsSync(artifact.path) : false,
      sizeBytes: artifact.path && fs.existsSync(artifact.path) ? fs.statSync(artifact.path).size : null,
      modifiedAt: artifact.path && fs.existsSync(artifact.path) ? fs.statSync(artifact.path).mtimeMs : null,
      delivery: artifact.path && fs.existsSync(artifact.path)
        ? fs.statSync(artifact.path).size <= FEISHU_IMAGE_MESSAGE_MAX_BYTES ? 'image_message' : 'png_file'
        : null,
      required: artifact.required,
    })),
    findings,
  };
}

export async function sendFinalToFeishu(input: SendFinalInput): Promise<Record<string, unknown>> {
  const preflight = await preflightFinalToFeishu(input);
  if (preflight.status !== 'ready') {
    throw preflightError('飞书发送预检未通过。', preflight);
  }
  const target = resolveTarget(input);
  if (!target) throw preflightError('飞书发送预检未通过。', preflight);
  const sent: unknown[] = [];
  const messages: Record<string, unknown>[] = [];
  const text = String(input.text || 'PS 自动化任务已完成。').trim();
  const textResult = await runLarkCli(['im', '+messages-send', ...target.args, '--text', text, '--as', 'bot']);
  sent.push(textResult);
  messages.push(messageReceipt(textResult, 'text'));

  const imagePath = String(input.imagePath || '').trim();
  let finalImage: Record<string, unknown> | null = null;
  if (imagePath) {
    if (!fs.existsSync(imagePath)) throw new Error(`imagePath 不存在：${imagePath}`);
    const image = localFileForLarkCli(imagePath);
    const size = fs.statSync(imagePath).size;
    const mediaFlag = size <= FEISHU_IMAGE_MESSAGE_MAX_BYTES ? '--image' : '--file';
    const imageResult = await runLarkCli(['im', '+messages-send', ...target.args, mediaFlag, image.arg, '--as', 'bot'], { cwd: image.cwd });
    sent.push(imageResult);
    messages.push(messageReceipt(imageResult, mediaFlag === '--image' ? 'image' : 'file'));
    finalImage = {
      path: imagePath,
      fileName: path.basename(imagePath),
      sizeBytes: size,
      modifiedAt: fs.statSync(imagePath).mtimeMs,
      delivery: mediaFlag === '--image' ? 'image_message' : 'png_file',
    };
  }
  const messageIds = messages.map((message) => String(message.messageId || '').trim()).filter(Boolean);
  return {
    ok: true,
    status: 'sent',
    preflight,
    receipt: {
      sentAt: new Date().toISOString(),
      target: { type: target.type, value: target.value, source: target.source },
      finalImage,
      messageCount: sent.length,
      messageIds,
      messages,
      psdDelivery: 'local_only',
    },
    sent,
  };
}
