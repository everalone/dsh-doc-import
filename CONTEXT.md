# DSH 文档导入插件（dsh-doc-import）

一个 DeepSeek Harness Web 插件，让用户把文档（txt/md/pdf/docx 等）拖入对话窗口，由插件自动解析并把内容送入模型，用户全程无需复制路径或手工处理。

## Language

**文档导入 (Document Import)**:
把文档文件拖入/粘贴进对话窗口、由插件接管后续解析与入模的完整动作。
_Avoid_: 上传文件、附件上传（指图片管线）

**解析 (Extraction)**:
把文档字节转为模型可读文本的动作，按格式分派解析器（pdf 文本层、docx→markdown 等）。
_Avoid_: 读取、加载

**OCR 回退 (OCR Fallback)**:
当 PDF 文本层缺失或过少（扫描件）时，自动把页面转图并交给视觉模型识别文本的动作。
_Avoid_: 图像识别、识图

**全文回读 (Full-Text Readback)**:
模型通过 read_document 工具按文档 id 重新获取完整解析文本（不占用消息内联额度）的动作。
_Avoid_: 重读、再解析

## 已定决策（v1）

- 形态：独立 Cordis 插件（host 半 + client 半），零核心改动；复用 `@linxin666/dsh-tool-describe-image` 的挂载/路由/发送钩子模式。
- 流程：拖入 → 上传 → host 端解析 → 文本内联进用户消息；扫描版 PDF 自动 OCR 回退，无需用户干预。
- v1 格式范围：txt、md、pdf、docx、csv（解析器注册表分派，doc/xlsx/pptx/rtf 延期 v2）。
- OCR 策略：逐页混合（有文本层的页保留文本，无文本/空白页才转图 OCR）；OCR 模型默认 `deepseek-v4-flash-vision-exp`（DeepSeek 官方端点，已验证存在），端点/模型/密钥可在设置中改。
- 内联策略（ADR 0002 取代 ADR 0001）：消息只放紧凑文件引用 `[document 名称, 类型, 页/字符, id: sha256]`，全文经 read_document 回读；界面把引用渲染为文件卡片（点击弹全文预览 + 打开原始文件）。
- OCR 护栏：导入后自动执行；单文档 OCR 页数上限默认 100 页（可配），超出的页跳过并警告；页级并发 3，失败重试 1 次；进度与预计费用实时显示。
- 费用估算：按 DeepSeek 官方定价内置（v4-pro：输入 ¥4.5/9.0·M、缓存命中 ¥0.15/0.30·M、输出 ¥13.5/27.0·M；flash-vision-exp：输入 ¥1.5/3.0·M、输出 ¥4.5/9.0·M；图片每张 ≤384 tokens；高峰=北京时间工作日 9–12/14–18），价格表可在设置中修改。
- 许可证：`@linxin666/dsh-tool-describe-image` 为 Apache-2.0，官方 DSH 包为 MIT。本插件只参考其接口惯例、代码原创，自选 MIT；若个别文件实质派生则保留 Apache-2.0 头 + NOTICE。可公开到自有仓库。
