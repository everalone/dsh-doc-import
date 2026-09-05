# dsh-doc-import：依赖审计与 PDF 识别优化报告

> 日期：2026-09-05 · 适用版本：EXTRACTOR_VERSION 3（本次变更后）

本文回答两个问题：

1. 能否在**没有社区 dsh-web 全家桶**（zhu1090093659/dsh-web，npm `@linxin666/*`）的情况下，仅靠官方 DeepSeek Harness 的 `dsh web` GUI 使用本插件？
2. PDF 识别流程有哪些薄弱环节？哪些已修复，哪些留给后续版本？

---

## 一、依赖审计：真相与修复

### 1.1 结论先行

**本插件与社区 dsh-web 仓库之间不存在任何代码级依赖**（零 import、零 HTTP 调用、零构建共享）。它对「dsh web」的真实依赖是**官方** Web GUI（`dsh web` 启动的 shell）提供的运行环境：

| 客户端能力 | 提供方 | 状态 |
| --- | --- | --- |
| 输入区导入按钮（`conversation.input.left` 槽位） | 官方 `@deepseek-ai/dsh-client-ui-conversation` | ✅ 官方 |
| 文件芯片 dock（`conversation.input.dock` 槽位） | 官方同上 | ✅ 官方 |
| 拖放/粘贴监听、发送钩子、文档预览 | 官方 shell + 标准 DOM | ✅ 官方 |
| CSS 设计令牌 `--dsw-alias-*` | 官方 `dsh-client-ui-theme` | ✅ 官方 |
| 多语言 `locale` 服务 | 官方 `dsh-client-locale` | ✅ 官方 |
| host 半（解析/存储/OCR/`read_document` 工具/HTTP 路由） | 官方 Cordis 插件机制 | ✅ 官方 |
| **设置卡槽位** | ~~社区 `web-ui.plugin.item`~~ → **已修复为官方 `settings.plugin.item` 为主** | ✅ 本次修复 |

### 1.2 唯一的真实耦合点（已修复）

改动前，设置卡只注册在社区包 `@linxin666/dsh-client-ui-web-ui-settings` 声明的 `web-ui.plugin.item` 槽位上。不装全家桶时，其余功能全部正常，唯独设置卡不出现。

本次修复采用**双注册**（`src/client/index.ts`）：

- **官方槽位**：`settings.plugin.item`，以配置命名空间 `NS` 为 key（官方 `@deepseek-ai/dsh-client-ui-settings-plugins` 的 keyed slot，与 host 半 `settings.installSection` 注册的命名空间自动配对）；
- **社区槽位**：`web-ui.plugin.item` 保留，照顾继续使用全家桶的用户（同一份配置，两处显示一致）。

两处注册各自独立 try/catch，任一失败只告警不阻断启动。

**修复过程中实测发现的第二个坑**（纯代码审查无法发现）：官方 `settingsScope.bind()` 返回的 `SettingsScopeController` 是 **class 方法**，而卡片把 `getSnapshot`/`subscribe` 以脱离对象的引用传给 React `useSyncExternalStore`，调用时 `this === undefined` → `this.store` 抛 `TypeError`，卡片渲染崩溃（官方 shell 会捕获槽位错误，页面其余部分不受影响）。社区 binder 返回闭包，所以装全家桶时从未暴露。修复：绑定处统一规范化为箭头函数包装（`src/client/index.ts`），对社区 binder 是无操作，对官方服务是必需的。

### 1.3 验证结果（纯官方 profile 实测）

构造了不含任何 `@linxin666/*` 包的独立 profile（`C:\Users\12633\.dsh\profiles\web-verify`，仅官方 `dsh-base` + `dsh-web-app` + 本插件，junction 链接到本地构建产物），`dsh --profile web-verify web` 启动后实测：

| 检查项 | 结果 |
| --- | --- |
| GUI 正常启动，无启动报错 | ✅ |
| 输入区出现「📄 导入文档」按钮（含格式提示 tooltip） | ✅ |
| `verify-live.mjs` host 半验收（路由/存储/工具） | ✅ 全部通过 |
| `e2e-host.mjs` 全链路（真实 PDF：解析→分页→文本组装→`read_document`） | ✅ 通过，页码标记与分页字段正常 |
| 设置 → 插件 → 插件配置页出现「文档导入」卡片 | ✅ |
| 卡片展开后三组字段（文档导入 / OCR 识别 / 价格表）完整渲染 | ✅ |
| 浏览器控制台 pageerror | ✅ 0 个 |

**结论：可以。** 现在「官方 Harness + `dsh web`、不装全家桶」即为一等公民使用场景。

---

## 二、PDF 识别：薄弱环节与优化

### 2.1 管线现状（一句话版）

pdfjs 逐页提取文本层（`pdf.ts`：坐标放置 → 行聚类 → 分栏检测 → 阅读序排列）→ 每页按「字符数 < 30」判定是否扫描页 → 扫描页渲染 PNG 交 DeepSeek 视觉模型 OCR（`ocr.ts`）→ `parsers.ts` 组装全文 → 存储供内联与 `read_document` 回读。

### 2.2 本次已修复的 5 个薄弱环节

| # | 薄弱环节 | 修复 | 效果 |
| --- | --- | --- | --- |
| 1 | **`read_document` 只能读开头**：仅 `maxChars` 前缀截断，长文档中后段模型永远读不到 | `tool.ts` 新增 `offset` 参数，返回 `totalChars`/`truncated`，工具描述引导模型翻页 | **长文档完整性提升最直接的一条**：后半篇内容模型终于能看到 |
| 2 | **OCR 静默截断**：从不检查 `finish_reason`，输出撞 `max_tokens` 上限时后半页无声丢失 | `ocr.ts` 读取 `finish_reason === 'length'` → 双倍 token 重试一次 → 仍截断则页尾标「可能截断」并写入文档级警告 | 不再无声丢内容；仅截断页多花一次请求 |
| 3 | **OCR 失败永久化**：失败页写入「OCR 失败」标记并被 todo 过滤器永久跳过，重导入也不重试 | `store.ts` 新增 `ocrError` 字段；失败页保持 `ocrText` 为空 → 仍在待办中；旧版失败标记在重导入时不再被当作有效结果复制 | 一次网络抖动不再造成永久缺页 |
| 4 | **文本页无页码标记**：只有 OCR 页有 `[第 N 页 · OCR]`，文本页连成一片，引用定位困难 | `parsers.ts` 所有页加 `[第 N 页]` 头；`EXTRACTOR_VERSION` 2→3，旧文档重导入自动重提取（OCR 结果按页号保留，不重复花钱） | 模型引用「第 X 页」更准，人工核对更容易 |
| 5 | **中文假空格**：pdfjs 在字体切换处拆行内片段，拼接时硬塞 ASCII 空格（"文档 导入"） | `pdf.ts` `clusterLines` 判断边界字符：两侧均为 CJK（统一表意文字/中文标点/全角形式）时以 `''` 连接，拉丁/数字边界保留空格 | 中文 PDF 提取文本更干净，顺带省 token |

配套扩展了单元测试（`test/parsers.test.mjs`，17 项全过）：CJK 拼接、全页页码标记、版本号、`read_document` 分页语义。

### 2.3 未动的硬骨头（按优先级排列的后续路线）

以下问题本次**有意不动**，均为已知限制：

1. **图文混排页漏 OCR**（v2 首选，收益/成本比最高）
   现状：只有「字符数 < 30」这一信号判定扫描页。一页有 150 字文本层 + 一张含关键表格的大图 → 不会被 OCR，图里的内容直接丢失。
   方案：用 `page.getOperatorList()` 统计图片绘制操作，对「有明显图片 + 低文本密度（如 < 200 字符）」的页追加 OCR；复杂页直接走路线图已有的「整页转图 → 视觉模型输出结构化 Markdown」（约 ¥0.01/页）。
   预估：~40–60 行精细代码，建议作为 v2 第一项。

2. **表格拍平**
   现状：任何表格都被拆成普通文本行，列结构完全丢失。
   方案：短期靠 v2 视觉重提取兜底（模型直接输出 Markdown 表格）；长期可评估表格专用结构化输出。不建议在 pdfjs 文本层上自制表格检测——投入大、天花板低。

3. **复杂分栏/嵌套版面阅读序错误**
   现状：`detectColumns` 的 xStart 聚类（≥6 行、12px 容差、覆盖率 0.2）对标准双栏有效；三栏、跨栏标题、侧栏注释仍可能乱序。
   方案：同样归入 v2 视觉重提取（整页图像交给模型，天然理解版面）。

4. **页眉/页脚/水印噪声**：可做重复行统计过滤（每页首尾出现且跨页重复的行），中小工作量，可与 v2 一起做。

5. **旋转文本**：非 0° 文本目前追加在页尾，至少不丢；优先级低。

6. **加密 PDF**：直接报错并给用户可读提示（现状即如此），除非有真实需求再做无密码加密的空解密支持。

### 2.4 总体预期

- **纯文字 PDF / 扫描版 PDF**（最常见两类）：准确率与完整性**立竿见影**改善（假空格消除 + 页码定位 + 长文可翻页 + 截断/失败不再无声）。
- **表格 / 多栏 / 图文混排**：本次改善有限，需 v2 视觉重提取真正解决。

---

## 三、改动文件清单

| 文件 | 变更 |
| --- | --- |
| `src/client/index.ts` | 设置卡双注册（官方 keyed slot + 社区 slot）；scope 方法规范化修复 `this` 崩溃 |
| `src/pdf.ts` | `clusterLines` CJK 感知拼接 |
| `src/parsers.ts` | `assemblePdfText` 全页页码标记 + `ocrError` 失败标签；`EXTRACTOR_VERSION` → 3 |
| `src/store.ts` | `PdfPageRecord.ocrError` 字段 |
| `src/ocr.ts` | `finish_reason` 截断检测与加倍重试；失败页可重试（`ocrError` 替代永久标记）；统计收尾调整 |
| `src/routes.ts` | 重导入时旧版失败标记不再被当作有效 OCR 结果复制 |
| `src/tool.ts` | `read_document` 新增 `offset`，输出 `totalChars`/`truncated`，更新工具描述 |
| `test/parsers.test.mjs` | 新增 CJK 拼接、页码标记、版本、分页测试（共 17 项） |
| `docs/dependency-audit-and-pdf-pipeline.md` | 本报告 |

## 四、复核命令

```bash
pnpm build && pnpm test                     # 构建 + 17 项单测
node scripts/e2e-host.mjs <某个.pdf>        # 全链路（真实解析+存储+read_document）
# 纯官方环境验证：参照 C:\Users\12633\.dsh\profiles\web-verify（不含 @linxin666/*）
```
