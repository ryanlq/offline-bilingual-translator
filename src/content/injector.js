/**
 * 译文块注入器（Shadow DOM 样式隔离）
 *
 * 每个原文段落后插入一个宿主元素，内部用 closed Shadow DOM 渲染译文，
 * 避免与页面样式互相污染。译文样式通过 CSS 变量控制。
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	/** 这些元素不能插兄弟节点，译文改为追加到元素内部 */
	const CONTAINER_TAGS = new Set(['LI', 'DT', 'DD', 'TD', 'TH']);

	class BilingualInjector {
		constructor() {
			/** @type {Map<Element, HTMLElement>} 原文元素 → 宿主元素 */
			this.hosts = new Map();
			/**
			 * 宿主元素 → shadow root。
			 * 注意：closed 模式下 element.shadowRoot 恒为 null，必须自行持有引用，
			 * 否则后续所有样式更新与译文写入都会抛 TypeError。
			 * @type {WeakMap<HTMLElement, ShadowRoot>}
			 */
			this.roots = new WeakMap();
			this.style = {
				fontSize: 14,
				textColor: '#8b8b8b',
				backgroundColor: 'transparent',
				hoverHighlight: true,
			};
			this._highlighted = null;
			this._bindHover();
		}

		updateStyle(style) {
			this.style = { ...this.style, ...style };
			// 更新已注入的译文样式
			for (const host of this.hosts.values()) {
				this._applyStyle(host);
			}
		}

		_applyStyle(host) {
			const root = this.roots.get(host);
			if (!root) return;
			const target = root.querySelector('.obt-translation');
			if (!target) return;
			target.style.fontSize = `${this.style.fontSize}px`;
			target.style.color = this.style.textColor;
			target.style.backgroundColor = this.style.backgroundColor;
		}

		/**
		 * 为段落注入译文块
		 * @param {Element} element 原文元素
		 * @param {string} original 原文（悬停展示）
		 * @returns {HTMLElement} 宿主元素
		 */
		inject(element, original = '') {
			if (this.hosts.has(element)) return this.hosts.get(element);

			const host = document.createElement('div');
			host.setAttribute('data-obt-host', '');
			host.style.all = 'unset';
			host.style.display = 'block';
			if (original) host.title = original;

			const root = host.attachShadow({ mode: 'closed' });
			this.roots.set(host, root);
			root.innerHTML = `
				<style>
					:host { all: initial; display: block; }
					.obt-translation {
						display: block;
						margin: 4px 0;
						padding: 2px 0;
						font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
							"Hiragino Sans GB", "Microsoft YaHei", sans-serif;
						line-height: 1.6;
						transition: background-color 0.15s;
						user-select: none;
						-webkit-user-select: none;
					}
				</style>
				<div class="obt-translation" data-original="${escapeHtml(original).slice(0, 200)}">
					<span class="obt-text"></span>
				</div>
			`;

			this._applyStyle(host);

			// 插入位置：列表项/表格单元内部追加，其余段落插到原文之后
			// （直接往 <ul>/<tr> 里塞 div 会破坏列表与表格结构）
			if (CONTAINER_TAGS.has(element.tagName)) {
				element.appendChild(host);
			} else {
				element.insertAdjacentElement('afterend', host);
			}
			element.setAttribute('data-obt-original', '');

			this.hosts.set(element, host);
			return host;
		}

		/** 设置某段落的译文 */
		setTranslation(element, translated) {
			const host = this.hosts.get(element);
			if (!host) return;
			const root = this.roots.get(host);
			const span = root?.querySelector('.obt-text');
			if (span) span.textContent = translated;
		}

		/** 显示加载指示 */
		setPending(element) {
			const host = this.hosts.get(element);
			if (!host) return;
			const span = this.roots.get(host)?.querySelector('.obt-text');
			if (span) span.textContent = '…';
		}

		/** 移除某个段落的译文块 */
		remove(element) {
			const host = this.hosts.get(element);
			if (!host) return;
			host.remove();
			element.removeAttribute('data-obt-original');
			this.hosts.delete(element);
		}

		/** 清空全部 */
		clear() {
			for (const [element] of this.hosts) {
				element.removeAttribute('data-obt-original');
			}
			for (const host of this.hosts.values()) {
				host.remove();
			}
			this.hosts.clear();
		}

		get isBusy() {
			return false;
		}

		/* ---------- 悬停交互：悬停译文高亮原文 ---------- */

		_bindHover() {
			document.addEventListener('mouseover', (event) => {
				if (!this.style.hoverHighlight) return;

				// 检查事件目标是否在某个宿主的 shadow DOM 内
				const host = event.composedPath().find(
					(node) => node instanceof HTMLElement && node.hasAttribute?.('data-obt-host'),
				);
				if (host) {
					const element = [...this.hosts.entries()].find(([, h]) => h === host)?.[0];
					if (element) this._highlight(element);
				} else {
					this._unhighlight();
				}
			}, true);
		}

		_highlight(element) {
			if (this._highlighted === element) return;
			this._unhighlight();
			this._highlighted = element;
			element.setAttribute('data-obt-highlight', '');
			if (!document.getElementById('obt-highlight-style')) {
				const style = document.createElement('style');
				style.id = 'obt-highlight-style';
				style.textContent = `
					[data-obt-highlight] {
						background-color: rgba(66, 133, 244, 0.14) !important;
						border-radius: 2px;
					}
				`;
				document.head.appendChild(style);
			}
		}

		_unhighlight() {
			if (this._highlighted) {
				this._highlighted.removeAttribute('data-obt-highlight');
				this._highlighted = null;
			}
		}
	}

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	OBT.BilingualInjector = BilingualInjector;
})();
