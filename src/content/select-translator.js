/**
 * 划词翻译（自研实现，参考 Linguist SelectTranslator 与 KISS Translator 交互）
 *
 * 鼠标选中文本后弹出对照小窗：左原文｜右译文（短选区自动上下堆叠）。
 * 富文本：选区内联格式（粗体/斜体/链接等）经白名单净化后保留展示，
 * 译文走引擎 html 模式（保留标签结构）再过同一净化器。
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	class SelectTranslator {
		constructor() {
			this.settings = null;
			this.container = null;
			this.shadowRoot = null;
			this.enabled = false;

			document.addEventListener('mouseup', (event) => this.onMouseUp(event), true);
			document.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') this.hide();
			}, true);
		}

		setSettings(settings) {
			this.settings = settings;
		}

		setEnabled(enabled) {
			this.enabled = enabled;
			if (!enabled) this.hide();
		}

		async onMouseUp(event) {
			if (!this.enabled) return;
			// 只响应左键选择；右键交给菜单项（避免菜单弹出时重复翻译）
			if (event.button !== 0) return;
			// 点击弹窗内部不处理
			if (this.container && this.container.contains(event.target)) return;

			this.hide();

			// 略有延迟，避免与点击关闭冲突
			await new Promise((resolve) => setTimeout(resolve, 120));
			if (!this.enabled) return;

			await this.translateSelection({ auto: true });
		}

		/**
		 * 捕获当前选区的内联 HTML（cloneContents 片段序列化，标签天然平衡）。
		 * 无选区或纯文本返回 null。
		 * @returns {string|null}
		 */
		selectionHtml() {
			const selection = window.getSelection();
			if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
			const frag = selection.getRangeAt(0).cloneContents();
			const div = document.createElement('div');
			div.appendChild(frag);

			// 空白规范化：行内连续空格折一个；换行及其前后空白折成单个换行。
			// pre-wrap 会原样保留源码缩进空白，不折叠会导致块间出现大段空行。
			const normalize = (root) => {
				for (const node of [...root.childNodes]) {
					if (node.nodeType === Node.TEXT_NODE) {
						node.nodeValue = node.nodeValue
							.replace(/[ \t\f\r]+/g, ' ')
							.replace(/ *\n\s*/g, '\n');
					} else if (node.nodeType === Node.ELEMENT_NODE) {
						if (node.tagName === 'BR') {
							node.replaceWith(document.createTextNode('\n'));
						} else {
							normalize(node);
						}
					}
				}
			};
			normalize(div);

			// 块级元素剥壳后多段文本会粘成一行（源 HTML 块间常无空白节点）：
			// 在每个块级子树后补换行；随后再折叠一次（补的换行与既有换行相邻时合并）
			const BLOCKS = new Set([
				'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
				'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION', 'DT', 'DD',
			]);
			const markBlocks = (container) => {
				for (const el of [...container.children]) {
					if (BLOCKS.has(el.tagName)) {
						markBlocks(el);
						el.after(document.createTextNode('\n'));
					} else {
						markBlocks(el);
					}
				}
			};
			markBlocks(div);
			normalize(div);

			// 去掉整体首尾空白
			while (div.firstChild && div.firstChild.nodeType === Node.TEXT_NODE && !div.firstChild.nodeValue.trim()) {
				div.removeChild(div.firstChild);
			}
			while (div.lastChild && div.lastChild.nodeType === Node.TEXT_NODE && !div.lastChild.nodeValue.trim()) {
				div.removeChild(div.lastChild);
			}
			// 兜底：连续换行硬折叠为单个（块边界的补行 + 源码换行叠加时）
			const html = div.innerHTML.replace(/\n[ \t]*\n+/g, '\n');
			return /<[a-z][^>]*>/i.test(html) ? html : null;
		}

		/**
		 * 翻译当前选区（右键菜单「翻译选中文本」与划词自动触发共用）
		 * @param {{auto?: boolean}} options
		 *   auto: 划词自动触发。仅当选中文本属于当前翻译方向的源语言时才弹窗，
		 *         避免在中文网页选中中文还弹出"翻译"的噪音。
		 * @returns {Promise<void>}
		 */
		async translateSelection({ auto = false } = {}) {
			if (!this.enabled) return;

			const selection = window.getSelection();
			const text = selection?.toString().replace(/\s+/g, ' ').trim();
			if (!selection || selection.isCollapsed || !text) return;
			if (text.length < 2 || text.length > 2000) return;

			// 选区完全位于代码元素内（code/pre/kbd/samp）：代码/命令不翻译，不弹窗
			const anchorEl = selection.anchorNode.nodeType === Node.ELEMENT_NODE
				? selection.anchorNode
				: selection.anchorNode.parentElement;
			const focusEl = selection.focusNode.nodeType === Node.ELEMENT_NODE
				? selection.focusNode
				: selection.focusNode.parentElement;
			if (anchorEl?.closest?.('code, pre, kbd, samp') && focusEl?.closest?.('code, pre, kbd, samp')) return;

			const rect = selection.getRangeAt(0).getBoundingClientRect();
			let direction = OBT.resolveDirection(
				this.settings.translateDirection,
				document.documentElement.lang,
			);

			const detected = OBT.detectTextLang(text);
			// 明确检测到不支持翻译的源语言（如日语/韩语，内置引擎无对应语言包）：
			// 无论自动还是菜单触发都不弹窗，避免「原文译文同为日文」的无效结果
			if (detected === 'ja' || detected === 'ko') return;
			// 启发式语言判定只覆盖中/英源语言；其它语言（法/德/俄/乌等）
			// 不做方向拦截，否则选中的外文会被误判成「非源语言」而永不弹窗
			const canGateByLang = direction.from === 'zh' || direction.from === 'en';
			if (auto) {
				if (canGateByLang) {
					// 自动弹窗：非源语言（已是目标语言/无法判断）不打扰
					if (detected !== direction.from) return;
				} else if (!/\p{L}/u.test(text)) {
					// 其它语言只排除纯数字、符号
					return;
				}
			} else if (canGateByLang && detected && detected !== direction.from) {
				// 右键菜单是显式动作：按选中文本的实际语言取反方向
				direction = detected === 'zh' ? { from: 'zh', to: 'en' } : { from: 'en', to: 'zh' };
			}

			const x = rect.left;
			const y = rect.bottom + 6;

			// 富文本：选区内联格式经净化后进原文栏；无标签时走纯文本零开销路径
			const selHtml = this.selectionHtml();
			// 原文栏内容：有内联标签用净化后的富文本；纯文本选区直接用文本（不能留空）
			const originalContent = selHtml ? OBT.sanitizeTranslationHtml(selHtml) : text;
			this.showLoading(x, y, originalContent);

			try {
				const [translated] = await OBT.rpcCall('translate:texts', {
					texts: [selHtml ?? text],
					from: direction.from,
					to: direction.to,
					html: Boolean(selHtml),
				});
				this.showResult(originalContent, translated ?? '', x, y);
			} catch (err) {
				// html 模式异常（罕见）：退回纯文本重试一次
				if (selHtml) {
					try {
						const [translated] = await OBT.rpcCall('translate:texts', {
							texts: [text],
							from: direction.from,
							to: direction.to,
						});
						this.showResult(text, translated ?? '', x, y);
						return;
					} catch (err2) {
						this.showResult(text, `⚠ ${err2.message}`, x, y);
						return;
					}
				}
				this.showResult(text, `⚠ ${err.message}`, x, y);
			}
		}

		ensureContainer() {
			if (this.container) return;

			this.container = document.createElement('div');
			this.container.setAttribute('data-obt-select-popup', '');
			this.shadowRoot = this.container.attachShadow({ mode: 'closed' });
			this.shadowRoot.innerHTML = `
				<style>
					:host { all: initial; }
					.popup {
						--sp-bg: #ffffff;
						--sp-border: #dadce0;
						--sp-orig: #3c4043;
						--sp-tran: #1a73e8;
						--sp-label: #9aa0a6;
						position: absolute;
						z-index: 2147483646;
						width: min(680px, calc(100vw - 24px));
						background: var(--sp-bg);
						border: 1px solid var(--sp-border);
						border-radius: 10px;
						box-shadow: 0 6px 24px rgba(0,0,0,0.18);
						font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
							"Microsoft YaHei", "微软雅黑", sans-serif;
						color: #202124;
					}
					.popup[data-theme='dark'] {
						--sp-bg: #1f2126;
						--sp-border: #3c4043;
						--sp-orig: #d7dce5;
						--sp-tran: #8ab4f8;
						--sp-label: #8a93a3;
						color: #d7dce5;
					}
					.popup[data-theme='sepia'] {
						--sp-bg: #f8f1e3;
						--sp-border: #d9c9a8;
						--sp-orig: #5b4a36;
						--sp-tran: #9a6b1f;
						--sp-label: #a08c6a;
					}
					.panes { display: flex; align-items: stretch; }
					.pane { flex: 1 1 0; min-width: 0; padding: 10px 14px 12px; overflow: auto; max-height: 340px; }
					.pane + .pane { border-left: 1px solid var(--sp-border); }
					.label {
						font-size: 11px;
						color: var(--sp-label);
						margin-bottom: 6px;
						letter-spacing: 0.08em;
						user-select: none;
					}
					.content { line-height: 1.75; overflow-wrap: break-word; white-space: pre-wrap; letter-spacing: 0.015em; }
					.original .content { color: var(--sp-orig); font-size: 13px; }
					.translation .content { color: var(--sp-tran); font-size: 14px; }
					.content a { color: inherit; text-decoration: underline; }
					.content b, .content strong { font-weight: 600; }
					.close, .theme {
						position: absolute;
						top: 8px;
						cursor: pointer;
						color: var(--sp-label);
						border: none;
						background: none;
						font-size: 14px;
						padding: 2px 4px;
						line-height: 1;
					}
					.close { right: 10px; }
					.theme { right: 34px; font-size: 13px; }
					.close:hover, .theme:hover { color: #5f6368; }
				</style>
				<div class="popup" role="dialog">
					<button class="theme" title="切换主题（浅色/暗色/护眼）">◐</button>
					<button class="close" title="关闭">✕</button>
					<div class="panes">
						<div class="pane original">
							<div class="label">原文</div>
							<div class="content"></div>
						</div>
						<div class="pane translation">
							<div class="label">译文</div>
							<div class="content"></div>
						</div>
					</div>
				</div>
			`;

			this.popup = this.shadowRoot.querySelector('.popup');
			this.panes = this.shadowRoot.querySelector('.panes');
			this.originalContent = this.shadowRoot.querySelector('.original .content');
			this.translationContent = this.shadowRoot.querySelector('.translation .content');
			this.shadowRoot.querySelector('.close').addEventListener('click', () => this.hide());
			// 主题：从设置读取；弹窗内 ◐ 按钮循环切换并保存
			this.popup.dataset.theme = ['dark', 'sepia'].includes(this.settings?.selectTheme) ? this.settings.selectTheme : 'light';
			this.shadowRoot.querySelector('.theme').addEventListener('click', () => {
				const order = ['light', 'dark', 'sepia'];
				const next = order[(order.indexOf(this.popup.dataset.theme) + 1) % order.length];
				this.popup.dataset.theme = next;
				OBT.saveSettings({ selectTheme: next }).then(() => {
					this.settings = { ...this.settings, selectTheme: next };
				});
			});

			document.documentElement.appendChild(this.container);

			// 点击外部关闭
			document.addEventListener(
				'mousedown',
				(event) => {
					if (this.container && !this.container.contains(event.target)) this.hide();
				},
				true,
			);
		}

		/** 内容写入：HTML 片段（已净化）优先，否则纯文本 */
		_fill(contentEl, htmlOrText) {
			contentEl.textContent = '';
			if (htmlOrText instanceof DocumentFragment) {
				// append 会移动 fragment 的子节点（第二次 append 就空了），必须克隆
				contentEl.appendChild(htmlOrText.cloneNode(true));
			} else {
				contentEl.textContent = String(htmlOrText ?? '');
			}
		}

		/** 应用主题（浅色/暗色/护眼） */
		applyTheme(theme) {
			this.ensureContainer();
			this.popup.dataset.theme = ['dark', 'sepia'].includes(theme) ? theme : 'light';
		}

		showLoading(x, y, originalContent) {
			this.ensureContainer();
			this.applyTheme(this.settings?.selectTheme ?? 'light');
			this._fill(this.originalContent, originalContent ?? '');
			this.translationContent.textContent = '翻译中…';
			this.place(x, y);
		}

		showResult(originalHtml, translation, x, y) {
			this.ensureContainer();
			this._fill(this.originalContent, originalHtml ?? '');
			this._fill(this.translationContent, OBT.sanitizeTranslationHtml(String(translation ?? '')));
			this.place(x, y);
		}

		/** 定位：水平钳制在视口内，垂直保证弹窗完整可见 */
		place(x, y) {
			const width = this.popup.offsetWidth || 680;
			const height = this.popup.offsetHeight || 300;
			const left = Math.max(8, Math.min(x, window.innerWidth - width - 12));
			const top = Math.max(8, Math.min(y, window.innerHeight - Math.min(height + 12, window.innerHeight - 16)));
			this.popup.style.left = `${left}px`;
			this.popup.style.top = `${top + window.scrollY}px`;
			this.container.style.display = 'block';
		}

		hide() {
			if (this.container) this.container.style.display = 'none';
		}
	}

	OBT.SelectTranslator = SelectTranslator;
})();
