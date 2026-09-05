# 审查修复记录（2026-09-05）

对照两轴审查报告（Standards 15 项 / Spec 8 项）的逐项处置。D5/D8 两项结构性重构
经评估暂缓，理由见文末。

## Spec 轴（8 项）

| # | 问题 | 处置 |
|---|------|------|
| S1 | CSV 超限行丢失，"全文可回读"承诺落空 | ✅ `parseCsv` 不再截行，全文入库；`maxInlineTableRows` 改为预警阈值（超限仅在警告中提示用 read_document 分页）；设置卡提示同步 |
| S2 | OCR 卡死：`run()` 抛错后 `ocrDone<ocrTotal` 永存、status 无 error 终态、poll 无限循环、send-hook 无超时等待 → sendSession 永久挂起 | ✅ 四层修复：① `run()` 整体 try/catch 兜底，致命错误时标记失败页（保持可重试）、`ocrDone=ocrTotal` 收尾写盘，状态必达终态；② status 路由对"有 pending 页但无在跑作业"的文档自动重启 OCR（自愈，含 host 重启丢作业场景）；③ 客户端 `pollUntilReady` 加 15 分钟总预算，超时转 error；④ send-hook 等待 `doc.ready` 加 120s 上限，超时照常发送（已就绪引用不受影响）；OCR kick-off 失败改为 console.warn 不再静默 |
| S3 | 内联模式残骸（showCostToast、toast.*、_readThreshold、过期 description、误导性 ¥ 标签） | ✅ 全部删除：ui.tsx toast 设施、send-hook 阈值参数、client/index.ts 的 costNoticeThreshold 读取、文件卡片费用标签与 `chip.cost`/`file.cost`/`file.preview` 死键；package.json description 重写为引用语义 |
| S4 | ADR 0002 未同步引用头引导语 | ✅ ADR 0002 追加"修订（2026-09-05）"节，明确引导语属紧凑引用的一部分 |
| S5 | README 写 `EXTRACTOR_VERSION = 3`，代码为 4 | ✅ README 升级说明改为 3/4 双版本描述 |
| S6 | `ocrPageCap=0` 实际是"全跳过"，与 UI"0 = 不限"相反 | ✅ `ocr.ts` 改为 `cap>0` 才截断，0 = 不限 |
| S7 | 同版本重导入不触发 OCR（`ocrTotal=0` 死锁） | ✅ 去重分支增加补跑条件：OCR 开启且有扫描页未处理（`ocrTotal===0` 或 `ocrDone<ocrTotal`）即 `ocr.start` |
| S8 | 次要项 | ✅ `thinking:{type:'disabled'}` 仅对 DeepSeek 端点/模型发送；预览弹窗改为轮询 status（2s 间隔，直至取到全文或弹窗关闭）；README 页成本措辞改为 ≈¥0.003–0.01 |

## Standards 轴 — 规范违规（6 项）

| # | 问题 | 处置 |
|---|------|------|
| V1 | package.json description 承诺内联 + 费用提示 | ✅ 重写（同 S3） |
| V2 | `button.aria` / `toast.cost` 承诺已消失的内联行为 | ✅ aria 改为"自动解析并生成文件引用"；toast.* 删除 |
| V3 | header 死分句"内联截断至…"（模型可见误导文案） | ✅ 删除分句；`DocMeta.inlineChars/truncated` 死字段一并移除 |
| V4 | ADR 0002 遗留永不执行的代码 | ✅ `costNoticeThreshold` 客户端读取、`showCostToast` 全删（同 S3） |
| V5 | 术语"OCR 识别" vs 规范术语"OCR 回退" | ✅ 设置卡分组名、chip 文案、README/CONTEXT 同步改为"OCR 回退" |
| V6 | 术语"上传" vs 规范术语"文档导入" | ✅ `chip.uploading` → "导入中…"、设置卡"上传上限" → "文档大小上限"、CONTEXT 流程条目改为"文档导入" |

## Standards 轴 — 坏味道（9 项）

| # | 类型 | 处置 |
|---|------|------|
| D1 | routes 刷新/新建双路径重复 ~30 行 | ✅ 合并为单条提交路径（共享 meta 构建 + OCR 启动 + 响应序列） |
| D2 | `[meta.warning,'…'].filter(Boolean).join('；')` ×8 | ✅ 提取 `pushWarning()`（store.ts），8 处全部替换 |
| D3 | cost 对象两处组装形状不一 + client 镜像 | ✅ 收敛为 `costView()` 单一形状 `{tokens,cny,ocrCny,label}`，attach/status 共用；client 接口天然对齐 |
| D4 | preview.ts 重声明 file.* 字符串 | ✅ 复用 locales dictionaries；`file.preview`/`file.cost` 死键删除 |
| D5 | 新增设置项需改 4 处（schema 派生卡片字段） | ⏸ 暂缓：schemastery schema 与手写卡片字段各有表达（分组/提示/显示变换），自动派生需引入字段元数据协议，属独立重构；已用测试锁住 FIELDS 与 schema 键集一致性风险可在后续版本处理 |
| D6 | Middle Man：joinTextItems 纯转发 + assemblePdfText 重复 re-export | ✅ 删除 routes.ts/ocr.ts 的重复 re-export；joinTextItems 保留（测试直接覆盖该纯函数，删除需改测试语义） |
| D7 | kind 字段 Primitive Obsession | ✅ `DocMeta.kind`/`DocStatus.kind` 改为 `DocKind` 类型；client 侧 `DraftDoc.kind` 保留 string（它是浏览器侧扩展名标签，并非规范 DocKind，已加注释说明） |
| D8 | 八个 price*PerMTok 数据团 | ⏸ 暂缓：打包为价格表类型会改变 schemastery schema 结构与已存储配置的形状，需迁移策略；单独成版处理 |
| D9 | `pages.find((p) => p.n === n)` O(n²) | ✅ ocr.ts / routes.ts 均改为按页号建 `Map` 索引 |

## 验证

- `pnpm build`（tsc + esbuild client）通过
- 22 项单元测试全过（新增：CSV 全文入库、header 无死分句且含引导语、pushWarning 语义）
- `e2e-host.mjs` 真实 PDF 全链路通过（页码标记 / read_document 分页 / raw 路由）

## 行为变化摘要（用户可见）

- OCR 再也不会卡住消息发送：作业异常必有终态；即使极端情况，发送等待上限 120 秒。
- CSV 全文永远可经 `read_document` 回读（此前超限行直接丢失）。
- 设置卡"0 = 不限"的 OCR 页数上限现在真的生效；导入时关 OCR 的文档，之后开启 OCR 再导入会补跑。
- 文件卡片不再显示误导性的 ¥ 费用估算；文案统一为规范术语（OCR 回退 / 导入）。
- 非 DeepSeek 视觉端点不再收到 DeepSeek 专有的 `thinking` 参数。
