# 离线双语翻译（Offline Bilingual Translator）

**完全离线的双语对照网页翻译浏览器扩展** —— Bergamot 本地引擎，翻译过程零网络请求，附加 OCR 图片翻译与划词翻译。

> 官网：https://ryanlq.github.io/offline-bilingual-translator/ · 源码：https://github.com/ryanlq/offline-bilingual-translator · 许可：Apache-2.0

> `Linguist 的离线引擎方案 + KISS Translator 的双语对照体验 + 沉浸式翻译的图片翻译`

## 功能特性

| 功能 | 说明 |
|------|------|
| **网页双语对照** | 译文块按段落插入原文下方，Shadow DOM 样式隔离；悬停译文高亮原文；字号/颜色可配置；`Alt+Shift+T` 快捷开关 |
| **en↔zh 双向内置** | 首次使用引导下载模型（Mozilla 官方渠道，约 45 MB/方向），SHA-256 校验后缓存 IndexedDB，永久离线可用 |
| **OCR 图片翻译** | `Alt+Shift+O` 框选屏幕区域，或右键图片"OCR 翻译此图片"；Tesseract.js 识别 → Bergamot 翻译 → 结果浮窗 |
| **划词翻译** | 选中文本自动弹出译文小窗；工具栏弹窗与设置页均有开关（默认开启、即时生效），关闭时右键菜单项同步置灰；仅当选中内容属于翻译源语言时弹出。右键菜单「翻译选中文本」按选中文本实际语言取方向 |
| **完全离线** | 引擎 + 模型全在本地，翻译零网络请求（详见 PRIVACY.md） |
| **更多语言包** | 设置页「语言包」卡片点击 **更多语言包**，从 Bergamot 官方仓库按需下载 20 个语言对（法/德/西/俄/乌/捷克等，约 20–37 MB/个）。安装后自动出现在「翻译方向」下拉，可用于网页对照、划词与 OCR 翻译；下载后仍是完全离线 |

## 安装使用（开发者模式加载）

1. 下载或解压发布包（`dist/offline-bilingual-translator-v*.zip`，由 `node tools/package.mjs` 生成）
2. 打开 Chrome/Edge 116+ → `chrome://extensions`（Edge 为 `edge://extensions`）
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压后的目录
5. 点击工具栏图标 → **下载模型**（如"英语 → 中文"，约 45 MB，一次性）
6. 在任意英文网页按 `Alt+Shift+T`，体验双语对照翻译
7. 需要其它语言：设置页 → 语言包 → **更多语言包** → 下载 → 在「翻译方向」中选用

> 语言包只在**下载那一刻**联网；翻译过程零网络请求。官方索引拉取失败时会回退到上次缓存，已安装的语言包不受影响。

## 项目官网（GitHub Pages）

静态站点源码在 `docs/`，由 GitHub Pages 从 `main` 分支的 `/docs` 目录直接发布：无需构建、无外部 CDN、无字体请求，中英双语可切换。

| 页面 | 地址 | 用途 |
|------|------|------|
| 首页 | https://ryanlq.github.io/offline-bilingual-translator/ | 功能介绍、双语对照演示、安装步骤、工作原理、FAQ |
| 隐私政策 | https://ryanlq.github.io/offline-bilingual-translator/privacy.html | **Chrome / Edge 商店表单要填的公开隐私政策 URL** |

部署方式：仓库 `Settings → Pages → Build and deployment` 选 `Deploy from a branch`，分支 `main`、目录 `/docs`；配置一次后每次 push 自动更新。`docs/.nojekyll` 用于跳过 Jekyll 处理。本地预览：

```bash
python -m http.server 8000 --directory docs   # 打开 http://localhost:8000/
```

## 发布到扩展商店（Chrome / Edge）

同一个 `dist/offline-bilingual-translator-v0.1.0.zip`（manifest.json 位于 zip 根目录，约 7.5 MB）可**同时**提交两家商店；Chrome 包上限 2 GB。**上传与提交必须用你自己的开发者账号在浏览器里完成**，本节只负责备好包与填写文案。

官方入口：

| 平台 | 注册 | 发布流程 | 商店资料 |
|------|------|----------|----------|
| Chrome Web Store | [注册开发者账号](https://developer.chrome.com/docs/webstore/register)（一次性 **$5**） | [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)（你要找的就是这个） | [Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) · [Privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) |
| Microsoft Edge Add-ons | [注册开发者账号](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)（**免费**，需 MSA） | [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)（8 步，认证最多 7 个工作日） | 同页 Step 5–8 |

流程对照：Chrome 走 Developer Dashboard → `Add new item` → 传 zip → 填 Store listing / Privacy / Distribution / Test instructions → `Submit for Review`；Edge 走 Partner Center → `Create new extension` → 传 zip → Availability / Properties / Privacy / Store listings → `Publish`。Chrome 支持审核通过后延迟发布（30 天内有效）。

**Edge 账号类型**：Partner Center 的 Microsoft Edge 计划允许 `Individual`（个人）账号发布扩展，**不需要企业资质**，且注册免费；个人账号只验证「发布者显示名」是否可用，审核较短。`Company`（公司）账号才需要注册企业名、公司审批人、DUNS / 政府文件，验证可能耗时数天到数周。注册时必须使用**个人 Microsoft 账户（MSA）**，也可用个人 GitHub 账号登录（会自动创建 MSA）；官方明确「不支持工作或学校账户注册」——这点最容易被误读成「必须企业」。`Account type` 与 `Account country/region` 注册后均不可更改，且不支持从 Company 改回 Individual，勿选错。

注册表单里的「请使用你注册的法定企业名称、地址、电话和官方电子邮件地址」「发布者显示名称（公司名称）」是 **Partner Center 通用模板文案，个人账号同样会看到**，不代表要求营业执照：官方对「须用注册企业名 / 企业邮箱」的说明都带 `For company accounts` 前提。个人账号在这里填自己的名字或网名即可（≤50 字符、需未被占用），地址电话填个人真实信息。判断当前类型的可靠依据是 `Account type` 那一步的选择，以及表单是否出现「公司审批人 / Company approver」一栏——该栏只在选 `Company` 时才出现。若这个 MSA 此前注册过 Windows 应用开发者账号且为公司类型，Edge 计划会自动沿用其资料；由于不支持改回个人，最省事的做法是换一个新的个人 MSA 重新注册。

中国区常见坑：国家选 China 时 `State/Province` 需手动输入**大写缩写**（如 `BJ` / `SH`），填全称会静默失败——点 Finish 后又回到表单且不报错（微软官方 Q&A 已确认）。若注册流程把你导向付费页面，多半是误入了 Microsoft Store 应用/游戏开发者账号入口；Edge 扩展计划本身不收费，先停下核对入口。

**包校验（Package Validation）**：上传 zip 后商店会逐 locale 校验 manifest 字段长度，`short_name` 最多 **12 个字符**、`name` 最多 75 个字符（按字符数，不是字节数）。`_locales/en/messages.json` 的 `extShortName` 原为 `"Offline Translator"`（17 字符），Edge 因此报 `The translation for field ShortName in locale en is too long ... exceeds maximum size limit of 12 characters`；现已改为 `"OffTrans"`（8 字符），中文「离线双语翻译」6 字符一直合规。`tools/check.mjs` 已加逐语言包的长度校验，以后改文案不用等上传才发现。

### 提交清单

| 材料 | Chrome | Edge | 当前状态 |
|------|--------|------|----------|
| zip 包 | 必需 | 必需 | ✅ 已生成，双店通用 |
| 128×128 商店图标 | 必需 | 可作 logo | ✅ `assets/icons/icon-128.png` |
| 300×300 方形 logo | — | **每种语言必需** | ✅ `store-assets/logo-300.png` |
| 440×280 / 1400×560 宣传图 | 可选 | 可选 | ✅ `store-assets/` |
| **至少 1 张 1280×800 截图** | **必需**（最多 5 张） | 可选（最多 6 张） | ❌ 需真机截图，不能用示意图 |
| 详细商品描述 | 必填 | **每种语言 250–10000 字符** | ❌ 需撰写 |
| 简短描述 | 取自 manifest `description`（只读） | 同左（只读） | ✅ 已在 `_locales`，已去掉"中英"定语 |
| 分类 | 必填（建议 Accessibility / Productivity） | 必填 | ❌ 提交时选择 |
| 隐私政策 URL | 有 host_permissions 时必需 | 涉及个人信息时必需 | ✅ https://ryanlq.github.io/offline-bilingual-translator/privacy.html |
| 单一用途 / 权限理由 / 远程代码 / 数据使用 | Privacy 页逐项填 | Privacy 页逐项填 | ✅ 文案见下 |
| 测试说明 | Test instructions | Notes for certification | ✅ 文案见下 |

图标素材来自 `tools/icon-source.png`（1254×1254 透明底插画）。生成脚本会重建 alpha 蒙版去掉抠图残留的彩色杂边，再居中裁成正方形；16/32 额外做中心裁切放大「中 / A」主体，避免缩成一团。换素材时依次运行 `python tools/make-icons.py`、`python tools/make-store-assets.py` 即可同步全部尺寸、商店 logo 与两张宣传图；首次运行会把旧素材备份到 `.icon-backup/`（已加入 `.gitignore`）。

> 注意：包里 `_locales/zh_CN` 与 `_locales/en` 两个语言目录会让 Edge 的 Store listings 出现**两行**，每行都要单独填 250+ 字符描述与上传 300×300 logo（可用页面上的 Duplicate 复制素材）。Chrome 的本地化描述则是可选但建议补齐。

### 可直接粘贴的审核文案

Edge 的 Privacy 页与 Chrome 的 Privacy practices 都是英文表单，审核员按英文阅读，建议**直接填英文**；理由要具体到功能并写明数据留在本地，不要写 "needed for the extension to work" 这类空话。

**① Single purpose description**（只讲一个用途，划词/OCR 作为同一功能的入口）

> Translate the text of web pages into a bilingual view entirely on the user's device, by inserting the translated paragraph directly beneath the original one. Selection translation and image OCR are two ways of invoking this same translation feature. All inference runs in the bundled Bergamot WASM engine; no page content is ever transmitted to a server.

**② Permission justification（每个框单独粘贴）**

| 表单字段 | 英文理由 |
|------|------|
| `offscreen` | MV3 service workers have no DOM. The bundled Bergamot WASM engine and the Tesseract.js OCR worker need a hidden offscreen document as their runtime host. It contains no remote code and is never shown to the user. |
| `storage` | Stores only the user's own preferences (font size, colors, translation direction, selection-translation toggle) and the list of installed language packs in chrome.storage.local. Nothing is synced or uploaded. |
| `unlimitedStorage` | Language models are about 45 MB per direction (up to ~37 MB for each extra pack) and are cached in IndexedDB so translation works offline; this exceeds the default extension storage quota. Files are public, SHA-256 verified and removable from the options page. |
| `contextMenus` | Adds two context-menu entries, "Translate selected text" and "OCR this image", so the user can translate a selection or an image in place. The first entry is disabled when the user switches the selection popup off in settings. |
| `activeTab` | Identifies the tab in which the user clicked the toolbar button or pressed a keyboard shortcut, so the page-translation toggle is delivered to that tab only. No URL, title or history is read. |
| `tabs` | Used only for chrome.tabs.query({active:true,currentWindow:true}) to obtain tab.id / windowId for messaging, and chrome.tabs.captureVisibleTab to capture the screen region the user explicitly drags for OCR. The extension never reads tab.url or tab.title, never builds browsing history, and the captured image is cropped and processed in memory only. |
| `declarativeNetRequest` | Installs one dynamic rule that rewrites the User-Agent header for requests to firefox-settings-attachments.cdn.mozilla.net, because that CDN returns HTTP 406 to a Chrome UA. The rule matches no page URL and inspects no request or response content. |
| `Host permission` | Four public static-file hosts are contacted only when the user first installs a resource: Mozilla Remote Settings (index + en/zh models), the Bergamot S3 model index/models, and tessdata.projectnaptha.com (OCR language data). Downloads are SHA-256 verified and cached locally; requests contain no page content, user identifier or browsing activity. No translation request is ever sent to these hosts. |
| `content_scripts` / `<all_urls>`（若表单另列） | The content script must run on whichever page the user chooses to translate, to read paragraph text and insert the translation beneath it. It reads text only, never writes to storage or the network, and skips its own injected nodes. |

**③ Remote code**：选 `No, I am not using remote code`。所有 JS / WASM 随包分发；运行时只下载模型二进制与 OCR 训练数据（数据文件，非可执行代码），CSP 为 `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`。若 Justification 框可编辑，补一句：

> All JavaScript and WASM are bundled in the package. The only runtime downloads are static model binaries and OCR training data (data files, never evaluated as code). The CSP forbids any other script source, and there is no analytics, A/B or remote-config SDK.

**④ Data usage（复选框怎么选）**

**只勾 `Website content`，其余 8 项全部不勾**；下方 `I certify that the following disclosures are true` 的 3 条（不出售给第三方 / 不用于与功能无关的目的 / 不用于信用评估）**全部勾上**。

依据：扩展为翻译必须读取当前网页文本，OCR 时还会截取用户框选的屏幕区域，这属于「website content」；Chrome User Data FAQ 第 3 条明确「即使数据只在本地处理、不传外部服务器，也必须披露」。但这些数据只在内存中即时处理、不落盘、不上传、不留存，所以不申报 PII / 健康 / 财务 / 认证 / 通讯 / 位置 / Web history（代码从不读 `tab.url`/`tab.title`，不建浏览历史）/ User activity（mouseup 与选区只用于即时触发功能，不做记录或日志）。

> 保守备选：若审核员认为框选 OCR 的鼠标坐标也算 "User activity"，按其要求补勾该项即可，不影响其它声明。切勿为了图省事勾满或全不勾——表单里没有「不收集任何数据」这个选项，且漏报 Website content 属于 inaccurate disclosure，是常见驳回原因。

**⑤ Privacy Policy URL**：`https://ryanlq.github.io/offline-bilingual-translator/privacy.html`。政策页已按上述口径写明「本地读取但不收集/不传输」，与表单声明一致。

**测试说明 / Notes for certification**
> 1. 加载扩展后点工具栏图标 →「下载模型」（约 45 MB，**首次需联网**）。
> 2. 打开任意英文文章页按 `Alt+Shift+T`，译文块应出现在原文段落下方。
> 3. 选中一段英文 → 弹出译文小窗；设置页可关闭该开关。
> 4. 按 `Alt+Shift+O` 框选屏幕区域 → OCR 识别并翻译，结果浮窗显示（首次需下载识别数据）。
> 5. 之后断网复测，页面翻译仍可用。
>
> 提示：若未先下载模型，翻译会提示缺少语言包；这是预期行为，不是故障。

## 技术架构

```
┌─────────────────────┐   chrome.runtime    ┌──────────────────────┐
│  Content Script      │ ──────────────────→ │  Service Worker       │
│  · 段落提取           │                     │  · 模型下载/缓存       │
│  · 译文块注入         │ ←────────────────── │  · 翻译编排            │
│    (Shadow DOM)      │                     │  · 截屏/右键菜单       │
│  · 划词/OCR 交互      │                     └──────────┬───────────┘
└─────────────────────┘                                │
                                            ┌──────────▼───────────┐
                                            │  Offscreen Document   │
                                            │  · Bergamot Worker    │──→ vendor/bergamot
                                            │  · Tesseract.js OCR   │    (WASM 引擎，MPL-2.0)
                                            └──────────────────────┘
                                                     │ IndexedDB（模型缓存）
```

关键技术点：

- **Bergamot WASM（v0.4.5，5 MB）**：浏览器内运行的神经机器翻译引擎（marian 的 WASM 移植）
- **enzh shortlist 规避**：中文模型 lex 表与文档级 shortlisting 冲突（mozilla 官方配置已注释掉 shortlist），加载 enzh 模型时传 null shortlist，已实测验证
- **模型来源**：Mozilla Remote Settings（Firefox 翻译功能官方渠道，带 SHA-256 校验）
- **Offscreen Document**：MV3 Chromium 中 Worker 生命周期不可控，与 Linguist 相同改由 offscreen 文档承载
- **段落级提取 + 译文块注入**：自研实现（KISS Translator 仅参考交互思路，未复制代码）
- **DecompressionStream**：模型文件的 gzip 解压

## 目录结构

```
├── manifest.json           # MV3 清单
├── src/
│   ├── background/         # Service Worker：模型下载、翻译编排、OCR 编排
│   ├── offscreen/          # Offscreen 文档：引擎宿主
│   ├── workers/            # Bergamot Worker（null-shortlist 支持）
│   ├── content/            # 内容脚本：双语注入、划词、OCR 交互
│   ├── popup/              # 工具栏弹窗
│   ├── options/            # 设置页（样式/语言包/OCR/关于）
│   └── shared/             # RPC 协议、模型注册表、设置
├── vendor/
│   ├── bergamot/           # Bergamot WASM 引擎（MPL-2.0，原样分发）
│   └── tesseract/          # Tesseract.js（Apache-2.0）
├── tools/
│   ├── check.mjs           # 静态自检（清单/语法/权限/本地化/Shadow DOM 回归）
│   ├── package.mjs         # 打包 dist/*.zip（打包前必过 check）
│   ├── verify-language-packs.mjs # 实测语言包：索引转换 / 下载 SHA-256 / WASM 引擎翻译
│   ├── icon-source.png     # 图标源图（1254×1254 透明底，不进发布包）
│   ├── make-icons.py       # 源图 → 各尺寸扩展图标 + logo-300 + 512 母版
│   └── make-store-assets.py # 用 512 母版生成两张宣传图（需 Pillow，不进发布包）
├── docs/                   # GitHub Pages 站点（index.html / privacy.html / assets/）
├── store-assets/           # Chrome Web Store / Edge Add-ons 上架素材
├── dist/                   # 打包产物（.gitignore 忽略）
├── LICENSE                 # Apache-2.0 全文
├── NOTICE                  # 版权与第三方声明
├── THIRD_PARTY_NOTICES.md  # 第三方署名与合规清单
└── PRIVACY.md              # 隐私说明（在线版见 docs/privacy.html）
```

## 工程质量自检

```bash
node tools/check.mjs          # 9 项静态检查，非 0 退出即有问题
node tools/package.mjs        # 自检 → 暂存 → dist/offline-bilingual-translator-v0.1.0.zip
node tools/verify-language-packs.mjs              # 需联网：实测 ende + fren 两个语言包
node tools/verify-language-packs.mjs --pairs=uken # 指定语言对；--fresh 强制重下
python tools/make-icons.py         # 可选：由 tools/icon-source.png 重生成全部尺寸图标
python tools/make-store-assets.py  # 可选：用 512 母版重生成两张宣传图（先跑上一条）
```

`check.mjs` 覆盖 Chrome 只在加载/运行时才暴露的问题：manifest 引用文件缺失、
JS 语法错误、相对 import 失效、`__MSG_*__` 文案缺语言包、模型域名不在
host_permissions、content_scripts 首脚本顺序、**closed Shadow DOM 上误用
`.shadowRoot`**（该写法恒为 null，曾导致注入层整体崩溃），以及逐 locale 的
商店字段长度校验（`short_name` ≤12、`name` ≤75 字符）。

## 验证记录（开发期实测）

### P0：Node 引擎验证

开发期用一次性脚本（Node）实测引擎 + enzh 模型（v2.2，Remote Settings 官方渠道，SHA-256 校验通过）：

```
== 1. 加载 Bergamot WASM 引擎 ==  26ms
== 4. 用例: enzh 无 shortlist（mozilla 官方推荐） ==
原文: Hello, world!
译文: 你好,世界!
原文: Machine translation runs completely offline in your browser.
译文: 机器翻译在您的浏览器中完全离线运行。
3 句翻译耗时: 382ms
```

### 端到端：真实 Chrome（Chrome for Testing 144）

开发期用 CDP 驱动扩展真实环境（脚本为一次性验证用，未随仓库分发），验证完整管线
（页面 rpcCall → Service Worker 编排 → offscreen 文档主线程引擎 → 译文返回）：

```
· enzh 模型状态: {"installed":true,"totalSize":45428743}   # IndexedDB 缓存命中
· 翻译耗时: 729ms   # 首次（模型组装 + 引擎加载 + 翻译）
· 二次翻译耗时: 487ms  # 热路径

=== 翻译结果 ===
你好,世界!
机器翻译在您的浏览器中完全离线运行。
点击下载按钮获取翻译型号。
```

zhen 反向方向（`models:download` 真实下载 ~45MB，带进度事件，SHA-256 校验 + shortlist 模式）同样通过：

```
== 下载 zhen 语言包 ==
model.zhen.intgemm.alphas.bin / vocab.zhen.spm / lex.50.50.zhen.s2t.bin 均 100%
== zhen 翻译 ==  458ms
"机器翻译完全在本地浏览器中运行，无需联网。"
  → "Machine translation runs entirely in the local browser without networking."
"深度学习模型让你的浏览器变成翻译器。"
  → "Deep learning models turn your browser into a translator."
```

### 更多语言包：Node 端到端实测（2026-11-15）

`tools/verify-language-packs.mjs` 拉取 Bergamot 官方 `index.json`，用扩展里真实的
`buildExtraRegistry` 转换，下载所选语言包的全部文件、逐个校验字节数与 SHA-256，
再用 `vendor/bergamot` 的 WASM 引擎在 Node 中加载并翻译一句（与 offscreen 侧
`loadTranslationModel` 同一套配置）：

```
索引来源 remote，共 20 个语言包全部通过格式校验（单 vocab 18 / 双 vocab 2 / 带 config 2）
ende（英语 → 德语）  3 个文件 · 21.9 MB · sha256 全部匹配
fren（法语 → 英语）  3 个文件 · 26.8 MB · sha256 全部匹配
uken（乌克兰语 → 英语）4 个文件 · 37.1 MB · sha256 全部匹配   # 双词表 + int8shiftAll

ende "The weather is nice today." → "Das Wetter ist heute schön."
fren "Bonjour le monde"          → "Hello world"
uken "Привіт, світе"             → "Hi, World"
```

`uken` 单独测是因为它是 20 个里唯一不同的形态：`srcvocab/trgvocab` 双词表 +
`intgemm8.bin`，需要把索引里的 `config.gemm-precision` 透传到引擎，否则精度错误。

**端到端过程中定位并修复的关键问题**（对同类项目有参考价值）：

1. **RPC 协议缺陷**：`rpcCall` 仅监听广播式响应，而 `rpcListen` 用 `sendResponse`
   直接回传——跨上下文调用全部挂起。已改为从 `sendMessage` 的直接响应取结果。
2. **模型缓冲区跨上下文传输**：数十 MB 的 ArrayBuffer 经 `chrome.runtime`
   消息传输会被 JSON 序列化破坏（SentencePiece 报 `unk is not defined` 后
   引擎 abort）。已改为向 offscreen 传文件清单，由其自行从 IndexedDB 读取。
3. **MV3 默认 CSP 阻止 WASM**：offscreen 文档需在 manifest 中声明
   `script-src 'self' 'wasm-unsafe-eval'`（官方许可方式）。
4. **模型 CDN 对 Chrome UA 返回 406**：通过 declarativeNetRequest 将该域名的
   User-Agent 改写为 Firefox UA（仅影响模型 CDN，不影响任何页面）。
5. **closed Shadow DOM 反模式**：`attachShadow({mode:'closed'})` 后
   `element.shadowRoot` 恒为 `null`，注入器曾因此在第一段就抛 TypeError，
   页面翻译整体不可用。改为自持 root 引用，并在 `tools/check.mjs` 加了静态回归检查。
6. **每批翻译重复装配模型**：`translateTexts` 每次都触发 `engine:ensureModel`，
   offscreen 便反复 `new TranslationModel`（每次数十 MB，旧实例不释放）。
   现由 Service Worker 与 offscreen 两侧共同记录已加载语言对，热路径只做一次查找。

## 许可合规

本项目自有代码采用 **Apache-2.0**（[LICENSE](LICENSE) / [NOTICE](NOTICE)）。选它而不是继续用 BSD-3-Clause，是因为捆绑的 OCR 引擎本身就是 Apache-2.0，且 Apache-2.0 带明确的专利授权条款；MPL-2.0 与 CC-BY 组件以文件级方式共存、各自保留原许可。第三方署名与义务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

| 组件 | 许可 | 分发方式 |
|------|------|---------|
| Bergamot WASM | MPL-2.0 | 原样分发，未修改 |
| `src/workers/bergamot-worker.js` | **MPL-2.0** | 改编自上游，文件级 copyleft 保持 MPL-2.0，不随主项目改授 |
| en↔zh 模型 | CC-BY（Mozilla） | 运行时下载 |
| 其他语言包 | CC-BY 等（Bergamot 官方仓库） | 用户在「更多语言包」按需下载，不随包分发 |
| Tesseract.js | Apache-2.0 | 原样分发 |
| Linguist | BSD-3-Clause | 仅参考架构，少量封装片段保留署名 |
| KISS Translator | GPL-3.0 | 仅参考思路，零代码复制 |

## 已知限制与后续路线

- **MVP 阶段**：桌面 Chrome/Edge 116+（`chrome.runtime.getContexts` 要求）；内置 en↔zh 双向，其余语言对按需从「更多语言包」下载（仅覆盖 Bergamot 官方仓库现有的 20 个语言对）
- **Firefox 支持（后续计划，当前包不兼容）**：Firefox 的 MV3 用 event page 而非 `background.service_worker`，且没有 `chrome.offscreen` API / `offscreen` 权限，而本项目的引擎、模型缓存与 OCR 全部跑在 offscreen 文档里。Firefox 后台页自带 DOM，可直接承载引擎，因此不需要 offscreen。移植待办：拆两份 manifest、加一层 DOM 宿主适配、封装 `browser.*` 命名空间、跳过 CDN UA 改写规则、加 `browser_specific_settings.gecko` ID 并做 AMO 签名。
- 官方仓库之外的语言对（如 ja→zh 需经日→英→中中转）仍需手工在 `src/shared/models-registry.js` 补充条目；「更多语言包」只列官方索引里的单向语言对
- 「更多语言包」列表首次展开需联网拉取索引；索引失败且无本地缓存时列表为空，已安装语言包仍可离线使用
- **closed Shadow DOM 站点无法翻译**（如部分用 Web Components 重构的页面）：
  收集器会穿透 open Shadow Root，但 closed root 无法枚举，属浏览器安全边界
- OCR 中文识别准确率依赖 Tesseract，不足时可升级 PaddleOCR ONNX
- 模型 CDN（Mozilla）国内可达性存在不确定性，可在设置中自建 langPath/镜像
- 后续可选：zh→en 质量增强（NLLB-600M q8）、YouTube 双语字幕、云端引擎兜底开关

## 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| OCR 报 `importScripts … tesseract-core-*-lstm.wasm.js failed to load` | 发布包缺少 LSTM 核心（v5 按引擎类型分 4 个核心文件，缺一不可），用 `node tools/package.mjs` 重新打包 |
| 个别页面按 Alt+Shift+T 无反应 | 该页为 chrome:// 等受限页，或内容在 closed Shadow DOM / 跨域 iframe 内 |
| 首次翻译报「暂无 … 语言包」 | 到弹窗或设置页先下载对应方向的语言包（内置约 45 MB，官方仓库约 20–37 MB，一次性） |
| 「更多语言包」列表为空 | 首次展开需联网拉取官方索引；点「刷新列表」重试。已安装语言包不受影响，仍可离线使用 |
| 切换语言包方向后译文没变 | 正常情况下页面翻译会自动按新方向重启；若页面脚本被浏览器回收，重新按一次 `Alt+Shift+T` |
