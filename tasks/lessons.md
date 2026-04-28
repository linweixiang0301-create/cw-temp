# Lessons

- 2026-04-28：用户明确纠正 PS 自动化里的“智能拆层 / PSD 重建”默认拆层模型应走 image 路由的 `gpt-image-2`，不是 vision 质检模型；需要在审计中区分 `image.layer_analysis` 与 `image.generate`，并在失败时回退真实单图层 manifest，不伪造拆层。
