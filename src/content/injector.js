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

	/** shadow DOM 内部样式：千段页面共享一份 CSSStyleSheet，不再各持一份内联 <style> */
	const SHADOW_CSS = `
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
	`;

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
			/** 宿主元素 → 原文元素（悬停反查用，避免每次 mouseover 线性扫 hosts） */
			this.hostToElement = new WeakMap();
			this.style = {
				fontSize: 14,
				textColor: '#8b8b8b',
				backgroundColor: 'transparent',
				hoverHighlight: true,
			};
			this._highlighted = null;
			/** @type {CSSStyleSheet|null} 共享样式表（不可用时回退到逐 root 内联 <style>） */
			this.sheet = null;
			/** @type {HTMLTemplateElement|null} 译文块模板（克隆比 innerHTML 快且省内存） */
			this.template = null;
			this._bindHover();
		}

		/** 惰性创建共享样式表与模板（首次 inject 时） */
		_ensureSharedAssets() {
			if (this.template) return;
			try {
				this.sheet = new CSSStyleSheet();
				this.sheet.replaceSync(SHADOW_CSS);
			} catch {
				this.sheet = null; // 极旧内核无 Constructable Stylesheets：退回逐 root <style>
			}
			this.template = document.createElement('template');
			this.template.innerHTML = '<div class="obt-translation"><span class="obt-text"></span></div>';
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
			this._ensureSharedAssets();

			const host = document.createElement('div');
			host.setAttribute('data-obt-host', '');
			host.style.all = 'unset';
			host.style.display = 'block';
			if (original) host.title = original;

			const root = host.attachShadow({ mode: 'closed' });
			this.roots.set(host, root);
			if (this.sheet) {
				root.adoptedStyleSheets = [this.sheet];
			} else {
				const style = document.createElement('style');
				style.textContent = SHADOW_CSS;
				root.appendChild(style);
			}
			const node = this.template.content.cloneNode(true);
			const block = node.querySelector('.obt-translation');
			if (original) block.dataset.original = original.slice(0, 200);
			root.appendChild(node);

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
			this.hostToElement.set(host, element);
			return host;
		}

		/**
		 * 设置某段落的译文
		 * @param {Element} element
		 * @param {string} translated 译文（纯文本或引擎返回的受限 HTML）
		 * @param {{html?: boolean}} [options] html: translated 为 HTML 片段，净化后写入
		 */
		setTranslation(element, translated, { html = false } = {}) {
			const host = this.hosts.get(element);
			if (!host) return;
			const root = this.roots.get(host);
			const span = root?.querySelector('.obt-text');
			if (!span) return;
			if (html) {
				span.textContent = '';
				span.appendChild(sanitizeTranslationHtml(translated));
			} else {
				span.textContent = translated;
			}
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
			this.hostToElement.delete(host);
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

		/**
		 * 清理已脱离文档的段落宿主（SPA 路由后旧元素仍在 hosts Map 里强引用，长会话会泄漏）。
		 * 由 PageTranslator.collectNew 周期性调用；宿主 remove 时也顺带清掉译文高亮样式。
		 */
		sweepRemoved() {
			let removed = 0;
			for (const [element, host] of this.hosts) {
				if (!element.isConnected) {
					host.remove();
					this.roots.delete(host);
					this.hostToElement.delete(host);
					this.hosts.delete(element);
					removed++;
				}
			}
			return removed;
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
					const element = this.hostToElement.get(host);
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

	/** 译文输出允许保留的内联标签（其余剥壳保字，防引擎 HTML 子集外的东西破坏页面） */
	const ALLOWED_OUTPUT_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'SMALL', 'SUB', 'SUP', 'ABBR', 'A', 'CODE']);

	/**
	 * 净化引擎返回的 HTML 片段：白名单标签重建，属性只留 a[href] 且仅 http(s)。
	 * 输入来自本地 WASM 引擎（非网页内容），但 bergamot HTML 子集有限，
	 * 输出结构不可信，必须过一遍白名单才能进 shadow DOM。
	 */
	function sanitizeTranslationHtml(html) {
		const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
		const frag = document.createDocumentFragment();
		const build = (from, to) => {
			for (const node of from.childNodes) {
				if (node.nodeType === Node.TEXT_NODE) {
					to.appendChild(document.createTextNode(node.nodeValue));
					continue;
				}
				if (node.nodeType !== Node.ELEMENT_NODE) continue;
				if (!ALLOWED_OUTPUT_TAGS.has(node.tagName)) {
					build(node, to); // 剥壳保字
					continue;
				}
				const el = document.createElement(node.tagName.toLowerCase());
				if (node.tagName === 'A') {
					const href = node.getAttribute('href');
					if (href && /^https?:/i.test(href)) el.setAttribute('href', href);
				}
				build(node, el);
				to.appendChild(el);
			}
		};
		build(doc.body, frag);
		return frag;
	}

	OBT.BilingualInjector = BilingualInjector;
	/** 供划词弹窗等复用：引擎/选区 HTML 片段白名单净化（剥壳保字 + a[href] 限 http(s)） */
	OBT.sanitizeTranslationHtml = sanitizeTranslationHtml;
})();
