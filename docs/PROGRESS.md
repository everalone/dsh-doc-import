# PROGRESS.md — 进度与交接

> **每个 agent 会话开始时先读这一页，结束前更新它。** 只写"当前有效"的事实，
> 不写历史叙述；新会话条目加在「会话日志」最上方（按时间倒序，减少冲突）。
> 稳定计划看 [`roadmap.md`](./roadmap.md)，已定架构决策看 [`adr/`](./adr/)。

---

## 当前状态

- **基准版本**：v1.1（`main` @ `039f1a3`），MIT，仓库 `everalone/dsh-doc-import`
- **可运行**：host 半 + client 半均完成，本地 `pnpm build` 通过，单测 22 项全绿
- **数据**：文档存 `~/.dsh/storages/doc-import/<sha256>/`（`original.bin` / `text.txt` /
  `pages.json` / `meta.json`）；当前 `EXTRACTOR_VERSION = 4`
- **未验证项**：无（最近一轮改动均已构建 + 单测通过；活体验收需 `dsh web` 重启后跑
  `scripts/verify-live.mjs`）

## 下一步

1. **复杂页视觉重提取**（roadmap 第 1 项，效果/成本比最高）：复杂页判定 → 渲染成图 →
   视觉模型输出 Markdown，复用现有 OCR 通道
2. 可选：与 `dsh-better-sidebar` 集成（`registerTab` / `registerFileViewer`），
   把提取全文展示到侧边栏；纯增量，不动现有代码
3. 可选：离线专业版面引擎（pdfplumber / poppler `pdftotext -layout`）作为可切换引擎

## 需要注意

- 踩坑清单、注入约束、构建/验证命令 → [`../AGENTS.md`](../AGENTS.md)（改代码前必读）
- `review/` 是刻意忽略的本地目录，不要提交
- `lib/` 是构建产物（不入库），**拉取后必须 `pnpm build`**，否则"代码是新的、跑的是旧的"

---

## 会话日志

### 2026-09-10 · 协作基建（agent）

- **做了什么**：新增 `AGENTS.md`（协作规则 / 机器本地状态 / 目录速查 / 架构决策 / 已知坑 /
  验证闭环）与 `PROGRESS.md`（本文件）；把"会话开始与结束的硬性清单"写死进 AGENTS.md。
- **状态同步**：把本地工作区对齐到 `main @ 039f1a3`（v1.1），重新构建 `lib/`，22 项单测通过。
- **踩坑**：本地曾落后远程 7 个提交，且未先 `fetch/status` 就执行了 `git reset --hard`
  ——已被纠正；教训写进 AGENTS.md「协作规则」与「禁止事项」。
- **下一步**：本次两个文档随本提交一起推送；随后做「复杂页视觉重提取」。

### 2026-09-05 · v1.1（用户）

- `171f959` feat: 官方环境一等公民支持 + PDF 识别五项优化 (v1.1)
- `753a3fa` fix: 引用头自带读取指引 + docx 图片去噪（实测事故三项修复）
- `1685cf8` fix: 按两轴审查报告修复 OCR 挂死 / CSV 回读 / 死代码清理等 21 项
- `8dabb01` fix: 自愈重启上限与退避、OCR 终态保证、客户端预算按作业规模推算、重复代码收敛
- `039f1a3` fix: 自愈预算改为持久化计数（收敛才清零）、文本写失败可再生成、预算按剩余页数并随进度刷新
- `897efef` docs: 过程性文档移入本地 `review/` 目录并忽略跟踪
