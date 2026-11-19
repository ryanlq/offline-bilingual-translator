# Chrome Web Store 提交指南（离线双语翻译 v0.1.0）

> 一次提交所需的全部材料与逐字段填写说明。所有文案可直接复制粘贴。
> 官方流程文档：https://developer.chrome.com/docs/webstore/publish

## 材料总览（全部就绪 ✅）

| # | 商店要求 | 规格 | 文件 / 内容 | 状态 |
|---|---------|------|------------|------|
| 1 | 扩展包 zip | manifest 在根目录，≤2GB | `dist/offline-bilingual-translator-v0.1.0.zip`（7.6MB，41 条目，正斜杠路径） | ✅ |
| 2 | 商店图标 | 128×128 PNG | `store-assets/store-icon-128.png` | ✅ |
| 3 | 截图 | **至少 1 张** 1280×800（最多 5 张） | `store-assets/screenshots/zh/` 4 张、`en/` 3 张（见下） | ✅ |
| 4 | 小宣传图（可选） | 440×280 | `store-assets/promo-small-440x280.png` | ✅ |
| 5 | 大宣传图（可选） | 1400×560 | `store-assets/promo-large-1400x560.png` | ✅ |
| 6 | 详细描述 | 每语言区域一份 | 本文档 §3 | ✅ |
| 7 | 类别、语言 | 下拉选择 | 本文档 §3 | ✅ |
| 8 | 单一用途说明 | 英文 | 本文档 §4.1 | ✅ |
| 9 | 每项权限的理由 | 英文 | 本文档 §4.2 | ✅ |
| 10 | 远程代码声明 | 选 No | 本文档 §4.3 | ✅ |
| 11 | 数据使用披露 | 勾选框 | 本文档 §4.4 | ✅ |
| 12 | 隐私政策 URL | 公网可达 | https://ryanlq.github.io/offline-bilingual-translator/privacy.html | ✅ |
| 13 | 开发者账号 | 一次性 $5 | 需你本人注册（下节） | ⬜ 你操作 |

**仍需你本人完成的只有**：注册账号（$5 信用卡/借记卡）、上传 zip、粘贴以下文案、点 Submit。

---

## 1. 注册开发者账号（一次性）

1. 打开 https://chrome.google.com/webstore/devconsole/register
2. 用 Google 账号登录 → 支付 **$5** 一次性注册费（需信用卡/借记卡）
3. 填写开发者信息：姓名、邮箱（审核通知用，不会公开）
4. 邮箱验证通过后即可进入 [Developer Dashboard](https://chrome.google.com/webstore/devconsole)

> 账号类型个人即可，无需企业资质。

## 2. 上传扩展包

Dashboard 右上角 **+ Add new item** → 上传 `dist/offline-bilingual-translator-v0.1.0.zip`。

> 包已通过 `node tools/check.mjs` 9 项静态检查；zip 由 `node tools/package.mjs` 生成
> （纯 Node 实现，条目路径全部为正斜杠——PowerShell Compress-Archive 的反斜杠路径会被商店解包失败，已修复）。

上传后商店会自动读取 manifest 的名称、简短描述（zh_CN/en 两个 locale）、图标。

## 3. Store listing（商品详情）

### 图形资源

- **Store icon**：上传 `store-assets/store-icon-128.png`
- **Screenshots（按语言区域分别上传）**：

| 语言区域 | 文件（`store-assets/screenshots/`） | 内容 |
|---------|------|------|
| 中文（zh_CN） | `zh/01-bilingual-hero.png` | 维基百科英文页双语对照（英文段落下插中文译文） |
| 中文 | `zh/02-selection-popup.png` | 划词翻译：选中文本弹出原文+译文小窗 |
| 中文 | `zh/03-ocr-result.png` | OCR：识别页面标题 "Machine translation" → 机器翻译 |
| 中文 | `zh/04-options.png` | 设置页：语言包管理（内置 2 个 + 官方仓库 20 个） |
| 英文（en） | `en/01-bilingual-hero.png` | 中文维基页双语对照（中文段落下插英文译文） |
| 英文 | `en/02-selection-popup.png` | 划词翻译：选中中文弹出英文译文 |
| 英文 | `en/03-ocr-result.png` | OCR：识别"机器翻译，完全离线运行" → the Completely Offline Translator |

  全部为 1280×800 真机截图（Chromium + 真实扩展运行，模型真实翻译），由 `tools/shots.mjs` 生成，可随时复跑。
- **Small promo tile 440×280**（可选，影响商店推荐位展示）：`store-assets/promo-small-440x280.png`
- **Promo video**（可选）：无，跳过

### 商品详情字段

- **Category**：`Productivity`（备选 `Accessibility`；二选一均可）
- **Language**（列表显示语言）：默认 English + 简体中文（跟随 `_locales`，两个都保留）

### 详细描述（Detailed description）

页面顶部下拉切换语言区域，分别粘贴：

**中文（zh_CN）——粘贴以下全文：**

```text
离线双语翻译是一款完全在浏览器本地运行的双语对照网页翻译扩展。它由 Mozilla Bergamot WASM 翻译引擎驱动，把译文按段落显示在原文下方，原文始终保留，方便对照阅读与核对术语；译文使用独立的 Shadow DOM 渲染，不会破坏原网页的样式、布局与交互。翻译过程不产生任何网络请求，也不需要账号、密钥或云端服务。

主要功能

- 网页双语对照：点击工具栏按钮或按 Alt+Shift+T 开关当前页面的对照翻译；自动识别段落、标题、列表项与表格单元格；鼠标悬停译文可高亮对应原文。
- 划词翻译：选中文字后弹出译文小窗，默认开启，可在工具栏弹窗或设置页即时关闭；仅当选中内容符合当前翻译源语言时才出现。右键菜单「翻译选中文本」可对任意选区显式调用。
- 图片与屏幕 OCR 翻译：按 Alt+Shift+O 框选屏幕任意区域，或右键点击网页图片选择「OCR 翻译此图片」；Tesseract.js 在本地识别文字，再由离线引擎翻译，结果以浮窗显示。
- 更多语言包：默认英→中，内置英中双向模型；设置页「更多语言包」可从 Bergamot 官方仓库按需下载约 20 个语言对（法、德、西、俄、乌、捷克等，单个约 20–37 MB）。安装后自动加入「翻译方向」下拉，可用于网页对照、划词与 OCR 翻译，随时可删除。
- 可自定义：译文字号、颜色、悬停高亮、翻译方向、划词开关、OCR 识别语言，以及用 CSS 选择器排除不想翻译的页面区域。

离线与隐私

首次使用需要联网下载语言模型（约 45 MB/方向）、所选语言包或 OCR 识别数据，下载来自 Mozilla / Bergamot / Tesseract 官方源，均带 SHA-256 完整性校验并缓存在浏览器本地，之后可完全断网使用。为生成译文，扩展会在本机读取当前网页的文字与 OCR 时你框选的屏幕区域，这些内容只在内存中即时处理，不落盘、不上传、不留存；无统计分析、遥测、崩溃上报、账号体系与翻译历史。设置与模型保存在扩展私有存储中，卸载即清除。隐私政策：https://ryanlq.github.io/offline-bilingual-translator/privacy.html

要求与说明

适用于 Chrome / Edge 116 及以上版本。语言包只在下载那一刻联网，官方索引不可用时回退到本地缓存，已安装的语言包不受影响。极少数使用 closed Shadow DOM 深度封装的页面受浏览器安全边界限制，可能无法注入译文。本项目以 Apache-2.0 开源，源码可审计：https://github.com/ryanlq/offline-bilingual-translator
```

**英文（en）——粘贴以下全文：**

```text
Offline Bilingual Translator is a browser extension that translates web pages into a bilingual view entirely on your device. Powered by the Mozilla Bergamot WASM engine, it inserts the translated text directly beneath each original paragraph, so the source stays visible for side-by-side reading and terminology checking. Translations are rendered in an isolated Shadow DOM, leaving the page's styles, layout and interactions untouched. Translation itself makes zero network requests and needs no account, API key or cloud service.

Features

- Bilingual paragraphs: toggle translation for the current page from the toolbar or with Alt+Shift+T. Paragraphs, headings, list items and table cells are collected automatically, and hovering a translated block highlights the corresponding original text.
- Selection translation: select text to open a compact translation popup. It is on by default, can be switched off instantly from the toolbar popup or the options page, and only appears when the selected text matches the current source language. A "Translate selected text" context-menu item works on any selection on demand.
- Image and screen OCR: press Alt+Shift+O to drag a box over any screen region, or right-click an image and choose "OCR this image". Tesseract.js recognises the text locally and the offline engine translates it; the result appears in a floating panel.
- More language packs: English-Chinese models are built in, with English to Chinese as the default direction. The "More language packs" section of the options page lists about 20 language pairs from the official Bergamot repository (French, German, Spanish, Russian, Ukrainian, Czech and others, roughly 20-37 MB each). Installed pairs appear in the translation-direction menu and work for page, selection and OCR translation; they can be removed at any time.
- Customisation: translated-text font size and colour, hover highlighting, translation direction, the selection-popup switch, OCR recognition languages, and CSS selectors for page regions you want to exclude.

Offline and privacy

The first use requires an internet connection to download a language model (about 45 MB per direction), an optional language pack or OCR language data. Files come from the official Mozilla, Bergamot and Tesseract sources, are verified with SHA-256 and cached locally, after which the extension works fully offline. To produce a translation the extension reads the text of the current page locally, plus the screen region you select for OCR. This content is processed in memory only and is never written to disk, uploaded, shared or retained. There is no analytics, telemetry, crash reporting, account system or translation history. Settings and models stay in extension-private local storage and are removed when the extension is uninstalled. Privacy policy: https://ryanlq.github.io/offline-bilingual-translator/privacy.html

Requirements and limitations

Requires Chrome or Edge 116 or later. The network is used only at the moment a resource is downloaded; if the official index is unavailable the extension falls back to the cached copy and installed packs keep working. A small number of pages that rely on deeply nested closed Shadow DOM cannot be injected because of browser security boundaries. The project is open source under Apache-2.0 and the code can be audited at https://github.com/ryanlq/offline-bilingual-translator
```

## 4. Privacy practices（隐私权规范）——审核重点，逐字粘贴

### 4.1 单一用途说明（Single purpose）

```text
Translate the text of web pages into a bilingual view entirely on the user's device, by inserting the translated paragraph directly beneath the original one. Selection translation and image OCR are two ways of invoking this same translation feature. All inference runs in the bundled Bergamot WASM engine; no page content is ever transmitted to a server.
```

### 4.2 权限理由（每个输入框单独粘贴）

**offscreen**
```text
MV3 service workers have no DOM. The bundled Bergamot WASM engine and the Tesseract.js OCR worker need a hidden offscreen document as their runtime host. It contains no remote code and is never shown to the user.
```

**storage**
```text
Stores only the user's own preferences (font size, colors, translation direction, selection-translation toggle) and the list of installed language packs in chrome.storage.local. Nothing is synced or uploaded.
```

**unlimitedStorage**
```text
Language models are about 45 MB per direction (up to ~37 MB for each extra pack) and are cached in IndexedDB so translation works offline; this exceeds the default extension storage quota. Files are public, SHA-256 verified and removable from the options page.
```

**contextMenus**
```text
Adds two context-menu entries, "Translate selected text" and "OCR this image", so the user can translate a selection or an image in place. The first entry is disabled when the user switches the selection popup off in settings.
```

**activeTab**
```text
Identifies the tab in which the user clicked the toolbar button or pressed a keyboard shortcut, so the page-translation toggle is delivered to that tab only. No URL, title or history is read.
```

**tabs**
```text
Used only for chrome.tabs.query({active:true,currentWindow:true}) to obtain tab.id / windowId for messaging, and chrome.tabs.captureVisibleTab to capture the screen region the user explicitly drags for OCR. The extension never reads tab.url or tab.title, never builds browsing history, and the captured image is cropped and processed in memory only.
```

**declarativeNetRequest**
```text
Installs one dynamic rule that rewrites the User-Agent header for requests to firefox-settings-attachments.cdn.mozilla.net, because that CDN returns HTTP 406 to a Chrome UA. The rule matches no page URL and inspects no request or response content.
```

**Host permissions（4 个域名）**
```text
Four public static-file hosts are contacted only when the user first installs a resource: Mozilla Remote Settings (index + en/zh models), the Bergamot S3 model index/models, and tessdata.projectnaptha.com (OCR language data). Downloads are SHA-256 verified and cached locally; requests contain no page content, user identifier or browsing activity. No translation request is ever sent to these hosts.
```

### 4.3 远程代码（Remote code）

选 **`No, I am not using remote code`**。

若表单出现 Justification 输入框，粘贴：
```text
All JavaScript and WASM are bundled in the package. The only runtime downloads are static model binaries and OCR training data (data files, never evaluated as code). The CSP forbids any other script source, and there is no analytics, A/B or remote-config SDK.
```

### 4.4 数据使用认证（Data usage）

**第一组复选框：只勾 `Website content`，其余 8 项都不勾。**

依据：翻译必须读取当前网页文本、OCR 时截取用户框选的屏幕区域，属 Website content；
Chrome User Data FAQ 明确「即使只在本地处理也必须披露」。但这些数据只在内存中即时
处理、不落盘、不上传、不留存，故不申报 PII / 认证 / 通讯 / 位置 / Web history /
User activity 等。

**第二组认证（3 条）：全部勾选**
- [x] Not selling or transferring data to third parties
- [x] Not using data for purposes unrelated to the item's core purpose
- [x] Not using data for creditworthiness or lending

### 4.5 隐私政策 URL（Privacy policy URL）

```text
https://ryanlq.github.io/offline-bilingual-translator/privacy.html
```

（政策页内容与上述申报口径完全一致：本地读取但不收集、不传输、不留存。）

## 5. Distribution（分发）

- **Visibility**：`Public`（全球可见）
- **Regions**：默认全部地区（扩展面向中英用户，无需限制）
- （可选）**Delayed publish**：审核通过后不自动发布，30 天内手动发布——首次发布用默认即可

## 6. 提交审核

三页（Listing / Privacy / Distribution）全部填完、无红色缺失项后，点 **`Submit for review`**。

- 首审通常 **1–7 天**（权限少、无远程代码、隐私申报清晰的包更快）
- 状态在 Dashboard 首页可见；驳回会附带原因邮件
- 若被驳回：按邮件逐条修改后重新提交即可，无需新账号

### 常见驳回点对照（本包均已规避）

| 常见驳回原因 | 本包状态 |
|-------------|---------|
| 权限理由写"needed to work"空话 | 逐权限具体理由 ✅ |
| 漏报 Website content（inaccurate disclosure） | 已按 FAQ 口径申报 ✅ |
| zip 内路径分隔符为 `\`（Windows 打包工具） | 已改纯 Node 打包，全部 `/` ✅ |
| `<all_urls>` + tabs 组合被重点审查 | 理由已写明"never reads URL/title/history" ✅ |
| DNR 权限理由不清 | 已说明仅改写模型 CDN 的 UA 头 ✅ |
| 远程代码（运行时加载 JS） | 无；仅下载模型/数据文件 ✅ |

## 附：再生成 / 更新截图

截图由真实扩展在 instabox-2 的 Chromium (xvfb) 中运行生成（非合成图）：

```bash
# 上传 zip 并解压到 box:~/obt-shots/ext 后（首次需临时给 ext 副本加 <all_urls> host 权限，
# 否则 captureVisibleTab 无用户手势时被拒——仅截图副本，发布包不含）
ssh instabox-2 'cd ~/obt-shots && xvfb-run -a --server-args="-screen 0 1400x950x24" \
  node shots.mjs ~/obt-shots/ext ~/obt-shots/out-zh zh-CN /tmp/obt-profile'
# en 版本把 out-zh/zh-CN 换成 out-en/en-US
```

产物直接落 `store-assets/screenshots/{zh,en}/`，全部 1280×800。
