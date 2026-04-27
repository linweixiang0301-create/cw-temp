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
