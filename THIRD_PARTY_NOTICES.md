# 第三方组件署名与许可（THIRD PARTY NOTICES）

本扩展基于多个开源项目构建，各组件的许可与义务如下。

本项目自有代码采用 **Apache-2.0**（见仓库根目录 `LICENSE` / `NOTICE`）；下文标明的
vendor 文件与 MPL 衍生文件仍按各自原许可分发，不因主项目换协议而改变。

## 1. Bergamot Translator WASM（翻译引擎）

- 文件：`vendor/bergamot/bergamot-translator-worker.js`、`bergamot-translator-worker.wasm`
- 版本：v0.4.5+05a8778
- 来源：https://github.com/browsermt/bergamot-translator
  （产物取自 https://github.com/translate-tools/linguist v7.1.0 发布包，
  由 Linguist 按 browsermt 官方流程构建）
- 许可：**MPL-2.0**
- 义务：引擎文件**未做任何修改、原样分发**，保留其许可文本（见 `vendor/bergamot/LICENSE-MPL-2.0.txt`）。
  `src/workers/bergamot-worker.js` 改编自 bergamot-translator 的 translator-worker.js
  与 Linguist 的同名封装（增加 null-shortlist 支持），属于 MPL-2.0 覆盖文件的衍生作品；
  MPL-2.0 是**文件级 copyleft**，因此该文件保持 MPL-2.0，**不随主项目改授 Apache-2.0**。
  文件头已加 MPL boilerplate，其「源码形式」即本仓库中的该文件，随包/随仓库公开。
  Linguist 部分的 BSD-3-Clause 归属见该文件头注释。

## 2. Firefox Translations Models（en↔zh 神经网络模型）

- 文件：运行时下载，缓存在浏览器 IndexedDB（`model.enzh.intgemm.alphas.bin` 等）
- 来源：Mozilla Remote Settings（`translations-models` 集合），即 Firefox 翻译功能
  的官方模型分发渠道；同一模型亦可见于
  https://github.com/mozilla/firefox-translations-models
- 许可：**CC-BY**（逐模型确认，见仓库 LICENSE）
- 义务：在扩展"关于"页署名（已包含）。

## 3. Bergamot 官方模型仓库（「更多语言包」的 20 个语言对）

- 来源：https://bergamot.s3.amazonaws.com/models/index.json
  及索引中列出的 `https://bergamot.s3.amazonaws.com/models/*` 文件
- 分发方式：**不随扩展打包**；用户在设置页按需下载，缓存在浏览器 IndexedDB
- 许可：CC-BY 等（逐语言对见其仓库）
- 义务：设置页「语言包」卡片标注来源，并在本文件署名；下载时按索引中的
  SHA-256 校验文件完整性（`tools/verify-language-packs.mjs` 已实测）。

## 4. Tesseract.js（OCR 引擎）

- 文件：`vendor/tesseract/*`（tesseract.min.js、worker.min.js、tesseract-core*.wasm.js）
- 版本：tesseract.js 5.1.1 / tesseract.js-core 5.1.1
- 来源：https://github.com/naptha/tesseract.js
- 许可：**Apache-2.0**
- 义务：保留版权声明。

## 5. Linguist（参考项目）

- 来源：https://github.com/translate-tools/linguist（BSD-3-Clause）
- 使用方式：**仅参考其 Bergamot 引擎集成架构**（Worker 加载方式、模型缓存与
  offscreen document 模式），未复制其业务代码；wasm 产物取自其官方发布包（见第 1 条）。
  `src/workers/bergamot-worker.js` 中少量封装片段改编自其同名文件，许可名与来源
  已在该文件头保留署名（BSD-3-Clause）。

## 6. KISS Translator

- 来源：https://github.com/fishjar/kiss-translator（GPL-3.0）
- 使用方式：**仅研究其双语对照的交互思路（DOM 注入点选择、段落对齐、样式隔离），
  未复制任何代码**，避免 GPL 传染。

## 7. domtranslator（设计思路参考）

- 来源：https://github.com/translate-tools/domtranslator（Linguist 作者出品）
- 使用方式：参考其文本节点遍历与过滤思路，段落级提取与注入为本项目独立实现。

## 本项目自有代码

- 目录：`src/`、`tools/`、`docs/`、`assets/`（图标）、`store-assets/`
- 许可：**Apache-2.0**（见 `LICENSE` / `NOTICE`）
- 例外：`src/workers/bergamot-worker.js` 为 MPL-2.0 衍生文件（见第 1 条）；
  `vendor/` 下所有文件按各自原许可分发。
- 图标插画由项目维护者提供（源图 `tools/icon-source.png`），随本项目按 Apache-2.0 分发。
