/**
 * 划词翻译（自研实现，参考 Linguist SelectTranslator 与 KISS Translator 交互）
 *
 * 鼠标选中文本后弹出小窗展示译文；点击页面其他位置或 ESC 关闭。
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	class SelectTranslator {
		constructor() {
			this.settings = null;
			this.container = null;
			this.shadowRoot = null;
			this.hideTimer = null;
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
		 * 翻译当前选区（右键菜单「翻译选中文本」与划词自动触发共用）
		 * @param {{auto?: boolean}} options
		 *   auto: 划词自动触发。仅当选中文本属于当前翻译方向的源语言时才弹窗，
		 *         避免在中文网页选中中文还弹出"翻译"的噪音。
		 * @returns {Promise<void>}
		 */
		async translateSelection({ auto = false } = {}) {
			if (!this.enabled) return;

			const selection = window.getSelection();
			const text = selection?.toString().trim();
			if (!selection || selection.isCollapsed || !text) return;
			if (text.length < 2 || text.length > 2000) return;

			const rect = selection.getRangeAt(0).getBoundingClientRect();
			let direction = OBT.resolveDirection(
				this.settings.translateDirection,
				document.documentElement.lang,
			);

			const detected = OBT.detectTextLang(text);
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

			this.showLoading(x, y);

			try {
				const [translated] = await OBT.rpcCall('translate:texts', {
					texts: [text],
					from: direction.from,
					to: direction.to,
				});
				this.showResult(text, translated, x, y);
			} catch (err) {
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
						position: absolute;
						z-index: 2147483646;
						max-width: 480px;
						max-height: 320px;
						overflow: auto;
						background: #ffffff;
						border: 1px solid #dadce0;
						border-radius: 8px;
						box-shadow: 0 4px 16px rgba(0,0,0,0.18);
						padding: 10px 12px;
						font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
						font-size: 13px;
						line-height: 1.6;
						color: #202124;
					}
					.original {
						color: #5f6368;
						font-size: 12px;
						margin-bottom: 6px;
						max-height: 80px;
						overflow: auto;
					}
					.translation {
						color: #1a73e8;
						font-size: 14px;
					}
					.close {
						float: right;
						cursor: pointer;
						color: #9aa0a6;
						border: none;
						background: none;
						font-size: 14px;
						padding: 0 2px;
					}
					.close:hover { color: #5f6368; }
				</style>
				<div class="popup" role="dialog">
					<button class="close" title="关闭">✕</button>
					<div class="original"></div>
					<div class="translation"></div>
				</div>
			`;

			this.popup = this.shadowRoot.querySelector('.popup');
			this.shadowRoot.querySelector('.close').addEventListener('click', () => this.hide());

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

		showLoading(x, y) {
			this.ensureContainer();
			this.popup.querySelector('.original').textContent = '';
			this.popup.querySelector('.translation').textContent = '翻译中…';
			this.place(x, y);
		}

		showResult(original, translation, x, y) {
			this.ensureContainer();
			this.popup.querySelector('.original').textContent = original.slice(0, 300);
			this.popup.querySelector('.translation').textContent = translation;
			this.place(x, y);
		}

		/** 定位：水平钳制在视口内，垂直保证弹窗（高≤320px）完整可见 */
		place(x, y) {
			const left = Math.max(4, Math.min(x, window.innerWidth - 500));
			const top = Math.max(4, Math.min(y, window.innerHeight - 330));
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
