# dsh-doc-import

[GitHub](https://github.com/everalone/dsh-doc-import) · MIT · DSH / DeepSeek Harness Cordis 插件

**把文档拖进对话，让模型真正读到它。**

支持 **txt · md · csv · docx · pdf**（含扫描版 PDF 自动 OCR）。文档解析后存于本地，
消息里只出现一张轻量文件卡片——不刷屏、不挤占上下文；模型按需通过 `read_document`
工具分页回读全文。

## 特性

- **零刷屏的文档呈现** — 消息内联一行紧凑引用，聊天区渲染为文件卡片（图标 + 文件名 +
  页数/字符数），点击弹全文预览，可另开原始文件；底层消息文本不变，会话日志干净。
- **扫描版 PDF 自动 OCR** — 无文本层的页面逐页渲染成图，交 DeepSeek 视觉模型转写；
  结果按页持久化，重复导入不重复计费（约 ¥0.003–0.01/页，随页内容长度浮动）。
- **结构感知的 PDF 文本提取** — pdfjs 文本层 + 视觉坐标排序：行聚类、分栏检测、
  阅读顺序重组，不依赖内容流顺序；中文片段拼接无假空格；每页带 `[第 N 页]` 定位标记。
- **模型可翻页的长文回读** — `read_document` 支持 `offset` 分页 + `totalChars` 回报，
  长文档不再只能读到开头。
- **OCR 可观测、可恢复** — 输出截断自动加倍重试并标注「可能截断」；失败页保留待办，
  重新导入只补跑失败页；作业异常必有终态（就绪或失败），不会挂起消息发送；崩溃自愈重启
  有持久化的次数上限与退避，存储故障不会跨重启放大成反复计费。
- **不依赖社区全家桶** — 只装官方 DeepSeek Harness 即可完整使用（导入、OCR、设置卡
  全部走官方接口）；装有社区 dsh-web 时同样兼容。

## 工作原理

```
拖入/粘贴/选择文件
        │
        ▼
┌─ host 半（Cordis 插件，Node）────────────────────────────┐
│ 解析（parsers）                                          │
│   txt/md   自动识别 UTF-8 / GB18030                       │
│   csv      → markdown 表格（可控行数上限）                │
│   docx     mammoth → markdown                            │
│   pdf      pdfjs 文本层 → 行聚类 → 分栏检测 → 阅读序      │
│              └─ 无文本层页 → 渲染 PNG → 视觉模型 OCR      │
│ 存储（store） 内容寻址 ~/.dsh/storages/doc-import/<sha256>/│
│ 工具（tool）  read_document(id, offset?, maxChars?)       │
└──────────────────────────────────────────────────────────┘
        │  [document 文件名, 类型, N 页, M 字符, id: sha256]
        ▼
┌─ client 半（Web GUI）────────────────────────────────────┐
│ 输入区导入按钮 · 文件芯片 dock · 拖放/粘贴监听            │
│ 发送钩子：消息中注入引用行                                 │
│ 聊天区把引用渲染为文件卡片 + 全文预览                      │
│ 设置 → 插件配置 → 文档导入 卡片                           │
└──────────────────────────────────────────────────────────┘
```

**一次典型流程**：用户拖入 `报告.pdf` → host 解析（扫描页自动 OCR）→ 消息发送时附上
一行 `[document 报告.pdf, pdf, 42 页, 88,000 字符, id: …]` → 聊天区显示卡片 → 模型看到
引用后调用 `read_document`，超长则按 `offset` 翻页读完 → 基于全文回答。

## 安装

前置：Node 18+、pnpm、官方 DeepSeek Harness（`dsh` CLI）。社区 dsh-web 全家桶
**可选**，装不装都能用。

```bash
git clone https://github.com/everalone/dsh-doc-import.git
cd dsh-doc-import
pnpm install                       # mammoth / pdfjs-dist / @napi-rs/canvas / schemastery
node scripts/link-core.mjs         # 把 dsh 核心包符号链接进工作区（与 profile 同实例）
pnpm build                         # tsc + esbuild → packages/dsh-doc-import/lib
dsh plugin --profile web add link:./packages/dsh-doc-import
# 重启 dsh web 后生效
```

> 若 `dsh plugin` 在解析依赖时因默认镜像源缺包而报"找不到版本"，
> 追加官方源重试：`dsh plugin --profile web add link:./packages/dsh-doc-import --registry=https://registry.npmjs.org/`

OCR 需要视觉模型访问凭证：默认从凭证服务读取 `DEEPSEEK_API_KEY`（可在设置中改用其他
环境变量 / 端点 / 模型，任何 OpenAI 兼容视觉端点均可）。

## 使用

- **导入**：点输入区「📄 导入文档」按钮，或直接把文件拖进 / 粘贴到对话窗口。
- **预览**：点击消息中的文件卡片查看全文；「打开原始文件」在新标签页展示原件。
- **让模型读**：直接提问即可——模型遇到 `[document …]` 引用会自行调用
  `read_document`；超长文档它会按页翻读。也可以明确指示：「用 read_document 从第
  20000 字符开始继续读」。

## 设置（Settings → 插件 → 插件配置 → 文档导入）

可折叠卡片，三组字段，失焦即保存，单项 ↺ 恢复默认：

| 组 | 关键项（默认值） |
|---|---|
| 文档导入 | 文档大小上限 100 MiB · PDF 页数上限 2,000 · CSV 全文入库（预警行数 1,000） |
| OCR 回退 | 自动 OCR 开 · 页数上限 100（0 = 不限）· 并发 3 · 扫描页阈值 30 字符 · 模型 `deepseek-v4-flash-vision-exp` · 端点 `https://api.deepseek.com` · 密钥变量 `DEEPSEEK_API_KEY` · 截断自动加倍重试 |
| 价格表 | 高峰/空闲 × 输入/输出单价（DeepSeek 官方价，可改）· 每页图片 tokens 384 |

> 纯官方环境（无社区全家桶）下该卡片出现在官方「插件配置」页；装有全家桶时两处均可见，
> 读写同一份配置。

## 开发

```bash
pnpm build                              # tsc + esbuild（client bundle）
pnpm test                               # 解析 / 费用 / 顺序算法 / 工具分页单测
pnpm watch                              # host 改动热编译（需重启 dsh web）
pnpm watch:client                       # client 改动热更新（刷新页面即可）
node scripts/e2e-host.mjs <pdf路径>     # 独立 HTTP 全链路 e2e（解析→OCR→状态→工具→raw）
node scripts/verify-live.mjs <GUI地址>  # 对运行中的 GUI 做活体验收
```

### 目录结构

```
packages/dsh-doc-import/
  src/
    index.ts     host 入口（设置命名空间、read_document 注册）
    routes.ts    webServer 路由（上传 / 状态 / OCR 触发 / raw 原文件）
    store.ts     内容寻址存储与文档注册表
    parsers.ts   txt/md/csv/docx/pdf 解析分发与全文组装（EXTRACTOR_VERSION 门控）
    pdf.ts       pdfjs 文本层 → 视觉行聚类 / 分栏 / 阅读序（CJK 感知）
    ocr.ts       扫描页渲染 + 视觉模型转写（截断检测、失败重试、并发控制）
    tool.ts      read_document 工具（offset 分页）
    client/      client 半（导入按钮、dock、拖放、发送钩子、预览、设置卡）
  test/          node:test 单元测试
docs/
  adr/           设计决策记录（0002 纯文件引用取代 0001 文本内联）
  roadmap.md     路线图（下一步：复杂页视觉重提取）
  dependency-audit-and-pdf-pipeline.md   依赖审计与 PDF 优化报告
CONTEXT.md       项目词汇表
```

### 升级说明（v1.1+）

解析管线版本 `EXTRACTOR_VERSION` 已升级至 3（全页页码标记 + OCR 失败可重试）与
4（docx 图片去噪、CSV 全文入库）：旧文档重新导入时自动重新提取，
已付费的 OCR 结果按页号保留、不会重复计费。

## 许可证

MIT。设计参考了 Apache-2.0 的 `@linxin666/dsh-tool-describe-image` 的**接口惯例**
（工具注册、webServer 路由、slots、发送钩子、预览增强器），未复制其源码；
DSH 官方包为 MIT。
