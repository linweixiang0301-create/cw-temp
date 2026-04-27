# 2026-04-28 任务 — 飞书发送后状态回执优化

## 目标
- 在本地 UI-first PS 自动化控制台中，优化“发送 PNG 成品”后的状态回执。
- 保持现有边界：飞书只发送已回填的 `final.png`，PSD 只保存在本地，不进入发送 payload。

## 计划
- [x] 核对现有飞书发送 payload，确认不包含 PSD。
- [x] 为 `/api/feishu/send-final` 增加结构化发送回执元数据。
- [x] 在 UI 中展示发送中、已发送、发送失败状态。
- [x] 成功回执展示目标、文件名、大小、发送时间。
- [x] 失败回执展示错误原因，并允许用户直接重试。
- [x] 运行类型检查和本地接口预检验证。

## 回顾
- 已确认 `feishuPayload()` 只提交 `imagePath`，不会提交本地 PSD 路径。
- `/api/feishu/send-final` 成功后会返回 `receipt`，包含发送时间、目标、最终 PNG 文件名/大小/投递方式、消息数量和 `psdDelivery: local_only`。
- UI 已改为结构化展示发送前预检、发送中、已发送、发送失败；失败时展示错误原因并提供“重试发送 / 重新预检”。
- 验证结果：
  - `npm run check` 通过。
  - `node --check public/app.js` 通过。
  - 本地服务 `http://127.0.0.1:3498` 已启动。
  - 最近 `final.png` 可读取，路径为 `/Users/a1234/Desktop/飞书Claude/claude-feishu-bridge/.runtime/bridge-state/photoshop-jobs/running/photoshop-be946f18-7e54-497c-9548-483d2ea4c85b/final.png`。
  - 当前未配置飞书目标，发送接口返回 400，预检阶段以 `feishu_target_missing` 阻断；未执行真实飞书发送。

# 2026-04-28 任务 — 飞书目标保存与复用

## 目标
- 让飞书输出区在缺少目标时更可操作。
- 支持把用户手动填写的真实 Chat/User ID 保存为本地最近目标，后续可一键复用。
- 仍然保持发送边界：没有明确目标不发送；只发送 `final.png`，PSD 不发送。

## 计划
- [x] 扩展本地 console state，保存最近飞书目标。
- [x] 新增目标列表、保存、删除 API。
- [x] 在 UI 中加入保存当前目标、复用最近目标、删除目标。
- [x] 运行类型检查、脚本检查和接口验证。

## 回顾
- 已新增本地 `feishuTargets` 状态，保存到运行时 state，不写入仓库。
- `/api/status` 会返回最近飞书目标；新增 `/api/feishu/targets` 列表/保存接口和 `/api/feishu/targets/:id` 删除接口。
- 飞书输出区新增“目标备注”“保存当前目标”“清空目标”“刷新最近目标”和目标卡片；卡片支持使用、载入并预检、删除。
- 保存目标只接受真实格式的 `oc_...` Chat ID 或 `ou_...` User ID；错误输入返回 400。
- 验证结果：
  - `npm run check` 通过。
  - `node --check public/app.js` 通过。
  - `git diff --check` 通过。
  - 本地服务 `/api/status` 与 `/api/feishu/targets` 正常返回。
  - 使用无效目标验证保存接口返回 400；未写入假目标，未发送飞书消息。
  - 远端冷启动克隆到 `a59489fa9e15895a42449447d0ee4a86bc5d9d18`，`npm ci`、`npm run check`、备用端口 `/api/status` 和 `/api/feishu/targets` 均通过。

# 2026-04-28 任务 — 飞书发送就绪门禁

## 目标
- 在飞书输出区明确展示当前是否具备发送条件。
- 缺少飞书目标或 `final.png` 路径时，禁用“发送 PNG 成品”，避免用户误触后才看到阻断。
- 保持真实预检：文件是否存在、大小和投递方式仍由 `/api/feishu/preflight-final` 判定。

## 计划
- [x] 增加发送就绪状态条。
- [x] 根据目标和最终图片路径控制发送按钮。
- [x] 在目标/图片路径变化、回填、载入目标后实时刷新就绪状态。
- [x] 运行类型检查、脚本检查和接口验证。

## 回顾
- 飞书输出区新增 `feishuReadinessStatus`，会展示“发送条件已具备/未齐”和缺失项。
- “发送 PNG 成品”按钮现在由目标和 `final.png` 路径共同控制；缺少任一项会禁用。
- 即使通过脚本绕过按钮，`sendFeishuFinal()` 也会先做本地 `ready_gate` 阻断，不进入发送 API。
- 目标输入、清空目标、载入最近目标、回填最近成品、Photoshop job 状态更新都会刷新就绪状态。
- 验证结果：
  - `npm run check` 通过。
  - `node --check public/app.js` 通过。
  - `git diff --check` 通过。
  - 本地服务可读取新增 `feishuReadinessStatus` 与 `app.js?v=feishu-readiness`。
  - 当前有最近 `final.png`，但无飞书目标，发送预检仍以 `feishu_target_missing` 阻断；未发送飞书消息。
