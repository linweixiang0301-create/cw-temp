# 2026-04-28 任务 — 智能拆层 / PSD 重建 MVP 与图片上传

## 目标
- 在 PS 自动化控制台新增“智能拆层 / PSD 重建”分区。
- 新增真实图片上传接口，接受本机上传的 JPG / PNG / WEBP，落盘到本地 runtime，不使用 mock 数据。
- 基于真实上传图片生成可审计的 layer manifest：优先走 vision 模型分析；失败时只返回真实单图层/人工复核路径，不伪造拆层。
- 第一版 PSD 重建以本地可追踪资产为核心：保存原图、manifest、作业记录，并明确“AI 重建层，不是原始 PSD 图层”。
- 不改变现有 design006 -> manifest -> slot 操作 -> Photoshop job -> final.png -> 飞书只发 PNG 主链路。

## 计划
- [x] 梳理现有上传、模型路由、Photoshop job、前端分区结构。
- [x] 新增 `/api/uploads/images`，解析真实 multipart 上传，记录路径、大小、mime、宽高、sha256。
- [x] 新增上传历史状态，`/api/status` 返回最近上传和 PSD 重建作业。
- [x] 新增 `/api/psd-rebuild/jobs`，对上传图片做 vision layer analysis 并生成本地 manifest / 作业记录。
- [x] UI 新增“智能拆层 / PSD 重建”分区：上传、作业执行、manifest 预览、结果路径。
- [x] 更新 README / 回顾，运行类型检查、前端语法检查、API 真实上传验证和密钥扫描。

## 验证计划
- `npm run check`
- `node --check public/app.js`
- `git diff --check`
- 用真实本地 PNG 调用 `/api/uploads/images`，确认落盘文件存在、sha256/大小/宽高正确。
- 用上传结果调用 `/api/psd-rebuild/jobs`，确认输出真实作业记录；vision 失败时返回 non-blocking fallback，不生成假拆层。
- 检查 `/api/status` 能返回最近上传与重建历史。
- 扫描仓库与 API 响应，确认没有写入 token/cookie/key 明文。

## 回顾
- 新增真实上传服务：
  - `POST /api/uploads/images` 接受 multipart `jpg/png/webp`，落盘到 `~/.codex/ps-automation/uploads/images/YYYY-MM-DD`。
  - 返回并记录真实 `storedPath`、`metadataPath`、`mime`、`extension`、`sizeBytes`、`sha256`、`width`、`height`。
  - `GET /api/uploads/images` 和 `/api/status` 返回最近上传记录。
- 新增智能拆层 / PSD 重建作业：
  - `POST /api/psd-rebuild/jobs` 支持 `uploadId` 或本机 `imagePath`。
  - 优先调用当前 `vision` 路由执行 layer analysis。
  - 生成本地 `layer-manifest.json`、`rebuild.jsx`、预期 `rebuilt.psd` 路径和作业审计。
  - manifest 明确标注 `originalPsdRecovery=false`：这是 AI 重建层，不是原始 PSD 图层恢复。
  - `executePhotoshop=true` 时才尝试本机 Photoshop 导出 PSD；默认验证路径不会自动执行 Photoshop。
- UI：
  - 主工作区新增“智能拆层 / PSD 重建”分区。
  - 支持图片上传、最近上传选择、本机图片路径、Vision 模型选择、是否尝试 Photoshop 导出 PSD。
  - 结果区展示上传回执、layer manifest 预览、Photoshop JSX、本地 PSD 路径和 fallback findings。
- 真实验证：
  - 服务已重启到最新代码：`http://127.0.0.1:3498`，PID `3098`。
  - 用真实本机 PNG 上传成功：
    - upload id：`6165414e-3c52-4475-9434-91c006b9e0b3`
    - 大小：`133 B`
    - 尺寸：`64 x 64`
    - sha256：`298d73828554e89212cfe178f17dffd7ac9598ca69288a7bada965f4b4e2c69f`
  - 用该上传创建 PSD 重建作业：
    - job id：`73d111b5-93b4-463a-89b1-1ca2641f2fa0`
    - status：`fallback`
    - manifest：`/Users/a1234/.codex/ps-automation/psd-rebuild/73d111b5-93b4-463a-89b1-1ca2641f2fa0/layer-manifest.json`
    - Photoshop JSX：`/Users/a1234/.codex/ps-automation/psd-rebuild/73d111b5-93b4-463a-89b1-1ca2641f2fa0/rebuild.jsx`
    - `originalPsdRecovery=false`，`layerCount=1`，未伪造拆层。
  - Vision route live probe 仍为 ready；真实 layer analysis 调用中，主模型 `gemini-3-flash-preview` 和备选 `gpt-5.5` 均返回 HTTP 400，因此按设计写入 `single_raster_manifest` fallback 和模型使用审计。
  - `/api/status` 返回上传记录 `1` 条、PSD 重建记录 `2` 条，响应未包含 token/key 明文。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - `/api/uploads/images`
  - `/api/psd-rebuild/jobs`
  - `/api/status`
  - `/api/model-routes/live-probe`
  - `git grep` 扫描 tracked files 未发现 `sk-...` 明文。

# 2026-04-28 任务 — 模型三路协作关系分析与 UI 优化

## 目标
- 在模型路由区明确展示三类模型的协作关系：
  - instruction：本地 Codex 登录态，负责指令理解与工作流控制。
  - image：真实 provider 生图，负责图片槽位素材生成并落本地文件。
  - vision：真实 provider 质检，负责最终 PNG 发送前 QA，失败不阻断主链路。
- 新增系统级健康判断：不只看单路 ready，还判断接力链路、fallback 覆盖、凭据隔离和安全边界。
- 优化 UI 上模型专用 Key 的展示，避免长 env 名挤在一行看不清。
- 不改变当前已筛选的真实模型优选：
  - image：`gpt-image-2` 优选，`gemini-3-pro-image-preview-4k` 备选。
  - vision：`gemini-3-flash-preview` 优选，`gpt-5.5` 备选。

## 计划
- [x] 后端新增模型协作分析函数，输出 stages、handoffs、checks、recommendations。
- [x] 新增 `/api/model-routes/orchestration`，复用真实路由状态与 live probe，不使用 mock。
- [x] UI 新增“模型协作”面板，展示三路接力、健康检查和优化建议。
- [x] 优化模型专用 Key Env 的卡片展示。
- [x] 更新 README / 任务回顾，运行类型检查、前端语法检查、真实 API 验证和密钥扫描。

## 验证计划
- `npm run check`
- `node --check public/app.js`
- `git diff --check`
- 真实调用 `/api/model-routes/orchestration`，确认三路 route 和 live probe 都来自当前真实配置。
- 真实调用 `/api/model-routes/live-probe`，确认 instruction 使用本地 Codex，image/vision 命中真实 provider。
- 扫描仓库与 API 响应，确认没有写入或返回 token/key 明文。

## 回顾
- 已新增 `/api/model-routes/orchestration`：
  - 输出 `stages`：instruction / image / vision 各自角色、输入、输出、fallback 模式、阻断策略和安全边界。
  - 输出 `handoffs`：指令到生图、生图到 Photoshop、Photoshop 到质检、质检到飞书。
  - 输出 `checks`：本地控制面、真实生图 ready、真实质检 ready、模型级 fallback、provider 级故障边界、模型专用 Key Env、主链路非阻断策略。
  - 输出 `recommendations`：当前配置可运行，但 image / vision 的主备仍在各自同一 Base URL 下；这是模型级 fallback，不是 provider 级 fallback，后续如追求更高可用性再补跨 provider 备援。
- UI：
  - 模型路由区新增“模型协作”面板，自动展示三路接力关系、健康检查和优化建议。
  - 本地配置区新增“协作分析”按钮。
  - 模型专用 Key Env 改为独立小卡展示，避免长环境变量名贴在一行难读。
- 当前真实协作分析结果：
  - 总状态：`warning`
  - 原因：链路可运行，三路均 ready；仅提示 provider 级冗余尚未覆盖。
  - instruction：`codex-login` / `gpt-5.5` / `local-codex-login` / `ready`
  - image：`gpt-image-2` -> `gemini-3-pro-image-preview-4k` / `https://api.tu-zi.com/v1` / `ready`
  - vision：`gemini-3-flash-preview` -> `gpt-5.5` / `https://ai.flashapi.top` / `ready`
  - `credential_boundary=ready`，vision 备选 `gpt-5.5` 使用模型专用 Key Env：`GPT55_FLASH_API_KEY`。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - `/api/model-routes/orchestration`
  - `/api/model-routes/live-probe`
  - `/api/regression/model-routing`
  - API 响应未包含 `access_token`、`refresh_token`、`id_token`、`Bearer` 或 `sk-` 明文。
- 已推送远端 main：
  - `1cd3d0df63f7d41ffb2a18b97af40f029087103b` — `Add model orchestration analysis`
- 远端 fresh clone 回归：
  - clone HEAD：`1cd3d0df63f7d41ffb2a18b97af40f029087103b`
  - `npm ci` 通过
  - `npm run check` 通过
  - `node --check public/app.js` 通过
  - 空 `CODEX_HOME` / 空 runtime 下，`getModelRouteOrchestration()` 返回真实 blocked 状态，不伪造登录态或 provider ready；仍输出 3 个 stages、4 个 handoffs 和完整 checks。

# 2026-04-28 任务 — 指令解析模型接入本地 Codex 登录态

## 目标
- “模型路由”里的指令解析模型使用本机 Codex 登录态，而不是要求手填 Base URL/API Key。
- 只读取 `~/.codex/auth.json` / `~/.codex/config.toml` 的非敏感状态：是否登录、当前 Codex 模型、provider、刷新时间；不读取、不展示、不写入 token。
- UI 支持选择 `codex-login` provider，并在路由卡片展示本地 Codex 登录态预检结果。
- 保持 image / vision 真实 provider、fallback 和 PS + 飞书主链路不受影响。

## 计划
- [x] 扩展模型路由 provider：新增 `codex-login`，仅允许用于 `instruction`。
- [x] 新增本地 Codex 登录态检测与自动指令路由默认值。
- [x] 更新 UI 配置表单和路由卡片，展示 Codex 登录态并隐藏不适用的 Base URL/API Key 要求。
- [x] 更新 README，运行类型检查、前端语法检查、真实 API 预检和密钥扫描。

## 验证计划
- `npm run check`
- `node --check public/app.js`
- `git diff --check`
- 真实调用 `/api/model-routes`，确认 instruction route 为 `codex-login` 且不返回 token/key。
- 真实调用 `/api/model-routes/live-probe`，确认 instruction 本地登录态 probe 不请求外部 provider。
- `rg` 扫描确认没有写入 `sk-...`、access token 或 refresh token 明文。

## 回顾
- 新增 `codex-login` provider：
  - 只允许保存到 `instruction` 路由；尝试给 image 保存 `codex-login` 会返回 HTTP 400。
  - `instruction` 未显式保存远程 provider 时，会读取本机 Codex 状态作为默认来源。
  - 只读取并返回非敏感信息：登录状态、`auth_mode`、Codex config 模型、model provider、刷新时间是否存在、auth/config 路径和诊断；不返回 token 值。
- 当前本机真实结果：
  - `/api/model-routes`：`instruction` 为 `provider=codex-login`，`primary=gpt-5.5`，`ready=true`。
  - Codex 登录态：`status=logged_in`，`authMode=chatgpt`，`configProvider=openai`。
  - `/api/model-routes/live-probe`：instruction 使用 `endpoint=local-codex-login`，`matchedModels=["gpt-5.5"]`，不会请求外部 provider。
  - image 保持 `gpt-image-2` + `gemini-3-pro-image-preview-4k`，live probe 命中真实 provider。
  - vision 保持 `gemini-3-flash-preview` + `gpt-5.5`，live probe 命中真实 provider。
- 已通过现有保存 API 固化本机 runtime 配置：
  - `instruction / codex-login / gpt-5.5 / local-codex-login`
  - 本机 `console-state.json` 只保存 provider、模型名和 source，`baseUrl=null`，`apiKeyEnv=null`，未写入密钥。
- 空 `CODEX_HOME` 演练：
  - instruction 未配置时保持 skipped，不会伪造登录态或模型调用。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - `/api/status`
  - `/api/model-routes`
  - `/api/model-routes/live-probe`
  - `/api/regression/model-routing`
  - API 响应和本机 runtime state 均未包含 `access_token`、`refresh_token`、`id_token`、`Bearer` 或 `sk-` 明文。
- 已推送远端 main：
  - `3421306b519040799b56e8bfa1d56e47eb474dfb` — `Add Codex login instruction route`
- 远端 fresh clone 回归：
  - clone HEAD：`3421306b519040799b56e8bfa1d56e47eb474dfb`
  - `npm ci` 通过
  - `npm run check` 通过
  - `node --check public/app.js` 通过
  - 空 `CODEX_HOME` / 空 runtime 不会伪造 Codex 登录态；instruction 保持未配置并返回 `model_missing`。

# 2026-04-28 任务 — design006 下载前预检与确认闸门

## 目标
- 在“模板与来源”里新增 design006 下载前真实预检分区。
- 预检只读取真实登录态、真实详情页和本地收件箱配置；不调用下载确认或 signed_url 接口，避免预检阶段消耗积分/会员权益。
- `/api/design006/download` 必须携带最近一次通过的预检 ID 和显式确认值，否则后端阻断。
- UI 先预检、展示目标模板/大小/收件箱/权益风险，再由用户确认后才执行下载。

## 计划
- [x] 扩展 `Design006BrowserManager`，新增下载预检记录、过期校验和下载确认校验。
- [x] 新增 `/api/design006/download/preflight`，返回真实 blocked/ready 检查项和确认令牌。
- [x] 更新 UI：添加“下载前预检”和“确认下载”两步按钮，展示预检回执。
- [x] 更新 README 与任务回顾，运行类型检查、前端语法检查和真实未登录阻断回归。

## 验证计划
- `npm run check`
- `node --check public/app.js`
- `git diff --check`
- 真实调用 `/api/design006/download/preflight`；未登录时应返回 `status=blocked`，已登录时可返回 `ready`，两种情况下预检本身都不执行下载。
- 真实调用 `/api/design006/download` 不带预检确认，应被后端阻断。
- 仓库密钥扫描确认没有写入 token/cookie/密钥。

## 回顾
- 后端新增 `preflightDownload()`：
  - 先真实检查 design006 持久 profile 登录态。
  - 登录通过后才解析真实详情页 candidate。
  - 读取真实 Photoshop templateRoots，返回本机收件箱根目录。
  - 预检阶段不调用 `confirm_download`、`download_api` 或 `signed_url`。
- `/api/design006/download` 新增硬确认：
  - 必须携带最近一次 ready 预检 ID。
  - 必须携带显式确认值 `download-design006-source`。
  - 预检过期、URL 不一致、预检 blocked、缺少确认都会阻断。
- UI：
  - 新增常驻 “Download Preflight” 状态卡。
  - 下载入口拆成“下载前预检”和“确认下载到 PSD 收件箱”。
  - 未通过登录态或未通过 ready 预检时，确认下载按钮禁用。
  - 确认下载前还有浏览器确认框，提示可能消耗积分/会员权益，PSD/PSB 只保存本机。
- 真实验证：
  - 服务已重启到 `http://127.0.0.1:3498` 最新代码，screen `71311.ps-automation-console-3498`，PID `71385`。
  - 未登录检测曾返回 `preflight.status=blocked`，checks 包含 `login_status:blocked` 与 `candidate_resolved:blocked`，没有执行下载动作。
  - 当前真实 profile 后续检测为 `logged_in`，`/api/design006/download/preflight` 返回 `ready`，真实解析到 `https://www.design006.com/detail-99213334643` 的 candidate：`对比图标准格式医美对比图疗程对比`。
  - 未携带预检 ID 直接调用 `/api/design006/download` 返回 HTTP `409` 阻断。
  - 携带 ready 预检 ID 但确认值错误时，仍返回 HTTP `409` 阻断。
  - 未发送飞书消息，未外发 PSD，未执行正确确认值下载。
  - 下载记录数量保持 5，最新下载仍是 `2026-04-27T00:54:47.048Z` 的历史记录，说明本轮没有新增下载记录。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - 仓库密钥扫描无 `sk-...` 明文
- 已推送远端 main：
  - `f7fc29323196a656e2e6e0220b5331d7ba029310` — `Add design006 download preflight gate`
- 远端 fresh clone 回归：
  - clone HEAD：`f7fc29323196a656e2e6e0220b5331d7ba029310`
  - `npm ci` 通过
  - `npm run check` 通过
  - `node --check public/app.js` 通过
  - 仓库密钥扫描无 `sk-...` 明文
  - 空 runtime、备用端口 `3631` 的 `/api/status` 正常，downloads 为 `0`，design006 `downloadPreflight=null`

# 2026-04-28 任务 — design006 登录态验证分区与下载前闸门

## 目标
- 参考抖音自动化 UI，在 PS 控制台“模板与来源”里新增 design006 登录态验证分区。
- UI 未确认登录态前，禁用 design006 URL 解析、搜索和下载入口。
- 后端在真实解析 / 搜索 / 下载前再次探测持久 profile 登录态，未登录时直接阻断，不执行下载指令。
- 登录态检测使用真实 design006 持久 Chrome profile，不使用 mock，不保存账号、cookie 或 token。

## 计划
- [x] 梳理当前 design006 临时浏览器、登录挂起和来源 UI 结构。
- [x] 新增 design006 登录态检测 / 打开登录窗口 / 关闭登录窗口 API。
- [x] 在 resolve/search/download 后端入口前加登录态硬闸门。
- [x] UI 新增登录态验证分区，展示状态、检测时间、profile、窗口端口和操作按钮。
- [x] UI 在登录未通过时锁住“解析 URL / 下载到 PSD 收件箱”，并给出清晰阻断状态。
- [x] 更新 README 与任务回顾，运行检查和真实 API smoke。

## 验证计划
- `npm run check`
- `node --check public/app.js`
- `git diff --check`
- 真实调用 `/api/design006/login/check`，确认返回当前 profile 的真实 logged_in / not_logged_in / unknown。
- 如当前未登录，真实调用 `/api/design006/resolve` 应在下载/解析前阻断；如当前已登录，应允许继续解析。

## 回顾
- 新增 `Design006BrowserManager` 登录态状态：
  - `loginCheck`：最近一次真实检测状态、时间、profile、端口、summary、findings。
  - `loginWindow`：由 UI 手动打开的 design006 专用 Chrome 登录窗口。
  - 检测使用真实持久 profile `~/.codex/ps-automation/design006-profile`，不保存账号、cookie、token。
- 新增 API：
  - `POST /api/design006/login/check`
  - `POST /api/design006/login/open`
  - `POST /api/design006/login/close`
- 后端硬闸门：
  - `/api/design006/resolve`
  - `/api/design006/search`
  - `/api/design006/download`
  - 三者都会先真实探测登录态；非 `logged_in` 时直接阻断，不执行解析/搜索/下载主体动作。
- UI：
  - “模板与来源”新增 design006 登录态验证分区。
  - 展示 Profile Status、Checked At、profile 路径、检测/登录窗口端口。
  - 未通过登录态检测时禁用“解析 URL”和“下载到 PSD 收件箱”。
  - 提供“检查登录态 / 打开登录窗口 / 关闭登录窗口”三个真实操作按钮。
- README 已补充登录态分区和新 API。
- 真实验证：
  - 当前主服务 `http://127.0.0.1:3498` 已重启到最新代码。
  - 当前真实 design006 profile 检测结果：`not_logged_in`。
  - 主服务调用 `/api/design006/resolve` 返回 HTTP 500 阻断：`解析 design006 URL 已阻断...未登录...`，没有继续返回 candidate。
  - 隔离空 profile 服务 `3620` 验证同样返回 `not_logged_in`，解析 URL 被阻断。
  - `login/open` 真实打开 design006 专用登录窗口，`login/close` 真实关闭，端口 `9232`。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - 仓库密钥扫描无 `sk-...` 明文
- 已推送远端 main：
  - 实现：`8c08b6ef40e8a45f16a0e13501fafe89f4c455d7` — `Add design006 login gate`
  - 记录：`62769dc` — `Record design006 login gate validation`
- 远端 fresh clone 回归：
  - `npm ci` 通过
  - `npm run check` 通过
  - `node --check public/app.js` 通过
  - 仓库密钥扫描无 `sk-...` 明文

# 2026-04-28 任务 — 发送前 Vision QA 门禁与发送审计串联

## 目标
- `/api/feishu/send-final` 在真实发送 `final.png` 前自动执行 Vision QA。
- Vision QA 使用现有 vision 路由：优选 `gemini-3-flash-preview`，失败自动 fallback 到 `gpt-5.5`。
- QA 成功或失败都不阻断飞书发送主链路；两个模型都失败时记录 `manual_review` 警告。
- 发送回执和发送历史记录 QA 状态、命中模型、耗时和摘要预览。
- 继续保证：只发送 `final.png`，PSD 仅本地保存，不外发，不记录密钥。

## 计划
- [x] 确认现有发送、QA、发送历史数据结构，复用已有审计能力。
- [x] 扩展 `FeishuSendRecord`，为发送记录增加 `qualityGate` 元数据。
- [x] 在 `/api/feishu/send-final` 预检通过且未命中重复发送拦截后，执行发送前 Vision QA。
- [x] QA 成功/失败均写入 model usage 审计和飞书发送历史；失败走 `manual_review` 且非阻断。
- [x] UI 发送回执、失败回执、发送历史详情展示 QA 结果。
- [x] 运行类型检查、前端语法检查、API 回归与密钥扫描。

## 回顾
- 已在 `FeishuSendRecord` 中新增 `qualityGate`：
  - status：`completed` / `fallback` / `skipped`
  - model、selectedRole、apiKeyEnv、routePrimary、routeFallback、durationMs
  - imagePath、summaryPreview、usage、fallback、nonBlocking
  - 只记录环境变量名，不记录密钥值。
- `/api/feishu/send-final` 新流程：
  - 先执行真实发送预检。
  - 命中 duplicate guard 时仍默认阻断，不执行 QA，不新增飞书消息。
  - 预检 ready 且未被重复发送拦截时，先调用 `runVisionQualityCheck()`。
  - QA 成功写入 model usage 审计，并随发送 payload / receipt / 发送历史返回。
  - QA 失败写入 `manual_review` fallback 审计，但不阻断后续 PNG 投递。
- UI 已展示 QA 结果：
  - 发送成功回执显示 Vision QA 命中模型、角色、耗时、主备路由和摘要预览。
  - 发送失败回执会显示已完成的 QA 结果或 manual review 警告。
  - 发送历史卡片、详情和“复制审计摘要”都包含 QA 信息。
- README 已补充：
  - `/api/feishu/send-history/export`
  - `/api/regression/feishu-output`
  - send-final 发送前 Vision QA 非阻断策略。
- 真实验证：
  - 本地服务已运行在 `http://127.0.0.1:3498`。
  - 使用当前真实 `final.png` 调用 `/api/models/vision/qa` 成功。
  - 命中模型：`gemini-3-flash-preview`
  - 命中角色：`primary`
  - 耗时约 `14.9s`
  - 最新 usage 审计：`vision.qa completed`，`apiKeyEnv=GEMINI_FLASH_API_KEY`，`total_tokens=1818`
- 发送前真实预检：
  - 当前目标 `chat:oc_6f5a98333a9b01fd35846e88c85a746d`
  - 当前 `final.png` 大小 `1,852,542 bytes`
  - 投递方式 `image_message`
  - 已命中 duplicate guard，因此本轮未再次发送飞书消息。
- 隔离冷启动回归：
  - 临时 runtime + 空 provider/env + 备用端口 `3612`
  - vision ready 为 `false`
  - `/api/models/vision/qa` 返回 `fallback.manual_review`
  - `nonBlocking=true`
  - `/api/regression/model-routing` 返回 `ready`
- 远端 fresh clone 冷启动回归：
  - fresh clone HEAD：`543c306281687b61c0262d34b3d6d6137c98a30b`
  - `npm ci` 通过
  - `npm run check` 通过
  - `node --check public/app.js` 通过
  - 仓库密钥扫描无 `sk-...` 明文
  - 无 `.env.local`、空 provider/env、备用端口 `3613`：
    - `/api/status` 正常
    - image ready 为 `false`
    - vision ready 为 `false`
    - `/api/regression/model-routing` 返回 `ready`
    - `/api/feishu/send-history` 返回空历史
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - `/api/regression/feishu-output` 返回 `ready`
  - `/api/regression/model-routing` 返回 `ready`
  - `/app.js` 与 `/styles.css` 均包含 `qualityGate` / `quality-gate-card` 新 UI 节点
  - 仓库密钥扫描无 `sk-...` 明文
- 本轮未执行飞书外发，未外发 PSD。

# 2026-04-28 任务 — 模型审计增强与冷启动回归

## 目标
- 模型使用审计补充主备命中、使用的 `apiKeyEnv`、provider usage、fallback 尝试链路。
- UI 模型使用记录展示新增审计字段，方便判断成本、稳定性和是否命中 fallback。
- 完成无 `.env.local` 与有 `.env.local` 两种冷启动回归，证明无密钥不崩、有密钥主备 ready。

## 计划
- [x] 扩展模型调用返回值，携带 attempts、selectedRole、apiKeyEnv、usage。
- [x] 扩展本地 `ModelUsageRecord`，保存 audit 元数据但不保存密钥。
- [x] 更新 image / vision 成功和 fallback 审计写入。
- [x] UI 模型使用记录显示 primary/fallback、apiKeyEnv、token usage 和尝试链路摘要。
- [x] 用真实 `final.png` 跑一次 vision fallback 演练，确认审计字段落地。
- [x] 做无 `.env.local` 与有 `.env.local` 冷启动回归。
- [x] 运行检查、记录回顾并推送远端。

## 回顾
- 已扩展模型调用内部返回：
  - `selectedRole`：`primary` / `fallback` / `requested`
  - `apiKeyEnv`：本次实际使用的环境变量名
  - `usage`：provider 返回的 token usage
  - `attempts`：每次尝试的模型、角色、env 名、endpointKind、状态、耗时和错误摘要
- `ModelUsageRecord` 新增 `audit` 字段；只记录环境变量名和调用元数据，不记录密钥。
- image / vision 成功记录和 fallback 记录都会写入 `audit`。
- UI 模型使用记录已显示：
  - 命中角色与 key env
  - 主备模型
  - token usage
  - 尝试链路摘要
- 真实审计验证：
  - 临时把 vision 主模型改为 `gemini-3-flash-preview-audit-rehearsal-unavailable`，备选保持 `gpt-5.5`。
  - 使用当前真实 `final.png` 调用 `/api/models/vision/qa`。
  - API 返回 `completed`，实际命中 `gpt-5.5`，耗时约 `16.3s`。
  - 最新 usage 记录 audit：
    - selectedRole：`fallback`
    - apiKeyEnv：`GPT55_FLASH_API_KEY`
    - usage：`prompt_tokens=3085`、`completion_tokens=404`、`total_tokens=3489`
    - attempts：主模型 HTTP 403 失败，备选 `gpt-5.5` 成功
  - 演练后已恢复生产 vision 路由：`gemini-3-flash-preview` + `gpt-5.5`。
- 冷启动回归：
  - 无 `.env.local`、无 provider env、全新 runtime：
    - image 未配置但 `/api/models/image/generate` 返回 `fallback.manual_file`
    - vision 未配置但 `/api/models/vision/qa` 返回 `fallback.manual_review`
    - 没有崩溃，没有生成假文件
  - 有 `.env.local`、全新 runtime：
    - image ready：`gpt-image-2` + `gemini-3-pro-image-preview-4k`
    - vision ready：`gemini-3-flash-preview` + `gpt-5.5`
    - live probe matched image 两个模型和 vision 两个模型
- 为了支持全新 runtime，`.env.local` / `.env.example` 已加入默认模型路由 env：
  - `PS_AUTOMATION_IMAGE_MODEL`
  - `PS_AUTOMATION_IMAGE_FALLBACK_MODEL`
  - `PS_AUTOMATION_IMAGE_BASE_URL`
  - `PS_AUTOMATION_IMAGE_API_KEY_ENV`
  - `PS_AUTOMATION_VISION_MODEL`
  - `PS_AUTOMATION_VISION_FALLBACK_MODEL`
  - `PS_AUTOMATION_VISION_BASE_URL`
  - `PS_AUTOMATION_VISION_API_KEY_ENV`
  - `PS_AUTOMATION_VISION_MODEL_API_KEY_ENVS`
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - 仓库密钥扫描无 `sk-...` 明文
- 远端冷启动回归：
  - fresh clone HEAD：`a29c6b9a9f450115cbb29e2e4ce9eac6a4e875f5`
  - `npm ci` 通过
  - `npm run check` 通过
  - `node --check public/app.js` 通过
  - 仓库密钥扫描无 `sk-...` 明文
  - 无 `.env.local`、无 provider env、全新 runtime：image/vision 均未配置，但 API fallback 正常；image 返回 `manual_file`，vision 返回 `manual_review`
- 本轮未发送飞书消息，未外发 PSD。

# 2026-04-28 任务 — vision 双凭据生产化闭环 1-3 项

## 目标
- 补齐本地 `.env.local` 密钥启动闭环：服务启动时自动读取本机密钥文件，仓库只保留 `.env.example`。
- UI 支持编辑模型专用 Key Env，便于维护 `gpt-5.5 -> GPT55_FLASH_API_KEY` 这类同端口不同凭据配置。
- 真实演练 vision 主备 fallback：主模型不可用时自动落到 `gpt-5.5`，失败仍非阻断，不影响 PS + 飞书主链路。

## 计划
- [x] 实现 `.env.local` 自动加载，兼容 `KEY=value`、`export KEY=value` 和引号。
- [x] 新增 `.env.example`，列出真实需要的环境变量名但不包含密钥。
- [x] UI 模型路由配置新增 `modelApiKeyEnvs` 可编辑输入，保存时解析为模型名到环境变量名。
- [x] 更新 README 启动和模型路由说明。
- [x] 写入本机 `.env.local` 所需真实密钥，确认文件被 gitignore 排除。
- [x] 重启服务，验证从 `.env.local` 加载后主备 live probe ready。
- [x] 临时模拟主模型不可用，真实调用 vision QA，确认自动 fallback 到 `gpt-5.5`；随后恢复生产路由。
- [x] 运行检查、记录回顾并推送远端。

## 回顾
- 新增本地 `.env.local` 自动加载：
  - 启动时由 `src/config.ts` 最早调用 `loadEnvFile(APP_ROOT/.env.local)`。
  - 支持 `KEY=value`、`export KEY=value`、单双引号和行尾注释。
  - 不覆盖已存在的进程环境变量。
- 新增 `.env.example`，只列出变量名和空值，不包含任何密钥：
  - `GEMINI_TUZI_API_KEY`
  - `GEMINI_FLASH_API_KEY`
  - `GPT55_FLASH_API_KEY`
  - 飞书目标和本机路径变量。
- 已写入本机 `.env.local`：
  - 包含真实 `GEMINI_TUZI_API_KEY`、`GEMINI_FLASH_API_KEY`、`GPT55_FLASH_API_KEY`。
  - `git check-ignore .env.local` 确认被忽略。
  - 仓库扫描未发现 `sk-...` 明文。
- UI 模型路由配置已新增“模型专用 Key Env”输入：
  - 每行格式：`model=ENV_NAME`
  - 当前用于 `gpt-5.5=GPT55_FLASH_API_KEY`
  - 保存时解析为 `modelApiKeyEnvs`，仍只保存环境变量名，不保存密钥。
- README 已补充 `.env.local` 启动说明、`.env.example` 复制方式和 UI 编辑格式。
- 使用去掉进程里 3 个 provider key 的干净环境重启服务，验证 `.env.local` 自动加载成功：
  - image route ready：`gpt-image-2` + `gemini-3-pro-image-preview-4k`
  - vision route ready：`gemini-3-flash-preview` + `gpt-5.5`
- 真实 live probe：
  - image matched：`gpt-image-2`、`gemini-3-pro-image-preview-4k`
  - vision matched：`gemini-3-flash-preview`、`gpt-5.5`
  - findings 均为空。
- 真实 fallback 演练：
  - 临时把 vision 主模型改为 `gemini-3-flash-preview-unavailable-rehearsal`，备选保持 `gpt-5.5`。
  - 调用真实当前 `final.png`：`/Users/a1234/Desktop/飞书Claude/claude-feishu-bridge/.runtime/bridge-state/photoshop-jobs/running/photoshop-be946f18-7e54-497c-9548-483d2ea4c85b/final.png`
  - API 返回 `completed`，实际命中 `gpt-5.5`，耗时约 `22.1s`，确认自动 fallback 成功。
  - 随后恢复生产 vision 路由：`gemini-3-flash-preview` + `gpt-5.5`。
- 额外指定 `modelId=gpt-5.5` 调用成功，耗时约 `12.4s`。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - `/api/regression/model-routing` 返回 `ready`
  - `/app.js` 已包含 `modelRouteModelApiKeyEnvs`、`parseModelApiKeyEnvs` 和“模型专用 Key Env”。
- 本轮未发送飞书消息，未外发 PSD。

# 2026-04-28 任务 — vision 主备双凭据路由接入

## 目标
- 按用户确认配置 vision 路由：优选 `gemini-3-flash-preview`，备选 `gpt-5.5`。
- 支持同一 Base URL 下不同模型使用不同 API Key 环境变量。
- 只保存环境变量名，不保存密钥原文；失败仍走 `manual_review`，不阻断 PS + 飞书主链路。

## 计划
- [x] 扩展本地模型路由 state，支持 `modelApiKeyEnvs`。
- [x] 模型调用、live probe 和路由 findings 改为按模型解析 API Key。
- [x] 保存 vision 路由：主模型走 `GEMINI_FLASH_API_KEY`，`gpt-5.5` 走 `GPT55_FLASH_API_KEY`。
- [x] 重启服务并注入临时 `GPT55_FLASH_API_KEY` 环境变量。
- [x] 真实验证主模型与备选模型均可 vision QA。
- [x] 运行检查、记录回顾并推送远端。

## 回顾
- 已新增模型专用 API Key 环境变量映射：`modelApiKeyEnvs`，只保存模型名到环境变量名的映射，不保存密钥原文。
- 路由解析、模型调用和 live probe 已改为按模型选择凭据：
  - 默认 `apiKeyEnv` 继续服务主模型和普通路由。
  - 若某个模型在 `modelApiKeyEnvs` 中有专用 env，则调用该模型时使用专用 env。
  - live probe 会按不同凭据分别请求 `/v1/models`，再合并匹配结果。
- 当前生产 vision 路由已保存为：
  - 优选：`gemini-3-flash-preview`
  - 备选：`gpt-5.5`
  - provider：`https://ai.flashapi.top`
  - apiKeyEnv：`GEMINI_FLASH_API_KEY`
  - modelApiKeyEnvs：`gpt-5.5 -> GPT55_FLASH_API_KEY`
  - source：`flashapi-vision-dual-credential`
- 已用当前服务进程临时注入 `GPT55_FLASH_API_KEY`；该密钥未写入仓库、README、任务记录或 runtime state。后续若服务重启，需要重新把 `GPT55_FLASH_API_KEY` 注入进程环境。
- 真实 live probe：
  - configuredModels：`gemini-3-flash-preview`、`gpt-5.5`
  - matchedModels：`gemini-3-flash-preview`、`gpt-5.5`
  - status：`ready`
  - modelCount：`4`
  - findings：无
- 使用当前真实 `final.png` 分别调用控制台 `/api/models/vision/qa`：
  - `gemini-3-flash-preview`：真实命中，`completed`，耗时约 `13.0s`。
  - `gpt-5.5`：真实命中，`completed`，耗时约 `17.3s`。
- 审计记录已增加到 `19` 条，最新两条 vision QA 分别为 `gpt-5.5 completed` 和 `gemini-3-flash-preview completed`。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
  - `/api/regression/model-routing` 返回 `ready`
- 本轮未发送飞书消息，未外发 PSD。

# 2026-04-28 任务 — vision provider gpt-5.5 候选实测

## 目标
- 使用真实 vision provider 测试 `gemini-3-flash-preview` 与 `gpt-5.5`。
- `gpt-5.5` 使用用户提供的临时 provider key，同 `https://ai.flashapi.top` 端口；密钥不写入仓库、任务记录或 runtime state。
- 输入当前真实 `final.png`，比较模型是否真实命中、质检文本、耗时和失败情况。

## 计划
- [x] 读取当前 vision 路由和真实 `final.png`。
- [x] 用当前服务路由验证 `gemini-3-flash-preview`。
- [x] 用用户提供的临时 key 直接调用 provider，验证 `/v1/models` 和 `gpt-5.5` vision QA。
- [x] 基于真实结果决定是否切换 vision 优选/备选；如需持久配置，只保存环境变量名，不保存密钥。
- [x] 运行回归检查并记录回顾。

## 回顾
- 当前生产 vision 路由：
  - 优选：`gemini-3-flash-preview`
  - 备选：`gemini-3.1-pro-preview`
  - provider：`https://ai.flashapi.top`
  - apiKeyEnv：`GEMINI_FLASH_API_KEY`
- 当前真实 `final.png`：
  - 路径：`/Users/a1234/Desktop/飞书Claude/claude-feishu-bridge/.runtime/bridge-state/photoshop-jobs/running/photoshop-be946f18-7e54-497c-9548-483d2ea4c85b/final.png`
  - 大小：`1,852,542 bytes`
- `gemini-3-flash-preview` 实测：
  - 调用方式：控制台 `/api/models/vision/qa`
  - 状态：`completed`
  - 真实命中：`gemini-3-flash-preview`
  - 耗时约 `14.4s`
  - 结果判断：可发飞书；提示医美关键词、肖像授权和合规风险。
- `gpt-5.5` 实测：
  - 调用方式：使用用户提供的临时 provider key 直接调用 `https://ai.flashapi.top/v1`；密钥未写入仓库、任务记录或 runtime state。
  - `/v1/models` 返回 `modelCount=1`，只包含 `gpt-5.5`；不包含 `gemini-3-flash-preview`。
  - vision QA 状态：`completed`
  - 真实命中：`gpt-5.5`
  - 耗时约 `10.6s`
  - usage：`prompt_tokens=3085`、`completion_tokens=127`、`total_tokens=3212`
  - 结果判断：可发飞书；文字正常、画面完整、无明显水印/黑边；提示肖像和医美合规风险。
- 结论：
  - 单次质检表现上，`gpt-5.5` 更快，摘要更直接，适合作为下一版 vision 优选候选。
  - 但当前 PS 控制台 vision 路由只支持一个 `apiKeyEnv`，而实测当前 Gemini key 只返回 Gemini 模型、临时 GPT key 只返回 `gpt-5.5`；同端口但不同 key 权限，不能在现有结构里可靠保存 `gpt-5.5` 主模型 + Gemini 备选。
  - 因此本轮未切换生产 vision 路由，保持 `gemini-3-flash-preview` + `gemini-3.1-pro-preview`，避免破坏已有 UI 质检链路。
  - 下一步如要正式接入 `gpt-5.5`，需要给 vision 路由增加“多凭据 / per-model apiKeyEnv fallback”能力，或将 `gpt-5.5` 作为单独 route key 接入。

# 2026-04-28 任务 — image 生产路由按性价比切换

## 目标
- 按用户确认的性价比策略调整生产 image 路由。
- 优选改为 `gpt-image-2`，备选改为 `gemini-3-pro-image-preview-4k`。
- 保持真实 provider、非阻断 fallback 和 PS + 飞书主链路不变。

## 计划
- [x] 读取当前 image 路由，确认切换前 baseline。
- [x] 保存生产 image 路由：`gpt-image-2` + `gemini-3-pro-image-preview-4k`。
- [x] 执行 live probe，确认两者均能在 provider 模型列表中命中。
- [x] 执行 model-routing regression 和基础检查。
- [x] 记录回顾并推送远端。

## 回顾
- 切换前生产 image 路由为：优选 `gemini-3-pro-image-preview-4k`，备选 `gemini-3-pro-image-preview-vip`。
- 已按用户确认的性价比策略保存新生产 image 路由：
  - 优选：`gpt-image-2`
  - 备选：`gemini-3-pro-image-preview-4k`
  - source：`tuzi-image-cost-preferred`
  - provider：`https://api.tu-zi.com/v1`
  - apiKeyEnv：`GEMINI_TUZI_API_KEY`
- `/api/model-routes/live-probe` 验证：
  - routeReady：`true`
  - matchedModels：`gpt-image-2`、`gemini-3-pro-image-preview-4k`
  - status：`ready`
  - modelCount：`444`
  - findings：无
- `/api/regression/model-routing` 返回 `ready`；image fallback 仍为 `manual_file`，不会生成假文件，不阻断 PS + 飞书主链路。
- 验证通过：
  - `npm run check`
  - `node --check public/app.js`
  - `git diff --check`
- 本轮只变更本机模型路由和任务记录；未发送飞书消息，未外发 PSD。

# 2026-04-28 任务 — gpt-image-2 image 模型实测

## 目标
- 使用真实 image provider 单模型测试 `gpt-image-2-vip` 和 `gpt-image-2`。
- 确认每个候选是否实际命中自身、是否生成真实图片文件、图片格式/尺寸/大小和耗时。
- 测试后恢复当前已筛选 image 路由，避免影响 PS + 飞书主链路。

## 计划
- [x] 读取当前 image 路由和 live probe，确认 baseline。
- [x] 临时切到 `gpt-image-2-vip` 单模型路由并调用真实生图。
- [x] 临时切到 `gpt-image-2` 单模型路由并调用真实生图。
- [x] 恢复当前 image 路由：`gemini-3-pro-image-preview-4k` + `gemini-3-pro-image-preview-vip`。
- [x] 运行路由验证和检查，并记录回顾。

## 回顾
- baseline image 路由：
  - 优选：`gemini-3-pro-image-preview-4k`
  - 备选：`gemini-3-pro-image-preview-vip`
  - provider：`https://api.tu-zi.com/v1`，`live-probe=ready`，`modelCount=444`。
- `gpt-image-2-vip` 单模型实测：
  - live probe matched：`gpt-image-2-vip`。
  - 生图 API：`generated`，真实命中 `gpt-image-2-vip`，endpointKind=`images`。
  - 产物：`/Users/a1234/.codex/ps-automation/model-artifacts/image/2026-04-28T08-46-39-735Z-direct-gpt-image-2-vip-cd3c37c7.png`。
  - 格式/尺寸/大小：PNG，`1254x1254`，`1,494,932 bytes`。
  - 耗时约 `35.7s`，无 fallback。
- `gpt-image-2` 单模型实测：
  - live probe matched：`gpt-image-2`。
  - 生图 API：`generated`，真实命中 `gpt-image-2`，endpointKind=`images`。
  - 产物：`/Users/a1234/.codex/ps-automation/model-artifacts/image/2026-04-28T08-47-13-965Z-direct-gpt-image-2-4c660bc2.png`。
  - 格式/尺寸/大小：PNG，`1254x1254`，`1,527,126 bytes`。
  - 耗时约 `33.7s`，无 fallback。
- 视觉验收：
  - 两张图均为浅色医美诊室背景，无文字、无 logo、无水印。
  - `gpt-image-2` 构图更干净，更适合作为 GPT 组优选；`gpt-image-2-vip` 可作为 GPT 组备选。
- 路由处理：
  - 测试后已恢复生产 image 路由为 `gemini-3-pro-image-preview-4k` + `gemini-3-pro-image-preview-vip`。
  - 暂不替换生产路由：当前 Gemini 优选输出 `4096x4096`，比 GPT 组 `1254x1254` 更适合高清 Photoshop 主链路。
  - 最终路由 live probe 仍为 `ready`，无 findings。

# 2026-04-28 任务 — image / vision 备选模型实测筛选

## 目标
- 使用真实 provider 分别测试 image 与 vision 候选模型。
- 每类只保留 1 个优选模型和 1 个备选模型。
- 所有测试必须使用真实接口、真实产物和真实 `final.png`，不使用 mock 数据。
- 筛选后更新本机模型路由；模型失败仍保持非阻断回退，不影响 PS + 飞书主链路。

## 计划
- [x] 读取当前 image / vision 路由和 provider live probe。
- [x] 分别调用 image 候选模型，确认实际命中模型、产物路径、文件大小和图片格式。
- [x] 分别调用 vision 候选模型，使用当前真实 `final.png` 确认实际命中模型、耗时和质检文本。
- [x] 选择每类 1 个优选 + 1 个备选，并保存到本地模型路由。
- [x] 运行预检、回归和路由读取验证，并记录回顾。

## 回顾
- Provider live probe 真实通过：
  - image：`https://api.tu-zi.com/v1/models`，`modelCount=444`，最终保留模型均 matched。
  - vision：`https://ai.flashapi.top/v1/models`，`modelCount=3`，最终保留模型均 matched。
- image 候选实测：
  - `gemini-3-pro-image-preview-4k`：真实命中，`/v1/images/generations`，输出 JPEG，`4096x4096`，`8,340,523 bytes`，耗时约 `43.6s`。
  - `gemini-3-pro-image-preview-vip`：真实命中，`/v1/images/generations`，输出 JPEG，`1024x1024`，`646,010 bytes`，耗时约 `28.3s`。
  - `seedream-4-0-250828`：在当前路由下会回落到 4K；单模型复测时 images/chat 两种端点均 HTTP 400，不纳入保留。
- vision 候选实测，输入真实 `final.png`：`/Users/a1234/Desktop/飞书Claude/claude-feishu-bridge/.runtime/bridge-state/photoshop-jobs/running/photoshop-be946f18-7e54-497c-9548-483d2ea4c85b/final.png`，大小 `1,852,542 bytes`。
  - `gemini-3-flash-preview`：真实命中，返回可读质检，耗时约 `12.8s`，适合作为优选。
  - `gemini-3.1-pro-preview`：真实命中，返回可读质检，耗时约 `35.0s`，适合作为高质量备选。
  - `gemini-3-pro-preview`：普通路由调用会回落到 flash；单模型复测 HTTP 503，不纳入保留。
- 已保存最终本机模型路由：
  - image 优选：`gemini-3-pro-image-preview-4k`；备选：`gemini-3-pro-image-preview-vip`；source：`tuzi-image-screened`。
  - vision 优选：`gemini-3-flash-preview`；备选：`gemini-3.1-pro-preview`；source：`flashapi-vision-screened`。
- `/api/model-routes/live-probe` 验证最终路由均为 `ready`，无 findings。
- `/api/regression/model-routing` 返回 `ready`；模型调用审计记录增加到 `14` 条，其中失败候选均按 fallback/manual 路径记录，未阻断主链路。

# 2026-04-28 任务 — 真实 image / vision provider 配置与生图验证

## 目标
- 配置本机真实 image / vision provider，只保存模型名、Base URL 和 API Key 环境变量名，不保存密钥原文。
- 跑真实 live probe，确认 provider 可连通。
- 跑真实 image 生图调用：必须拿到真实图片字节并落盘到本机 runtime，失败则记录真实错误，不伪造图片。
- 跑真实 final.png vision 质检：使用当前真实 `final.png`，质检失败仍不阻断 PS + 飞书主链路。

## 计划
- [x] 读取当前可用 provider 环境变量和真实 `/v1/models`，确认可用模型。
- [x] 为 PS 控制台 image 生成补齐 chat/completions 图像模型兼容层。
- [x] 保存 image 路由到本机 runtime state，并重启服务使环境变量生效。
- [x] 保存 vision 路由到本机 runtime state，并重启服务使环境变量生效。
- [x] 执行 live probe、真实 image 生成、真实 final.png vision QA。
- [x] 运行类型检查、脚本检查、API smoke，并回填本节回顾。

## 回顾
- 当前 shell 有真实 provider 环境变量：
  - `GEMINI_FLASH_BASE_URL=https://ai.flashapi.top`
  - `GEMINI_FLASH_API_KEY` 已存在，但未输出密钥。
  - `GEMINI_TUZI_API_KEY` 已存在，但未输出密钥。
- 真实 `/v1/models` 探测：
  - FlashAPI 返回 3 个模型：`gemini-3.1-pro-preview`、`gemini-3-pro-preview`、`gemini-3-flash-preview`。
  - 通过控制台 live probe，兔子 image provider 返回 `444` 个模型，并命中 `gemini-3-pro-image-preview-4k` 与 `gemini-3-pro-image-preview-vip`。
- 代码补齐：
  - `src/model-routing.ts` 的 image 生成现在支持两种真实 provider 形态：
    - `/v1/images/generations`
    - `/v1/chat/completions` 图像模型返回 base64 / 图片 URL
  - 仍只有拿到真实图片字节、通过 PNG/JPG/WEBP 魔数检查并落盘后，才返回 `generated`。
- 本机 runtime state 已保存：
  - image：`https://api.tu-zi.com/v1` + `GEMINI_TUZI_API_KEY` + 主模型 `gemini-3-pro-image-preview-4k` + 备选 `gemini-3-pro-image-preview-vip`。
  - vision：`https://ai.flashapi.top` + `GEMINI_FLASH_API_KEY` + 主模型 `gemini-3-flash-preview` + 备选 `gemini-3-pro-preview`。
  - state 只保存环境变量名，不保存密钥原文。
- 真实 live probe：
  - image：`ready`，endpoint `https://api.tu-zi.com/v1/models`，`modelCount=444`，matched `gemini-3-pro-image-preview-4k` / `gemini-3-pro-image-preview-vip`。
  - vision：`ready`，endpoint `https://ai.flashapi.top/v1/models`，`modelCount=3`，matched `gemini-3-flash-preview` / `gemini-3-pro-preview`。
- 真实 image 生成：
  - 请求耗时 `53150ms`。
  - 命中模型 `gemini-3-pro-image-preview-4k`。
  - 产物：`/Users/a1234/.codex/ps-automation/model-artifacts/image/2026-04-28T06-47-49-283Z-real-provider-smoke-5d1b0ef6.jpg`。
  - 尺寸 `4096x4096`，大小约 `8.2 MB`，metadata 已落盘。
- 真实 vision QA：
  - 输入当前真实 `final.png`：`/Users/a1234/Desktop/飞书Claude/claude-feishu-bridge/.runtime/bridge-state/photoshop-jobs/running/photoshop-be946f18-7e54-497c-9548-483d2ea4c85b/final.png`。
  - 请求耗时 `14095ms`。
  - 命中模型 `gemini-3-flash-preview`。
  - 返回 `completed`，`nonBlocking=true`，摘要判断“可以发飞书”。
- 验证：
  - `npm run check` 通过。
  - `node --check public/app.js` 通过。
  - `git diff --check` 通过。
  - `/api/regression/model-routing` 返回 `ready`；provider live probe、fallback policy、vision non-blocking policy、usage audit 全部 ready。
  - 模型使用审计当前 `6` 条，最新两条为 `vision.qa completed` 和 `image.generate generated`。
  - Playwright UI 验证通过：模型路由面板显示真实模型、模型使用记录显示 generated，控制台无 error、无横向溢出。截图：`/tmp/ps-console-real-provider-routing-1440.png`。
  - 飞书发送历史仍为 `2` 条，本轮未新增飞书消息；PSD 仍为 `local_only`。

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
- [x] 远端冷启动回归并推送 GitHub。

## 回顾
- 新增 `/api/model-routes/live-probe`：只对已配置 Base URL 的真实 provider 请求 `/v1/models`；当前本机 3 路模型均未配置，因此 live probe 全部返回 `skipped`，没有伪造连通。
- 新增本地 `modelUsageHistory` 审计，`/api/status` 和 `/api/model-routes/usage-history` 均可读取；审计写入为非阻断，即使写 state 失败也不影响 image/vision API。
- `/api/models/image/generate` 在未配置 image provider 时返回 `fallback.manual_file`，并写入 1 条 `image.generate/fallback` 审计，不生成假图片。
- `/api/models/vision/qa` 使用真实 `final.png` 验证：未配置 vision provider 时返回 `fallback.manual_review` 且 `nonBlocking=true`，并写入 1 条 `vision.qa/fallback` 审计。
- 新增 `/api/regression/model-routing`，当前返回 `ready`；provider live probe 为 `warning`，原因是没有可 live probe 的真实 provider；fallback 策略和 usage audit 均通过。
- UI 模型路由面板新增“连通性检查”“模型回归”和“模型使用记录”，桌面 1440x1200 与移动 390x844 Playwright 验证通过，控制台无 error、无横向溢出。
- `npm run check`、`node --check public/app.js`、`git diff --check` 均通过。
- 飞书发送历史仍为 2 条（1 sent / 1 failed duplicate guard），本轮未新增飞书消息，未发送 PSD。
- 已推送实现到远端 main：`610227d15bb77bd2df678386e4c686b538e645de`。
- 远端冷启动克隆 `/tmp/ps-console-model-ops-cold.rG2Fo6/repo` 通过：`npm ci`、`npm run check`、`node --check public/app.js`、备用端口 `3604` 的 `/api/status`、`/api/model-routes/live-probe`、`/api/models/image/generate` fallback、`/api/models/vision/qa` fallback、`/api/regression/model-routing`、`/api/model-routes/usage-history` 均正常。
