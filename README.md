# dsh-doc-import — DSH Web 文档导入插件

拖入 / 粘贴 / 选择 **txt · md · csv · docx · pdf** 文档到 DSH Web 对话窗口，插件自动：

1. 上传到 host 端解析为文本（PDF 走 pdfjs 文本层，docx 走 mammoth → markdown，csv → markdown 表格，txt/md 自动识别 UTF-8/GB18030）；
2. 无文本层的扫描版 PDF 页面**自动逐页 OCR**（`deepseek-v4-flash-vision-exp`，默认 100 页/文档上限，并发 3，费用 ≈¥0.01/页）；
3. 发送时以 `[document 文件名 (类型, 页数/字符数, id: sha256)]` 头把文本**内联进用户消息**；
4. 超过 5 万字符弹出**预计 token/费用提示**（非阻断），超过 100 万字符自动截断，模型可用 `read_document` 工具按 id 回读全文。

## 开发

```bash
pnpm install          # 安装依赖（mammoth / pdfjs-dist / @napi-rs/canvas / schemastery）
node scripts/link-core.mjs   # 把 dsh 核心包（cordis/dsh-tools/dsh-home-paths/…）符号链接进工作区
pnpm build            # tsc → packages/dsh-doc-import/lib
```

> PDF 文本层提取（EXTRACTOR_VERSION=2）用全局 (y,x) 视觉排序 + 行聚类 + 分栏检测组装阅读顺序，
> 不依赖内容流顺序；对单栏与简单两栏版式顺序正确。再次拖入同一文件会按新算法**重新提取**
> （OCR 页结果按页码复用，不重复计费）。

### 挂载到 web profile

```bash
dsh plugin --profile web add link:./packages/dsh-doc-import
# 重启 dsh web 后生效；改动后重新 build，host 改动需重启，client 改动刷新页面即可
```

> 若 `dsh plugin` 报某个既有依赖找不到版本（如 npmmirror 缺 `dsh-dafeiyu@0.1.6`），
> 追加官方源即可：`dsh plugin --profile web add link:./packages/dsh-doc-import --registry=https://registry.npmjs.org/`

### 开发循环

```bash
pnpm watch            # tsc --watch（client 改动后刷新页面；host 改动需重启 dsh web）
```

## 设置（Settings → 插件配置 → doc-import）

| 项 | 默认 |
|---|---|
| 内联字符上限 inlineCap | 1,000,000 |
| 费用提示阈值 costNoticeThreshold | 50,000 |
| 上传上限 maxUploadBytes | 100 MiB |
| OCR 开关 ocrEnabled | 开 |
| OCR 页数上限 ocrPageCap | 100 |
| OCR 并发 ocrConcurrency | 3 |
| OCR 模型 ocrModel | deepseek-v4-flash-vision-exp |
| OCR 端点 ocrBaseURL | https://api.deepseek.com |
| OCR 密钥 ocrApiKeyEnv | DEEPSEEK_API_KEY（凭证服务） |
| 单价（高峰/空闲 × 输入/输出） | DeepSeek 官方价，可改 |

## 许可证

MIT。设计参考了 Apache-2.0 的 `@linxin666/dsh-tool-describe-image` 的**接口惯例**（工具注册、
webServer 路由、slots、发送钩子），未复制其源码；DSH 官方包为 MIT。
