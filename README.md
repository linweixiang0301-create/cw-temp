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
- `POST /api/design006/download`
- `POST /api/design006/login/continue`
- `POST /api/design006/login/cancel`
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/confirm-final`
- `GET /api/feishu/targets`
- `POST /api/feishu/targets`
- `DELETE /api/feishu/targets/:id`
- `GET /api/feishu/send-history`
- `POST /api/feishu/preflight-final`
- `POST /api/feishu/send-final`

## 飞书输出

飞书输出使用本机 `lark-cli` 的 bot 身份。

发送时可在 API body 传 `chatId` 或 `userId`，也可以设置：

```bash
export PS_AUTOMATION_FEISHU_CHAT_ID=oc_xxx
export PS_AUTOMATION_FEISHU_USER_ID=ou_xxx
```

发送最终成品时只发送文本摘要和最终 PNG；可编辑 PSD 保存在本机，不默认外发。

控制台可以把手动填写的真实 Chat/User 目标保存为本地最近目标，数据只写入本机运行时 state，不进入仓库。

每次调用发送接口都会写入本地发送历史：成功记录目标、最终 PNG、投递方式和消息数量；失败记录错误与预检 findings。
