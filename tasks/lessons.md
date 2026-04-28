# Lessons

- 2026-04-29：用户最新纠正并经真实测试确认：调用端的 `image-2` 没有拆解图层/输出分层 PSD 能力；即使用“生成 PS 可打开分层 PSD”的提示词，真实返回仍是单层 PNG，Photoshop 打开后 `doc.layers.length=1`。PS 自动化中 `image` 路由只能负责真实生图产物，不能被 UI/README/后端描述为拆层分析模型。PSD 重建拆层应走视觉结构分析路线（当前 `vision` 路由）生成“AI 重建建议”，失败回退真实单图层 manifest，不伪造原始 PSD 图层。
- 2026-04-28：历史纠正已被 2026-04-29 真实测试修正：不再默认将 PSD 重建拆层模型切到 `gpt-image-2`；保留旧 `image.layer_analysis` 审计只作兼容和溯源。
