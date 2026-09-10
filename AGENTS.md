# AGENTS.md — dsh-doc-import 协作与开发指南

> 供 AI 编码工具（DSH / Claude / Codex / Cursor 等）在**新会话**中快速上手本仓库。
> 面向"跨机器、跨 agent"协作：**先读「协作规则」和「每台机器的本地状态」两节再动手。**
> 最后更新：2026-09-10 ｜ 基准版本：v1.1（`main`）

---

## 项目一句话

DSH（DeepSeek Harness）Web 的 Cordis 双半插件：把 **txt / md / csv / docx / pdf** 拖进对话，
host 端解析并存储（扫描版 PDF 自动 OCR），消息里只出现一张**文件卡片**，模型用
`read_document` 工具分页回读全文。MIT。

功能与用法看 [`README.md`](./README.md)；术语看 [`CONTEXT.md`](./CONTEXT.md)；
设计取舍看 [`docs/adr/`](./docs/adr/)；下一步看 [`docs/roadmap.md`](./docs/roadmap.md)。

---

## 会话开始时必须做

1. 读 [`docs/PROGRESS.md`](./docs/PROGRESS.md) —— 当前进度、下一步、最近的坑
2. 读 [`docs/adr/`](./docs/adr/)（按需读相关的那一篇）—— **已定的架构决策不要推翻**；
   与既有 ADR 冲突的想法，先摆出来问，别直接改
3. `git status -sb` → `git fetch` → 需要时 `git pull --rebase`（工作区脏就先 commit 或 stash）
4. 向用户声明**你打算做什么、改哪些文件**，然后动手。
   有界确认规则：**不可逆 / 破坏性操作**（改 git 历史、`push` 到 main、删除数据或文件、
   跨模块重构、改变既有行为）必须**先确认**；范围明确的小改动直接做，不必逐条等确认。

## 会话结束前必须做

1. 更新 [`docs/PROGRESS.md`](./docs/PROGRESS.md)：本次做了什么 / 下一步是什么 / 踩了什么坑
2. 若产生了架构决策：不可逆或影响后续设计的 → 在 `docs/adr/` 新增一篇（**不改旧 ADR 的结论**，
   要推翻就新写一篇并标注取代关系）；轻量可逆的 → 记进 PROGRESS.md 的「需要注意」
3. `git status` 复核改动范围 → **小步提交**（禁止一次性巨型 commit）；优先按路径 `git add <path>`，
   用 `git add -A` 前必须确认没有夹带无关文件
4. `git push`（**没 push 的工作等于不存在**）；跨机器继续时，确认 push 成功再收工

## 禁止事项

- 禁止**无故整体重写文件**（diff 必须可 review）；确需重构时单独一次提交，并在提交信息说明原因
- 禁止改 `.env`、锁文件版本、依赖版本（除非用户明确要求）
- 禁止在两个不同目录/模块重复实现同一个模块或同一份逻辑
- 禁止 `git reset --hard`、`git push --force`、`git checkout -- .`（未经用户明确要求）
- 禁止提交 `review/`、`lib/`、`node_modules/`（`.gitignore` 是刻意的）


---

## 跨机器 / 跨 agent 协作要点

1. **唯一真相源 = GitHub `main`**（`everalone/dsh-doc-import`）。本地目录、任何 agent 的工作副本
   都只是副本；**"我这里是好的"不构成证据**，以 push 后的 `main` 为准。
2. **一个工作目录只归一个 agent / 一台机器**。若必须共用：动手前工作区必须 clean，
   改完立刻 commit + push；同一台机器不要同时开两个改同一 profile 的 DSH 会话。
3. 想"对齐远程"时用 `git fetch` + `git pull --rebase`，**永远不要用 reset**（见「禁止事项」）。
4. 提交信息用 `feat:` / `fix:` / `docs:` / `refactor:` + 一句中文说明
   （例：`fix: OCR 终态保证 + 自愈重启退避`）。**大改动别在本地堆太久**——堆三天再 push，
   下一个 agent 必然基于过期代码开工。
5. 换机器的日常：
   - 开工：`git status`（必须干净，脏就先 commit/stash）→ `git pull --rebase` → 再让 agent 动手
   - 收工：先让 agent 把交接摘要写进 [`docs/PROGRESS.md`](./docs/PROGRESS.md) → commit → push
6. 产物与本地资料不入库（`.gitignore` 是刻意的，别改）：
   `node_modules/`、`lib/`（构建产物）、`*.tsbuildinfo`、`review/`（过程性文档，只留本地）

---

## 每台机器的本地状态（天然不入库，新机器各做一次）

```bash
pnpm install                          # 依赖；canvas / esbuild 已列入 pnpm-workspace.yaml 的 allowBuilds
node scripts/link-core.mjs            # 把本机 ~/.dsh 的核心包（cordis/dsh-tools/…）符号链接进工作区
pnpm build                            # lib/ 不入库，拉下来必须构建
dsh plugin --profile web add link:<本机仓库绝对路径>/packages/dsh-doc-import
# 重启 dsh web 才会加载 host 半
```

- npm 镜像可能缺包（如 `dsh-dafeiyu@0.1.6`）→ 追加 `--registry=https://registry.npmjs.org/`。
- 插件挂载状态在 `~/.dsh/profiles/web/package.json`，**不在仓库里**，每台机器都要挂一次。
- 文档存储 `~/.dsh/storages/doc-import/<sha256>/`（机器本地、内容寻址）。换机器想复用已解析
  文档，直接拷贝该目录；否则重新拖入即可（OCR 结果按页号复用，不会重复计费）。
- **改动生效方式**：host 半改动 → 重启 `dsh web`；client 半改动 → 重新 build 后由
  `dsh-client-hmr` 热更新（刷新页面）。

---

## 目录速查

```
packages/dsh-doc-import/
├── cordis.patch.yml         # profile roster 插入行（挂载入口）
├── package.json             # dsh.bundle.patch + dsh.client 清单
├── src/
│   ├── index.ts             # host 入口：name/inject/apply；注册路由 + 工具 + 设置节
│   ├── routes.ts            # /doc-import/{attach,ocr,status,raw/<id>}（loopback-only 围栏）
│   ├── parsers.ts           # 解析器注册表 + EXTRACTOR_VERSION + 按类型分派
│   ├── pdf.ts               # pdfjs 文本层提取（视觉排序/行聚类/分栏）+ 页渲染 PNG
│   ├── ocr.ts               # 扫描页 OCR：并发/页上限/重试/自愈重启/预算与终态
│   ├── store.ts             # 内容寻址存储（original.bin / text.txt / pages.json / meta.json）
│   ├── tool.ts              # read_document 工具（offset / maxChars / totalChars 分页）
│   ├── cost.ts              # token 与费用估算（官方价格表可配）
│   ├── config.ts            # 设置节 schema（文档导入 / OCR / 价格表三组）
│   ├── http.ts              # 有界 JSON body 读写 + loopback 围栏
│   ├── shims/pdfjs.d.ts     # pdfjs 类型垫片
│   └── client/              # 浏览器半（见下）
├── test/parsers.test.mjs    # 单测（node --test）
└── lib/                     # 构建产物（不入库）
scripts/
├── build-client.mjs         # esbuild 打包 client（react 外置，交给 ModuleLoader）
├── wrap-client.mjs          # 包成 window.__ModuleLoader__.load({id, factory}) 信封
├── link-core.mjs            # 每台机器的核心包符号链接
├── e2e-host.mjs             # 独立 HTTP 服务全链路 e2e（解析→OCR→状态→工具→raw）
└── verify-live.mjs          # 对运行中的 GUI 做活体验收
```

client 半（`src/client/`）：`index.ts` 装配（注册槽位/钩子）、`state.ts` 草稿与轮询、
`send-hook.ts` 发送改写、`preview.ts` 转录区文件卡片增强 + 预览弹窗、`settings-card.tsx`
设置卡、`ui.tsx` 导入按钮与文档 chip、`locales.ts` 文案、`timing.ts` 轮询/预算常量。

---

## 关键架构决策（别当成 bug 去"修"）

- **消息只带紧凑引用，不内联全文**：`[document 名称, 类型, 页数/字符数, id: sha256]`，
  全文留在存储，模型用 `read_document` 回读。这是 ADR 0002 的决定（ADR 0001 已被取代），
  不要再改回"把全文塞进消息"。
- **用户消息文本不可改**：client 的预览增强器只改**渲染层**（把引用换成文件卡片），
  底层消息文本/会话日志/模型侧保持原样；卸载时需能还原。
- **client 产物必须是 ModuleLoader 信封**：浏览器端只认
  `window.__ModuleLoader__.load({ id, factory })`（react / react/jsx-runtime 由 shell 的
  `require` 注入）。直接下发带裸 `import 'react'` 的 ESM 会加载失败——所以有
  `build-client.mjs` + `wrap-client.mjs` 两步。
- **cordis 注入约束**：`ctx.<service>` **属性访问**要求该服务在 `inject` 数组里声明，
  否则抛 `cannot get property "X" without inject`（会让整个 web 打不开）；可选服务一律用
  `ctx.get('name')`（缺失时返回 `undefined`，安全）。host 半 `inject = ['tools','webServer']`，
  client 半 `inject = ['slots','conversation','settingsScope','locale']`。
- **存储内容寻址**：docId = `sha256(原文件字节)`。同文件重复导入命中同一条记录；
  换了提取算法就会命中旧文本——**因此改算法必须 bump `EXTRACTOR_VERSION`**
  （`parsers.ts`，当前 = 4），命中旧版本时 attach 会重新提取并按页号复用 OCR 结果。
- **OCR 结果按页持久化**（`pages.json[].ocrText`）：失败页保留待办，重新导入只补跑失败页；
  作业必有终态（ready / error），不会挂起发送；自愈重启有持久化次数上限与退避，
  预算按**剩余页数**推算（见 `ocr.ts` 与 `client/timing.ts`）。
- **费用护栏**：价格表内置 DeepSeek 官方价（高峰/空闲 × 输入/输出），设置卡可改；
  图片按每页 384 tokens 上限估算。

---

## 已知坑（都真实踩过）

1. **PDF 文本顺序**：不要依赖 pdfjs 内容流顺序（编号/后绘元素会跑到末尾）；pdfjs 的
   `transform[5]`（y）是**自下而上**的，排序要降序；`transform` 的缩放**不是 1**
   （常见 8.79），别用"缩放≈1"判断是否为普通文本，只看旋转/倾斜项。
2. **pdfjs + 画布**：必须用 `pdfjs-dist/legacy/build/pdf.mjs`（v6，内置 NodeCanvasFactory）
   搭配 `@napi-rs/canvas`；v5 的 legacy 与 @napi-rs/canvas 1.x 在 `clip(Path2D)` 上会炸。
   渲染调用是 `page.render({ canvas, viewport })`，销毁走 `loadingTask.destroy()`。
3. **会话切换会让文件卡片失效**：对话面板会被重建，预览增强器必须观察**整个 document**
   并重新发现 `[data-slot="conversation.session"]`，只在局部容器上挂 observer 会漏。
4. **pnpm 11 构建许可**：`canvas` / `esbuild` 需要 `pnpm-workspace.yaml` 的 `allowBuilds`，
   否则原生模块不编译。
5. **GitHub raw 域名在本机可能连不上**（SSL 中断）→ 用 `gh api repos/<owner>/<repo>/contents/<path> --jq .content | base64 -d` 取文件。
6. **多 agent 协作的典型事故**：本地落后 + 远程被别人推送 + 误用 `reset --hard`。
   规则见上「协作规则」。
7. **锚定类预设的首轮只有 shell**：梁神模式（`~/.dsh/.agent-presets/liangshen/agent.cordis.yml`：
   `shellTools: [bash]` + `commonTools: [str_replace_editor]`、`anchorGate: true`、
   `promotedPresentation: code`）在会话内出现首个持久 `tool/call` 之前**只暴露 bash 与编辑器**，
   `read_document`/`grep`/`glob` 都不存在。因此**引用头必须自带可读路径**
   （`~/.dsh/storages/doc-import/<id>/text.txt`，见 `store.ts` 的 `docTextPath()`）——
   只写"请调用 read_document"在首轮是空指令，模型会拿 bash 全盘搜 id 把会话卡死。
   反例警告：把 `read_document` 加进预设 `commonTools` 不可取——`tool-bootstrap` 要求
   "恰好一个 shell + 全部 commonTools 在场"，缺任一即把阶段 1 隔离**整体降级为全目录**。
8. **浏览器端草稿绝不能因切会话/重载而静默消失**：引用行是模型拿到文档的**唯一**线索，
   草稿一丢消息就退化成"裸文本"，模型只能回答"我没看到文档"（真实事故：卡片显示已就绪，
   用户切到新对话后发送，消息里没有引用）。
   - **禁止**在会话切换时清空草稿（旧实现 `clearAllDrafts()` 正是事故原因，已删除并由测试锁死）；
   - 草稿是**全局**的（跨会话可见、可发送），只在**发送成功后**清除 ready 项；
   - 页面刷新 / client 模块 HMR 重载会重置模块级状态 → 草稿镜像进 `sessionStorage`
     （`state.ts` 的 `toPersistedDrafts`/`rehydrateDrafts`；只存 id/header/状态，不存正文；
     重载后 ready 项直接可用、OCR 中的项自动续接轮询）。

---

## 测试与验证（改完必须自证）

```bash
pnpm test                                          # 单测（当前 22 项）
node scripts/e2e-host.mjs <某个 PDF 路径>            # 独立服务全链路：attach→OCR→status→read_document→raw
node scripts/verify-live.mjs                        # 活体验收（需 dsh web 在跑）；未挂载时返回非 0
```

- 改动 client 后建议自检产物信封：`grep -c '__ModuleLoader__.load' packages/dsh-doc-import/lib/client.js`
  且确认只 require `react` / `react/jsx-runtime`。
- 改文本提取/顺序：用真实样张对比（单栏 + 双栏 + 扫描页各一份），并确认
  `EXTRACTOR_VERSION` 已 bump。
- 改 host 路由：可直接 `curl -s -X POST http://127.0.0.1:3080/doc-import/attach -H 'content-type: application/json' -d '{...}'`
  验证（loopback 围栏会放行本机请求）。
- 结论里请写清"跑了什么、结果如何"，不要只说"应该没问题"。

---

## 风格约定

- TypeScript ESM，相对导入带 `.js` 扩展名（NodeNext）；注释写"为什么"，不写"做了什么"。
- 面向模型的工具描述用英文；面向用户的 UI 文案走 `client/locales.ts` 的 zh/en 双语。
- 组件 props 走槽位注入；不要在 client 里直接操作他人组件的内部 DOM（预览增强器除外，
  它是既定的呈现层方案）。
- 失败要"响"：host 端错误回结构化 JSON（`{ok:false,error:{code,message}}`），
  但插件 `apply` 的意外异常必须被捕获——**绝不能让 web 启动失败**。
