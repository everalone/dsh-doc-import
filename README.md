# dsh-doc-import — DSH Web 文档导入插件

[GitHub](https://github.com/everalone/dsh-doc-import) · MIT

把 **txt · md · csv · docx · pdf** 文档拖入 / 粘贴 / 选择进 DSH Web 对话窗口，插件自动完成
解析、存储与 OCR，并在对话里把文档呈现为**文件卡片**（Codex 风格）——全文不刷屏、不进消息
上下文，模型用 `read_document` 工具按需回读。

## 工作方式

1. **解析**：上传到 host 端解析为文本。PDF 走 pdfjs 文本层（视觉排序 + 行聚类 + 分栏检测的
   阅读顺序组装，不依赖内容流顺序）；docx 走 mammoth → markdown；csv → markdown 表格；
   txt/md 自动识别 UTF-8/GB18030。内容寻址存储于 `~/.dsh/storages/doc-import/<sha256>/`。
2. **OCR**：无文本层的扫描版 PDF 页面自动逐页 OCR（`deepseek-v4-flash-vision-exp`，
   默认 100 页/文档上限、并发 3、失败重试 1 次，约 ¥0.01/页）；OCR 结果按页持久化，
   重复导入不重复计费。
3. **发送**：消息里只放一行紧凑引用 `[document 文件名, 类型, N 页, M 字符, id: sha256]`；
   聊天转录区把它渲染成**文件卡片**（图标 + 文件名 + 元信息），点击弹出**全文预览**，
   并可**打开原始文件**（新标签页）。底层消息文本不变，会话日志与模型侧不受影响。
4. **回读**：模型通过 `read_document` 工具按 id 读取全文（支持 maxChars 截断读取）。

## 安装（开发模式）

```bash
git clone https://github.com/everalone/dsh-doc-import.git
cd dsh-doc-import
pnpm install                       # mammoth / pdfjs-dist / @napi-rs/canvas / schemastery
node scripts/link-core.mjs         # 把 dsh 核心包符号链接进工作区（与 profile 同实例）
pnpm build                         # tsc + esbuild → packages/dsh-doc-import/lib
dsh plugin --profile web add link:./packages/dsh-doc-import
# 重启 dsh web 后生效
```

> 若 `dsh plugin` 报既有依赖找不到版本（如 npmmirror 缺 `dsh-dafeiyu@0.1.6`），
> 追加官方源：`dsh plugin --profile web add link:./packages/dsh-doc-import --registry=https://registry.npmjs.org/`

### 开发循环

```bash
pnpm watch            # tsc --watch（host 改动）
pnpm watch:client     # esbuild --watch（client 改动；页面刷新后生效，无需重启）
pnpm test             # 解析器/费用/顺序算法单测
node scripts/e2e-host.mjs <pdf路径>   # 独立 HTTP 服务全链路 e2e（解析→OCR→状态→工具→raw）
node scripts/verify-live.mjs          # 对运行中的 GUI 做活体验收
```

host 改动需重启 `dsh web`；client 改动会被 client-hmr 自动热更新（刷新页面即可）。

## 设置（Settings → 插件配置 → 文档导入）

可折叠卡片，三组字段（失焦即保存，单项 ↺ 恢复默认）：

| 组 | 关键项（默认值） |
|---|---|
| 文档导入 | 上传上限 100 MiB、PDF 页数上限 2,000、CSV 解析行数 1,000 |
| OCR 识别 | 自动 OCR 开、页数上限 100、并发 3、扫描页阈值 30、模型 `deepseek-v4-flash-vision-exp`、端点 `https://api.deepseek.com`、密钥变量 `DEEPSEEK_API_KEY`（凭证服务） |
| 价格表 | 高峰/空闲 × 输入/输出单价（DeepSeek 官方价，可改）；每页图片 tokens 384 |

> `inlineCap` / `costNoticeThreshold` 为早期内联模式的保留字段（纯文件引用模式下不再内联正文）。

## 目录

- `packages/dsh-doc-import/src/` — host 半（routes/store/parsers/pdf/ocr/tool）与
  client 半（state/send-hook/preview/settings-card/ui）
- `docs/adr/` — 设计决策记录（0002 纯文件引用取代 0001 文本内联）
- `docs/roadmap.md` — 路线图（下一步：复杂页视觉重提取）
- `CONTEXT.md` — 项目词汇表

## 许可证

MIT。设计参考了 Apache-2.0 的 `@linxin666/dsh-tool-describe-image` 的**接口惯例**（工具注册、
webServer 路由、slots、发送钩子、预览增强器），未复制其源码；DSH 官方包为 MIT。
