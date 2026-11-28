/**
 * 双语阅读模式 · 正文提取器
 *
 * 主路径：Mozilla Readability（火狐阅读模式同款解析器，按需注入 vendor/readability/*），
 * 输出经白名单净化为受限段落片段；降级路径：复用叶子块收集器（collectParagraphs）。
 *
 * 由后台通过 chrome.scripting.executeScript 按需注入本文件后调用 OBT.extractArticle()。
 * 仅在注入瞬间存在，不随所有页面常驻（解析器 90KB 不进普通页面）。
 */

(function () {
	'use strict';

	const OBT = self.OBT;
	if (!OBT) return;

	/** 阅读视图保留的内联标签（译文与原文共用同一白名单口径） */
	const INLINE_KEEP = new Set([
		'a', 'b', 'strong', 'i', 'em', 'u', 'span', 'small', 'sub', 'sup', 'abbr', 'code', 'br',
	]);

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	/** 把元素序列化为白名单内联片段（剥离 img 与其它标签，保字） */
	function cleanFragment(el) {
		const parts = [];
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE) {
					parts.push(escapeHtml(child.nodeValue));
					continue;
				}
				if (child.nodeType !== Node.ELEMENT_NODE) continue;
				const tag = child.tagName.toLowerCase();
				if (tag === 'br') {
					parts.push(' ');
					continue;
				}
				// img 本体在段落里不保留，但 alt 说明文字是正文的一部分（与整页模式口径一致）
				if (tag === 'img') {
					const alt = (child.getAttribute('alt') || '').trim();
					if (alt) parts.push(` ${escapeHtml(alt)} `);
					continue;
				}
				if (INLINE_KEEP.has(tag)) {
					parts.push(`<${tag}>`);
					walk(child);
					parts.push(`</${tag}>`);
				} else {
					walk(child);
				}
			}
		};
		walk(el);
		return parts.join(' ').replace(/\s+/g, ' ').trim();
	}

	function hasMeaningfulText(html) {
		const text = html.replace(/<[^>]*>/g, ' ');
		if (!text || text.trim().length < 2) return false;
		return /[a-zA-Z]{2,}/.test(text) || /[\u4e00-\u9fff\u3040-\u30ff]/.test(text);
	}

	/** 从 Readability 输出的 content HTML 收集有序段落/标题/图片块 */
	function harvestBlocks(contentHtml, baseUrl) {
		const doc = new DOMParser().parseFromString(`<body>${contentHtml}</body>`, 'text/html');
		const body = doc.body;
		const out = [];
		const taken = new WeakSet();

		const abs = (src) => {
			try {
				return new URL(src, baseUrl).toString();
			} catch {
				return null;
			}
		};

		const pushImg = (img) => {
			const src = abs(img.getAttribute('src') || '');
			if (!src || src.startsWith('data:') || taken.has(img)) return;
			taken.add(img);
			const alt = (img.getAttribute('alt') || '').trim();
			out.push({ type: 'img', src, alt });
		};

		const visit = (el) => {
			for (const child of el.children) {
				const tag = child.tagName.toLowerCase();

				if (tag === 'img') {
					pushImg(child);
					continue;
				}
				if (tag === 'figure' || tag === 'picture') {
					const img = child.querySelector('img');
					if (img) pushImg(img);
					const cap = child.querySelector('figcaption');
					if (cap && !taken.has(cap)) {
						const html = cleanFragment(cap);
						if (hasMeaningfulText(html)) out.push({ type: 'p', html });
						taken.add(cap);
					}
					continue;
				}

				const isHeading = /^h[1-6]$/.test(tag);
				// pre（代码块）单独成块：保留原文不翻译，阅读模式按代码样式渲染
				if (tag === 'pre') {
					if (taken.has(child)) continue;
					taken.add(child);
					const html = cleanFragment(child);
					if (hasMeaningfulText(html)) out.push({ type: 'pre', html });
					continue;
				}
				const isPara = ['p', 'li', 'blockquote', 'figcaption', 'dt', 'dd'].includes(tag);
				if (isHeading || isPara) {
					if (taken.has(child)) continue;
					taken.add(child);
					const html = cleanFragment(child);
					if (hasMeaningfulText(html)) {
						out.push({ type: isHeading ? 'h' : 'p', html, level: isHeading ? Number(tag[1]) : 0 });
					}
					continue;
				}

				// 容器节点：下钻；自身若带少量直接文本（如 div>text），兜底收集
				if (child.children.length) {
					visit(child);
					taken.add(child);
				} else {
					const html = cleanFragment(child);
					if (hasMeaningfulText(html)) out.push({ type: 'p', html });
				}
			}
		};

		visit(body);
		return out;
	}

	/** 降级路径：叶子块收集（collectParagraphs）+ 内联片段；rootDoc: 在干净克隆文档上收集（避开翻译宿主标记） */
	function harvestFallback(rootDoc) {
		if (typeof OBT.collectParagraphs !== 'function') return []; // text-collector 未注入时降级不可用
		// 克隆文档可能带整页翻译的宿主与标记：剥除后再收集（克隆本身即弃，可原地改）
		if (rootDoc) {
			rootDoc.querySelectorAll('[data-obt-host]').forEach((n) => n.remove());
			rootDoc.querySelectorAll('[data-obt-original]').forEach((n) => n.removeAttribute('data-obt-original'));
		}
		const paragraphs = OBT.collectParagraphs({ rootDoc: rootDoc || null });
		return paragraphs.map(({ element }) => {
			const tag = element.tagName.toLowerCase();
			const html = OBT.__collectHtml(element);
			return {
				type: /^h[1-6]$/.test(tag) ? 'h' : 'p',
				html,
				level: /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0,
			};
		});
	}

	/**
	 * 提取当前页面正文，产出阅读视图数据包
	 * @returns {{ok: boolean, reason?: string, data?: object}} data 直接作为阅读视图数据包
	 */
	OBT.extractArticle = function () {
		let parsed = null;
		let method = 'readability';

		try {
			// 克隆文档：避免 Readability 改动真实 DOM；顺带剥离本扩展注入的译文宿主。
			// 不用 isProbablyReaderable 门控（启发式偏保守，简单文章页会被误判），
			// 直接尝试 parse，失败/产出过少时走降级路径。
			const doc = document.cloneNode(true);
			doc.querySelectorAll('[data-obt-host]').forEach((n) => n.remove());
			doc.querySelectorAll('[data-obt-original]').forEach((n) => n.removeAttribute('data-obt-original'));
			parsed = new Readability(doc, { charThreshold: 300 }).parse();
		} catch {
			parsed = null;
		}

		let blocks = [];
		if (parsed && parsed.content) {
			try {
				blocks = harvestBlocks(parsed.content, document.location.href);
			} catch {
				blocks = [];
			}
		}

		if (blocks.length < 3) {
			// 降级：叶子块收集（在干净克隆文档上收集，避开已翻译标记与译文宿主）
			method = 'fallback';
			try {
				blocks = harvestFallback(doc);
			} catch {
				blocks = [];
			}
		}

		// 索引/列表型页面检测：源文档有大量标题，但 Readability 产出几乎丢弃了全部标题
		// （如 api.jquery.com 的 354 个接口名 h1 全被剥掉，只留描述段落——读起来无法知道
		// 每段说的是哪个接口）。此类页面降级为叶子块收集，标题与描述都能保留。
		const headingBlocks = blocks.filter((b) => b.type === 'h').length;
		let srcHeadings = 0;
		document.querySelectorAll('h1, h2, h3').forEach((el) => {
			if ((el.textContent || '').trim().length >= 2) srcHeadings++;
		});
		let fbError = null;
		if (srcHeadings >= 6 && headingBlocks <= 2) {
			method = 'fallback';
			try {
				// 注意：Readability.parse 会原地掏空传入文档（剥掉全部标题），
				// 必须用全新克隆收集，才能拿回完整标题结构
				blocks = harvestFallback(document.cloneNode(true));
			} catch (err) {
				fbError = String(err.message || err).slice(0, 120);
				// 回退失败：保留 Readability 产物（退化但可用）
			}
		}
		window.__obtDiag = { srcHeadings, headingBlocks, method, fbCount: blocks.length, fbError, extractWorld: 'x' };
		const __diagSnapshot = JSON.stringify(window.__obtDiag);

		if (blocks.length < 1) return { ok: false, reason: 'no-content' };

		const textLength = blocks
			.filter((b) => b.type !== 'img')
			.reduce((sum, b) => sum + b.html.replace(/<[^>]*>/g, '').length, 0);

		return {
			ok: true,
			__diagSnapshot,
			data: {
				title: (parsed && parsed.title) || document.title || '未命名页面',
				byline: (parsed && parsed.byline) || '',
				siteName: (parsed && parsed.siteName) || document.location.hostname,
				sourceUrl: document.location.href,
				lang: (parsed && parsed.lang) || document.documentElement.lang || '',
				method,
				capturedAt: Date.now(),
				blocks,
				textLength,
			},
		};
	};
})();
