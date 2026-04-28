# PS Automation Console

本地 UI-first 的 Photoshop 自动化控制台。主链路在本机完成，飞书只作为最终成品输出端口。

## 启动

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:3498
```

启动时会自动读取项目根目录的 `.env.local`。该文件已被 `.gitignore` 排除，只用于本机真实密钥和路径配置。可从示例复制：

```bash
cp .env.example .env.local
```

## 本机配置

控制台不会把本机模板路径、登录态、飞书目标或 token 写入仓库。

如需启动后自动填入本机模板路径，可以复制示例文件：

```bash
cp public/local-defaults.example.json public/local-defaults.json
```

然后把 `public/local-defaults.json` 改成本机真实路径。该文件已被 `.gitignore` 排除。

常用环境变量：

```bash
export PS_AUTOMATION_BRIDGE_ROOT="$HOME/Desktop/飞书Claude/claude-feishu-bridge"
export PS_AUTOMATION_TEMPLATE_ROOTS="$HOME/Desktop"
export PS_AUTOMATION_MANIFEST_ROOTS="$HOME/Desktop,$HOME/Documents"
```

## 运行约定

- design006 操作会按需打开临时 Chrome 窗口。
- Chrome 窗口执行完会自动关闭。
- 登录态保存在持久 profile：`~/.codex/ps-automation/design006-profile`。
- “模板与来源”里的登录态验证分区会真实探测该 profile；未通过前，UI 和后端都会阻断 design006 解析、搜索和下载。
- design006 下载被拆成“下载前预检”和“确认下载”两步；预检只读取真实登录态、详情页和本机收件箱配置，不调用下载确认或 signed_url 接口。
- 默认从 `9232` 起寻找空闲 CDP 端口，避免占用已有 `9231`。
- 不使用 mock 数据；解析、搜索、下载都走真实 design006 链路。
- 下载可能消耗 design006 积分或受会员权限限制，控制台只按真实结果返回，不绕过限制。

## API

- `GET /api/status`
- `GET /api/manifests/discover`
- `GET /api/presets`
- `POST /api/presets`
- `POST /api/presets/compatibility`
- `POST /api/presets/cross-template`
- `POST /api/presets/derive-cross-template`
- `POST /api/design006/resolve`
- `POST /api/design006/search`
- `POST /api/design006/download/preflight`
- `POST /api/design006/download`
- `POST /api/design006/login/check`
- `POST /api/design006/login/open`
- `POST /api/design006/login/close`
- `POST /api/design006/login/continue`
- `POST /api/design006/login/cancel`
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/confirm-final`
- `GET /api/feishu/targets`
- `POST /api/feishu/targets`
- `DELETE /api/feishu/targets/:id`
- `GET /api/feishu/send-history`
- `GET /api/feishu/send-history/export`
- `POST /api/feishu/preflight-final`
- `POST /api/feishu/send-final`
- `GET /api/uploads/images`
- `POST /api/uploads/images`
- `GET /api/psd-rebuild/jobs`
- `POST /api/psd-rebuild/jobs`
- `GET /api/model-routes`
- `POST /api/model-routes`
- `POST /api/model-routes/preflight`
- `POST /api/model-routes/live-probe`
- `GET /api/model-routes/orchestration`
- `GET /api/model-routes/usage-history`
- `POST /api/models/image/generate`
- `POST /api/models/vision/qa`
- `GET /api/regression/feishu-output`
- `GET /api/regression/model-routing`

## 飞书输出

飞书输出使用本机 `lark-cli` 的 bot 身份。

发送时可在 API body 传 `chatId` 或 `userId`，也可以设置：

```bash
export PS_AUTOMATION_FEISHU_CHAT_ID=oc_xxx
export PS_AUTOMATION_FEISHU_USER_ID=ou_xxx
```

发送最终成品时只发送文本摘要和最终 PNG；可编辑 PSD 保存在本机，不默认外发。

控制台可以把手动填写的真实 Chat/User 目标保存为本地最近目标，数据只写入本机运行时 state，不进入仓库。

`/api/feishu/send-final` 在预检通过且未被重复发送保护拦截后，会先对当前 `final.png` 执行 Vision QA，再发送文本摘要和 PNG。QA 使用 vision 路由主备模型；如果模型失败，会记录 `manual_review` 警告但不阻断 PNG 投递。

每次调用发送接口都会写入本地发送历史：成功记录目标、最终 PNG、投递方式、消息数量和发送前 QA 结果；失败记录错误、预检 findings 和已完成的 QA 结果。

## 模型路由

控制台支持 `instruction` / `image` / `vision` 三类模型路由，本机 runtime state 只保存模型名、Base URL、provider 和 API Key 环境变量名，不保存密钥原文。

`instruction` 默认可使用 `codex-login` provider：控制台读取本机 Codex 登录态和模型配置，只返回登录状态、当前模型、provider、刷新时间等非敏感字段，不返回或持久化 token / cookie / 密钥。该 provider 不需要 Base URL 或 API Key Env，也不会在 live probe 阶段请求外部模型 provider。

当前真实 provider 验证过的配置形态：

```text
instruction:
  provider: codex-login
  primary: gpt-5.5
  source: local-codex-login

image:
  baseUrl: https://api.tu-zi.com/v1
  apiKeyEnv: GEMINI_TUZI_API_KEY
  primary: gpt-image-2
  fallback: gemini-3-pro-image-preview-4k

vision:
  baseUrl: https://ai.flashapi.top
  apiKeyEnv: GEMINI_FLASH_API_KEY
  primary: gemini-3-flash-preview
  fallback: gpt-5.5
  modelApiKeyEnvs:
    gpt-5.5: GPT55_FLASH_API_KEY
```

当同一 Base URL 下不同模型由不同 API Key 授权时，可在路由中设置 `modelApiKeyEnvs`，只保存“模型名 -> 环境变量名”，不保存密钥原文。

UI 的“模型专用 Key Env”支持每行一个映射：

```text
gpt-5.5=GPT55_FLASH_API_KEY
```

`/api/model-routes/orchestration` 会基于当前真实路由和 live probe 生成三路协作分析：

- `instruction`：本地控制面，理解用户目标、组织 slot 操作和 prompt。
- `image`：产物面，生成真实本机图片文件，失败回退 `manual_file`。
- `vision`：质检面，检查最终 `final.png`，失败回退 `manual_review` 且不阻断飞书发送。

该分析还会标记模型级 fallback、provider 级故障覆盖、模型专用 Key Env 和主链路非阻断策略。

`/api/models/image/generate` 会先尝试 OpenAI-compatible `/v1/images/generations`。如果真实 provider 的图像模型走 chat 形态，会再尝试 `/v1/chat/completions` 并从返回的 base64 或图片 URL 提取真实图片字节。只有图片魔数校验通过并落盘到 `~/.codex/ps-automation/model-artifacts/image`，才返回 `generated`。

`/api/models/vision/qa` 使用真实 `final.png` 调用视觉模型；失败时返回 `manual_review`，不会阻断 Photoshop job 或飞书最终 PNG 输出链路。

## 智能拆层 / PSD 重建

控制台支持上传真实 JPG / PNG / WEBP 图片到本机 runtime：

- `POST /api/uploads/images`：multipart 上传图片，落盘到 `~/.codex/ps-automation/uploads/images`，返回真实路径、大小、mime、宽高和 sha256。
- `POST /api/psd-rebuild/jobs`：基于上传图片或本机图片路径创建 PSD 重建作业。

PSD 重建作业会优先调用当前 `vision` 路由生成 layer manifest。manifest 明确标注结果是“AI 重建层”，不是原始 PSD 图层恢复。模型失败或返回非结构化文本时，接口只生成真实单图层 fallback manifest 和 Photoshop JSX，不伪造拆层结果。

如果请求体传 `executePhotoshop: true`，服务会尝试用本机 Photoshop 执行生成的 JSX，把上传图片保存成本地 `rebuilt.psd`，并按 vision 识别到的文字候选创建可编辑文本层。Photoshop 不可用或脚本失败时，作业仍保留本地 manifest / JSX / 审计记录，状态回退为人工复核，不影响既有 Photoshop + 飞书主链路。
