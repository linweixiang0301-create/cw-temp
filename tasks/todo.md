# 2026-04-28 任务 — 模型路由接入闭环

## 目标
- 让本地 UI-first PS 自动化控制台支持 instruction / image / vision 三类模型路由的本地配置、预检和 UI 选择。
- 将 image 模型接入真实生图产物生成：只有真实 provider 成功返回并落盘图片，才允许生成 `image.replace.ai` 动作。
- 将 vision 模型接入最终 `final.png` 质检：质检失败或未配置时只返回诊断，不阻断 Photoshop job 与飞书最终 PNG 输出主链路。
- 所有模型失败都回退到当前本地文件/人工路径；不使用 mock 数据，不伪造模型产物，不外发 PSD。

## 计划
- [x] 扩展本地 runtime state，保存非敏感模型路由配置。
- [x] 新增模型路由 API：列表、保存、预检。
- [x] 新增真实 image 生成 API：调用已配置 provider，生成 PNG 落盘，失败返回可人工回退。
- [x] 新增 final.png vision 质检 API：调用已配置 provider 返回诊断，失败不阻断发送链路。
- [x] UI 增加模型路由配置面板和 instruction / image / vision 下拉选择。
- [x] UI 的 AI 图片替换从“手动填生成文件”升级为可触发真实生成，成功后回填本地文件并加入 action。
- [x] Artifact / 飞书工作台增加 final.png 质检入口与结果展示。
- [x] 运行类型检查、脚本检查、真实 API 验证和浏览器 UI 验证。
- [x] 远端冷启动回归并推送 GitHub。

## 回顾
- 已新增本地 `modelRoutes` runtime state，只保存非敏感配置：route key、provider、primary/fallback、Base URL、API Key 环境变量名、来源备注和启用状态；不会保存 token/key 原文。
- 新增 `/api/model-routes`、`/api/model-routes/preflight`、`/api/models/image/generate`、`/api/models/vision/qa`。
- `/api/status` 的 `models` 现在返回合并后的 instruction / image / vision 路由状态、ready 标记和 findings；当前本机没有模型环境变量，也没有常见本地 OpenAI-compatible 端口监听，所以三路均为未配置。
- image 生成已接 OpenAI-compatible `/v1/images/generations`：只有 provider 返回真实图片数据并通过 PNG/JPG/WEBP 魔数检查，才会落盘到 runtime `model-artifacts/image` 并回填路径；未配置或调用失败时返回 `manual_file` 回退，不伪造图片。
- vision 质检已接 OpenAI-compatible `/v1/chat/completions` 视觉输入：对当前真实 `final.png` 调用时因模型未配置返回 `manual_review` 非阻断回退，不影响 Photoshop / 飞书主链路。
- UI 已新增模型路由配置面板、三路模型下拉、AI 图片“生成并回填”、飞书输出区 `final.png` 质检入口。
- 验证结果：
  - `npm run check` 通过。
  - `node --check public/app.js` 通过。
  - `git diff --check` 通过。
  - 本地 `http://127.0.0.1:3498` API smoke 通过：`/api/model-routes` 返回 3 路状态，空主模型保存返回 HTTP 400，image/vision 未配置时均走回退。
  - 当前真实 `final.png` 存在，大小 `1,852,542 bytes`；vision smoke 使用该真实图片验证回退。
  - 飞书发送历史仍为 2 条，未新增飞书消息，未发送 PSD。
  - 浏览器桌面 1440x1200 与移动 390x844 验证通过：模型配置面板可见、final.png 质检入口可见、控制台无 error、无横向溢出。
  - 已推送远端 main：`40d552332558b80c47f7a12ec3e3d26cee5070ef`。
  - 远端冷启动克隆 `/tmp/ps-console-model-cold.NKz5II/repo` 通过：`npm ci`、`npm run check`、`node --check public/app.js`、备用端口 `3602` 的 `/api/status`、`/api/model-routes`、`/api/model-routes/preflight`、image fallback、vision fallback。

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

# 2026-04-28 任务 — 飞书发送历史与审计记录

## 目标
- 记录每次 `/api/feishu/send-final` 的真实发送尝试。
- 成功记录目标、`final.png` 路径、大小、投递方式、消息数量、时间。
- 失败记录预检/发送错误、目标、`final.png` 路径和 findings，方便排查。
- 审计数据只保存在本机运行时 state，不写入仓库。

## 计划
- [x] 扩展本地 console state，增加飞书发送历史。
- [x] 发送成功/失败时写入审计记录。
- [x] 新增发送历史读取 API。
- [x] 在飞书输出区展示最近发送历史。
- [x] 运行类型检查、脚本检查、临时运行时接口验证。

## 回顾
- 已新增本地 `feishuSendHistory` 状态，审计记录只写入运行时 state，不进入仓库。
- `/api/status` 会返回最近发送历史；新增 `/api/feishu/send-history`。
- `/api/feishu/send-final` 成功时记录目标、最终 PNG、大小、投递方式、消息数量和 `psdDelivery: local_only`。
- `/api/feishu/send-final` 失败时记录错误、预检状态、findings、目标和最终 PNG 路径。
- 飞书输出区新增“发送历史”列表和刷新按钮，展示最近 8 条成功/失败记录。
- 验证结果：
  - `npm run check` 通过。
  - `node --check public/app.js` 通过。
  - `git diff --check` 通过。
  - 临时运行时验证缺少飞书目标的失败发送返回 400，并写入 1 条 failed 审计记录，`psdDelivery` 为 `local_only`；未发送飞书消息。
  - 本地服务 `http://127.0.0.1:3498` 已重启到最新代码，`/api/status` 和 `/api/feishu/send-history` 正常。

# 2026-04-28 任务 — 飞书发送审计闭环与复用优化

## 目标
- 使用真实飞书群目标发送当前已回填的 `final.png`，验证发送历史中出现成功审计记录。
- 保持硬边界：只发送最终 PNG 和文本摘要；PSD 只在本地路径展示，不进入发送 payload。
- 补齐 UI 的下阶段操作闭环：一键载入最近目标和最近成品、从发送历史复用目标、在成品回填后提示可发送。

## 计划
- [x] 真实预检当前 `final.png` 与飞书群目标，确认文件存在、大小和投递方式。
- [x] 在 UI 增加“一键准备发送”：载入最近保存目标、回填最近最终 PNG、执行发送前预检。
- [x] 在发送历史卡片增加复用入口，可把历史目标带回当前发送表单。
- [x] 在最近成品状态中展示“可发送/等待目标”等明确提示。
- [x] 真实发送到群聊“飞书codex 分身1️⃣”，只发送文本摘要和最终 PNG。
- [x] 核验 `/api/feishu/send-history`、飞书群消息、UI 可见节点和脚本检查。
- [x] 远端冷启动回归并推送 GitHub。

## 回顾
- 真实群聊目标已保存到本机运行时 state：`飞书codex 分身1️⃣` / `oc_6f5a98333a9b01fd35846e88c85a746d`。
- 发送前预检通过：`final.png` 存在，大小 `1,852,542 bytes`，投递方式 `image_message`，无 findings。
- 已真实发送文本摘要 + 最终 PNG；接口回执 `status=sent`、`messageCount=2`、`psdDelivery=local_only`。
- 飞书群最新消息核验通过：`2026-04-28 02:16` 出现 1 条 text 和 1 条 image，未发送 PSD。
- `/api/feishu/send-history` 最新记录为 `sent`，包含目标、`final.png` 文件名/大小/投递方式、消息数量和 `PSD local_only`。
- UI 已显示最近目标、发送历史、历史复用按钮、`载入最近并发送` 按钮；浏览器控制台无 error。
- `npm run check`、`node --check public/app.js`、`git diff --check` 均通过。
- 已推送实现到远端 main：`18ee54b3d7ac137ae42f0f7f14ba27c24fe94694`；本回顾验收记录随后随任务文档提交同步。
- 远端冷启动克隆通过：`npm ci`、`npm run check`、`node --check public/app.js`、备用端口 `3598` 的 `/api/status` 和 `/api/feishu/send-history` 均正常。
- 本地服务已恢复在 `http://127.0.0.1:3498`，当前运行态保留 1 个真实飞书目标和 1 条 `sent` 发送历史。

# 2026-04-28 任务 — 飞书输出安全与跨模板复用增强

## 目标
- 完成下阶段全部优化：防误发与重复发送保护、最终 PNG 预览、发送历史详情、job 完成可发送工作台、跨模板映射历史复用。
- 保持真实数据原则：所有状态来自真实本地文件、真实发送历史、真实 manifest，不使用 mock。
- 保持外发边界：默认只发送最终 PNG；PSD 只展示本地路径，不外发。

## 计划
- [x] 增加服务端重复发送检测，同一目标 + 同一 `final.png` 已成功发送时默认阻断。
- [x] UI 展示已发送过状态，并提供用户明确触发的“再次发送”入口。
- [x] 在飞书输出区展示当前最终 PNG 预览、文件名、大小、修改时间、session 和投递方式。
- [x] 扩展发送历史审计详情，记录并展示飞书 message ids，支持展开详情和复制审计摘要。
- [x] Job `final_exported` 后自动刷新飞书工作台，提示最近目标、最终 PNG 和可发送状态。
- [x] 为跨模板映射建议支持复用历史 confirmed mapping，减少重复选择。
- [x] 运行类型检查、脚本检查、真实接口验证和浏览器 UI 验证。
- [x] 远端冷启动回归并推送 GitHub。

## 回顾
- `/api/feishu/preflight-final` 现在返回 `fileName`、`sizeBytes`、`modifiedAt`、`delivery` 和 `duplicateSend`。
- `/api/feishu/send-final` 默认拦截同一目标 + 同一 `final.png` 的重复发送，验证返回 HTTP `409`；未向飞书群新增消息，群内最新仍是 `2026-04-28 02:16` 的上一轮 text + image。
- 发送成功回执会记录 `messageIds` 与 `messages`，后续真实发送会在审计详情中展示飞书 message id；旧历史没有该字段时显示 `-`。
- UI 已新增最终 PNG 预览、可发送工作台、重复发送提示、再次发送按钮、发送历史详情、审计摘要复制入口。
- 页面自动回填最近 `final.png`，浏览器验收显示 `final.png` 预览为 `1.8 MB · image_message`，session `photoshop-be946f18-7e54-497c-9548-483d2ea4c85b`，修改时间 `2026/4/28 00:41:33`。
- 跨模板验证仍使用真实 preset / manifest；当前真实派生记录可为 `图2 -> 术前图` 的 image/transform 映射提供历史复用预选。
- `npm run check`、`node --check public/app.js`、`git diff --check` 均通过。
- 已推送远端 main：`a609cf0b8651e936f66ee99435e85b157102397b`。
- 远端冷启动克隆通过：`npm ci`、`npm run check`、`node --check public/app.js`、备用端口 `3599` 的 `/api/status` 与 `/api/feishu/send-history` 正常，新 UI/API 关键节点均可读取。

# 2026-04-28 任务 — 生产化审计与复跑闭环

## 目标
- 把已跑通的 Photoshop -> final.png -> 飞书输出链路升级为可追溯、可复查、可安全复跑的控制台工作台。
- 所有展示和验收必须来自真实本地 job、真实 runtime state、真实文件元数据和真实飞书发送历史，不使用 mock。
- 继续保持外发边界：默认不重复发送，PSD 只展示本地路径，不进入飞书 payload。

- [x] 增加 Job Artifact Center API：汇总 session/jobState、模板、preset/action 线索、final.png、editable.psd、本地文件元数据和关联飞书发送记录。
- [x] 增加发送审计导出 API：可导出 JSON 审计包，包含发送目标、文件、大小、时间、message id、错误和 `psdDelivery=local_only`。
- [x] 增加安全复跑 API：提供“只预检 / 重新生成 final.png / 发送前预检”三个明确动作，默认不触发飞书发送。
- [x] 增加真实回归检查 API：检查服务状态、最近 final.png、图片预览、飞书目标、重复发送、发送历史和 PSD local-only 边界。
- [x] 在 UI 中新增 Artifact Center、审计导出、安全复跑和回归检查面板。
- [x] 运行类型检查、脚本检查、真实 API 验证和浏览器 UI 验证；验证时不执行 `forceResend`，不发送新飞书消息，不更新 lark-cli。
- [x] 远端冷启动回归并推送 GitHub。

## 回顾
- 新增 `/api/jobs/latest-artifact-center`、`/api/jobs/:sessionId/artifact-center`、`/api/jobs/:sessionId/safe-rerun`、`/api/feishu/send-history/export`、`/api/regression/feishu-output`。
- Artifact Center 可从真实 console job history 找到 `photoshop-be946f18-7e54-497c-9548-483d2ea4c85b`，汇总 manifest、original PSD、working PSD、`final.png`、`editable.psd`、normalized actions、候选 preset 和关联发送历史。
- 安全复跑验证只执行了 `preflight` 与 `feishu-preflight`：`feishu-preflight` 命中已有 sent 记录的 duplicate guard；`export-final` 缺少显式 `confirm=export-final` 时返回 HTTP `400`，未触发 Photoshop 复跑。
- 审计导出返回 `count=2`、`sentCount=1`、`failedCount=1`，边界为 `finalPngDelivery=text_summary_plus_final_png`、`psdDelivery=local_only`。
- 回归检查返回 `ready`，真实检查包括最近 final job、final.png 存在且可预览、本地最近飞书目标、duplicate guard、发送历史和 PSD local-only。
- 浏览器验证通过：桌面 1440x1200 与移动 390x844 均显示 Artifact Center，安全预检与回归检查按钮可用，重新生成 final.png 对历史 session 为 disabled，控制台无 error，无横向溢出。
- 验证后 `/api/feishu/send-history` 仍为 2 条：`failed` duplicate guard 审计 + 原始 `sent` 记录，没有新增飞书消息。
- `npm run check`、`node --check public/app.js`、`git diff --check` 均通过。
- 已推送远端 main：`23925dae170bd09d43e19aaf52bf967316daa858`。
- 远端冷启动克隆通过：`npm ci`、`npm run check`、`node --check public/app.js`、关键节点 `rg` 检查、备用端口 `3601` 的 `/api/status`、`/api/jobs/latest-artifact-center`、`/api/feishu/send-history/export`、`/api/regression/feishu-output` 和 `/favicon.ico` smoke 均正常。

# 2026-04-28 任务 — 模型路由运维审计闭环

## 目标
- 优先补齐模型路由真实接入前的运维闭环：配置状态、live provider 连通性、image/vision 调用结果、失败回退都能被追踪。
- 不使用 mock，不伪造模型产物；没有真实 provider 时保持 `manual_file` / `manual_review` 回退。
- 不改变 Photoshop -> final.png -> 飞书输出主链路；不发送 PSD，不触发飞书重复发送。

- [x] 增加模型路由 live probe API，真实请求已配置 provider 的 `/v1/models`，未配置时只返回跳过/阻断原因。
- [x] 增加模型使用审计记录，记录 image 生成与 vision 质检的成功、失败和回退。
- [x] 在 `/api/status` 和独立 API 中暴露模型使用历史，便于 UI 和冷启动验证。
- [x] UI 模型路由面板增加 live probe、使用历史和最近回退展示。
- [x] 增加模型路由回归检查 API，汇总配置、最近调用、回退边界和非阻断策略。
- [x] 运行类型检查、脚本检查、真实 API 验证和浏览器 UI 验证。
- [ ] 远端冷启动回归并推送 GitHub。

## 回顾
- 新增 `/api/model-routes/live-probe`：只对已配置 Base URL 的真实 provider 请求 `/v1/models`；当前本机 3 路模型均未配置，因此 live probe 全部返回 `skipped`，没有伪造连通。
- 新增本地 `modelUsageHistory` 审计，`/api/status` 和 `/api/model-routes/usage-history` 均可读取；审计写入为非阻断，即使写 state 失败也不影响 image/vision API。
- `/api/models/image/generate` 在未配置 image provider 时返回 `fallback.manual_file`，并写入 1 条 `image.generate/fallback` 审计，不生成假图片。
- `/api/models/vision/qa` 使用真实 `final.png` 验证：未配置 vision provider 时返回 `fallback.manual_review` 且 `nonBlocking=true`，并写入 1 条 `vision.qa/fallback` 审计。
- 新增 `/api/regression/model-routing`，当前返回 `ready`；provider live probe 为 `warning`，原因是没有可 live probe 的真实 provider；fallback 策略和 usage audit 均通过。
- UI 模型路由面板新增“连通性检查”“模型回归”和“模型使用记录”，桌面 1440x1200 与移动 390x844 Playwright 验证通过，控制台无 error、无横向溢出。
- `npm run check`、`node --check public/app.js`、`git diff --check` 均通过。
- 飞书发送历史仍为 2 条（1 sent / 1 failed duplicate guard），本轮未新增飞书消息，未发送 PSD。
