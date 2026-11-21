/**
 * 页面段落文本提取（自研实现，参考 domtranslator 与 Linguist 的思路）
 *
 * 策略：通用「叶子块」遍历——从 body 出发递归，凡是**不含块级后裔**的块级
 * 元素即为一个段落单元。不再依赖固定的标签白名单（p/h1/li/…），因此
 * `<div class="page"><div class="content"><div>正文</div></div></div>` 这类
 * 现代站点常见的任意嵌套 div 同样能被收集。
 *
 * 额外覆盖：
 * - open Shadow Root：遍历时深入 el.shadowRoot（closed 无法穿透，见 README 已知限制）
 * - display:contents 的透明容器直接下钻
 * - 内联元素里偶发的块级子元素（如 <a> 卡片）也继续下钻
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	/** 块级后裔判定用的标签集（启发式，配合 computed display 使用） */
	const BLOCK_DESC_SELECTOR = [
		'div', 'main', 'section', 'article', 'aside', 'nav', 'header', 'footer',
		'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
		'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
		'blockquote', 'pre', 'figure', 'figcaption', 'form', 'fieldset',
		'details', 'summary', 'address', 'hgroup',
	].join(',');

	/** 不可翻译的标签 */
	const SKIP_TAGS = new Set([
		'script', 'style', 'noscript', 'textarea', 'code', 'pre', 'kbd', 'samp',
		'svg', 'canvas', 'math', 'template', 'select', 'option', 'button', 'input',
		'label', 'time', 'iframe', 'object', 'embed', 'audio', 'video', 'picture',
		'source', 'track', 'map', 'area', 'slot', 'head', 'meta', 'link', 'title',
	]);

	/** 元素是否可见 */
	function isVisible(element) {
		if (element instanceof HTMLElement && element.hidden) return false;
		const style = getComputedStyle(element);
		return (
			style.display !== 'none' &&
			style.visibility !== 'hidden' &&
			parseFloat(style.opacity || '1') > 0
		);
	}

	/** 是否处于被排除的选择器内 */
	function isExcluded(element, excludeSelectors) {
		if (!excludeSelectors.length) return false;
		return excludeSelectors.some((selector) => {
			try {
				return element.matches(selector) || element.closest(selector);
			} catch {
				return false; // 无效选择器
			}
		});
	}

	/** 判断元素是否包含块级后裔（有则是容器，需继续下钻） */
	function hasBlockDescendant(element) {
		return element.querySelector(BLOCK_DESC_SELECTOR) !== null;
	}

	/** 元素是否为块级盒（用于区分容器 / 叶子 / 内联） */
	function displayMode(element) {
		return getComputedStyle(element).display;
	}

	/**
	 * 提取元素的可见文本（拼接直接文本与内联子元素文本）
	 */
	function collectText(element) {
		let text = '';
		for (const node of element.childNodes) {
			if (node.nodeType === Node.TEXT_NODE) {
				text += node.nodeValue;
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				const tag = node.tagName.toLowerCase();
				if (SKIP_TAGS.has(tag)) continue;
				// 图片说明文字是正文的一部分（p/figure 内的 img 很常见）：
				// img 本身无文本子节点，把 alt 拼进段落文本
				if (tag === 'img') {
					const alt = (node.getAttribute('alt') || '').trim();
					if (alt) text += ` ${alt} `;
					continue;
				}
				// 块级子元素的文本由其自身作为叶子收集，避免重复
				const display = getComputedStyle(node).display;
				if (display === 'none' || display === 'block' || display === 'flex' || display === 'grid') {
					continue;
				}
				text += collectText(node);
			}
		}
		return text;
	}

	/** 元素的 HTML 片段（仅保留内联标签，供引擎 html 模式使用） */
	const INLINE_KEEP = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 'span', 'small', 'sub', 'sup', 'abbr']);

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	function collectHtml(element) {
		const parts = [];
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE) {
					parts.push(escapeHtml(child.nodeValue));
					continue;
				}
				if (child.nodeType !== Node.ELEMENT_NODE) continue;
				const tag = child.tagName.toLowerCase();
				if (SKIP_TAGS.has(tag)) continue;
				// img alt 是正文的一部分（与 collectText 口径一致）
				if (tag === 'img') {
					const alt = (child.getAttribute('alt') || '').trim();
					if (alt) parts.push(` ${escapeHtml(alt)} `);
					continue;
				}
				const display = getComputedStyle(child).display;
				if (display === 'none') continue;
				// 块级子元素的文本由其自身作为叶子收集，避免重复
				if (display === 'block' || display === 'flex' || display === 'grid' || display === 'contents') continue;
				if (INLINE_KEEP.has(tag)) {
					parts.push(`<${tag}>`);
					walk(child);
					parts.push(`</${tag}>`);
				} else {
					// 其它内联标签（mark/cite/dfn…）：剥壳保字，减少引擎解析负担
					walk(child);
				}
			}
		};
		walk(element);
		// br 不交给引擎（bergamot HTML 子集未覆盖），当空白折叠掉
		return parts.join(' ').replace(/\s+/g, ' ').trim();
	}

	/** 是否为"有意义的文本"（包含至少 2 个连续字母或 1 个 CJK 字符） */
	function isMeaningful(text, minLength) {
		if (!text || text.trim().length < (minLength ?? 4)) return false;
		if (/[a-zA-Z]{2,}/.test(text)) return true;
		if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(text)) return true;
		return false;
	}

	/**
	 * 收集页面可翻译段落
	 * @param {{excludeSelectors?: string[], minLength?: number, roots?: Element[]|null}} options
	 *   roots: 增量模式——只从这些变化子树找（MutationObserver 用）；缺省时全文档扫描。
	 * @returns {{element: Element, text: string}[]}
	 */
	OBT.collectParagraphs = function (options = {}) {
		const { excludeSelectors = [], minLength = 4, roots = null } = options;
		const results = [];

		const consider = (element) => {
			if (element.hasAttribute('data-obt-original')) return; // 已处理
			// 译文宿主绝不能再当原文收集，否则会自我翻译
			if (element.hasAttribute('data-obt-host') || element.closest('[data-obt-host]')) return;
			const text = collectText(element).replace(/\s+/g, ' ').trim();
			if (!isMeaningful(text, minLength)) return;
			results.push({ element, text });
		};

		const handleElement = (element) => {
			if (SKIP_TAGS.has(element.tagName.toLowerCase())) return;
			if (element.closest('pre, code, [contenteditable="true"]')) return;
			if (isExcluded(element, excludeSelectors)) return;
			if (!isVisible(element)) return;

			// open shadow root 中的内容同样收集（closed 无法穿透）
			if (element.shadowRoot) walk(element.shadowRoot);

			const display = displayMode(element);

			// display:contents 的元素自身不产生盒子，直接下钻
			if (display === 'contents') {
				walk(element);
				return;
			}

			if (!display.startsWith('inline') && display !== 'none') {
				// 块级：是容器就下钻，否则作为叶子段落
				if (hasBlockDescendant(element)) {
					walk(element);
				} else {
					consider(element);
				}
			} else if (display !== 'none' && hasBlockDescendant(element)) {
				// 内联元素里偶发块级子元素（如 <a> 卡片）：继续下钻
				walk(element);
			}
		};

		const walk = (container) => {
			for (const element of container.children) handleElement(element);
		};

		if (roots && roots.length) {
			// 增量模式：变化子树自身按元素逻辑处理（可能本身是叶子或容器）
			for (const root of roots) handleElement(root);
		} else if (document.body) {
			walk(document.body);
		}

		return results;
	};

	/** 暴露内部收集函数（供 PageTranslator 按需取纯文本 / HTML 片段） */
	OBT.__collectText = function (element) {
		return collectText(element).replace(/\s+/g, ' ').trim();
	};
	OBT.__collectHtml = function (element) {
		return collectHtml(element);
	};
})();
