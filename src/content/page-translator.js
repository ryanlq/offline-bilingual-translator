/**
 * 页面双语对照翻译控制器
 *
 * 流程：收集段落 → 懒加载（进入视口才翻译）→ 批量请求后台 → 注入译文
 * 动态页面通过 MutationObserver 监听新增节点。
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	/** 单片段落数上限（防御性；正常情况下先撞到字符数上限） */
	const MAX_BATCH_SIZE = 50;
	/** 单片累计字符数：比固定段数更均衡——短导航项和长段落的引擎耗时都在可控范围 */
	const MAX_BATCH_CHARS = 4000;

	class PageTranslator {
		constructor() {
			this.injector = new OBT.BilingualInjector();
			/** @type {{from: string, to: string}|null} */
			this.direction = null;
			this.settings = null;

			this.pendingElements = new Set();
			this.queuedElements = new WeakSet();
			this.batchTimer = null;
			this.running = false;
			this.flushing = false;

			this.observer = null; // IntersectionObserver
			this.mutationObserver = null;
		}

		/** @returns {boolean} */
		isRun() {
			return this.running;
		}

		async run(direction, settings) {
			if (this.running) this.stop();
			this.direction = direction;
			this.settings = settings;
			this.running = true;

			this.injector.updateStyle({
				fontSize: settings.fontSize,
				textColor: settings.textColor,
				backgroundColor: settings.backgroundColor,
				hoverHighlight: settings.hoverHighlight,
			});

			// 初始收集
			const paragraphs = OBT.collectParagraphs({
				excludeSelectors: settings.excludeSelectors,
			});

			// 懒加载：进入视口才请求翻译
			this.observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							this.observer.unobserve(entry.target);
							this.enqueue(entry.target);
						}
					}
				},
				{ rootMargin: '200px 0px' },
			);

			for (const { element, text } of paragraphs) {
				this.injector.inject(element, text);
				this.observer.observe(element);
			}

			// 监听动态新增节点与可见性变化（display:none 的内容展开后补翻译）
			// 增量模式：回调里只扫 mutation 涉及的子树，不再全文档重扫
			this.mutationObserver = new MutationObserver(
				debounce((records) => this.collectNew(records), 400),
			);
			this.mutationObserver.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'hidden'],
			});
		}

		/** 收集新增的段落（MutationObserver 回调，增量扫描变化子树） */
		collectNew(mutations) {
			if (!this.running) return;

			// SPA 路由等场景下清理已脱离文档的段落宿主（hosts Map 强引用会泄漏）
			this.injector.sweepRemoved();

			let roots = null;
			if (mutations && mutations.length) {
				roots = [];
				const seen = new Set();
				for (const m of mutations) {
					let node = null;
					if (m.type === 'childList') {
						node = m.addedNodes.length
							? m.addedNodes.find((n) => n.nodeType === Node.ELEMENT_NODE) || m.addedNodes[0]?.parentElement
							: null;
					} else if (m.type === 'attributes') {
						node = m.target; // style/class/hidden 变化可能揭示之前隐藏的内容
					}
					if (node && node.isConnected && !seen.has(node)) {
						seen.add(node);
						roots.push(node);
					}
				}
				if (!roots.length) return;
			}

			const paragraphs = OBT.collectParagraphs({
				excludeSelectors: this.settings.excludeSelectors,
				roots,
			});
			for (const { element, text } of paragraphs) {
				if (this.queuedElements.has(element)) continue;
				this.injector.inject(element, text);
				this.observer.observe(element);
			}
		}

		/**
		 * 入队一个段落
		 * @param {Element} element
		 */
		enqueue(element) {
			if (!this.running || this.queuedElements.has(element)) return;
			this.queuedElements.add(element);
			this.injector.setPending(element);
			this.pendingElements.add(element);

			clearTimeout(this.batchTimer);
			this.batchTimer = setTimeout(() => this.flush(), 300);
		}

		/** 批量翻译队列中的段落（按累计字符数分片，逐片顺序请求） */
		async flush() {
			if (!this.running || this.pendingElements.size === 0) return;

			// 上一轮分片还没发完：延后重试，避免并发请求把引擎队列打满
			if (this.flushing) {
				clearTimeout(this.batchTimer);
				this.batchTimer = setTimeout(() => this.flush(), 200);
				return;
			}

			const batch = [...this.pendingElements];
			this.pendingElements.clear();

			// 文本可能在入队后被页面改写，这里重取；空文本直接丢弃，避免无效请求
			// HTML 模式同时收集内联片段（仅当含标签时才启用，纯文本走原路径零开销）
			const useHtml = this.settings.inlineFormat !== false;
			const items = [];
			for (const element of batch) {
				const text = OBT.__collectText(element);
				if (!text.length) continue;
				let html = null;
				if (useHtml) {
					html = OBT.__collectHtml(element);
					if (!html || !html.includes('<')) html = null; // 无内联标签：回落纯文本，免引擎 HTML 解析开销
				}
				items.push({ element, text, html });
			}

			this.flushing = true;
			try {
				let start = 0;
				while (start < items.length) {
					if (!this.running) return;
					// 按累计字符数切一片（至少收一段，超长段落单独成片）
					let end = start;
					let chars = 0;
					while (end < items.length && end - start < MAX_BATCH_SIZE) {
						const len = items[end].text.length + 1;
						if (chars > 0 && chars + len > MAX_BATCH_CHARS) break;
						chars += len;
						end++;
					}
					const slice = items.slice(start, end);
					const sliceHtml = slice.some(({ html }) => html !== null);
					try {
						// 混合片：html:true 对整批生效，无标签项送转义文本（裸 < 会干扰引擎 HTML 解析）
						const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
						const translations = await OBT.rpcCall('translate:texts', {
							texts: slice.map(({ text, html }) => (sliceHtml ? html ?? esc(text) : text)),
							from: this.direction.from,
							to: this.direction.to,
							html: sliceHtml,
						});
						slice.forEach(({ element, html }, index) => {
							this.injector.setTranslation(element, translations[index] ?? '', { html: sliceHtml && html !== null });
						});
					} catch (err) {
						console.warn('OBT 翻译失败:', err.message);
						// 失败片与其后所有分片统一标记：否则剩余段落永远停在「…」
						const note = `⚠ 翻译失败：${err.message}（修复后重新开启翻译可重试）`;
						for (let j = start; j < items.length; j++) {
							this.injector.setTranslation(items[j].element, note);
						}
						return; // 模型缺失等错误对后续分片同样成立，不再重试
					}
					start = end;
				}
			} finally {
				this.flushing = false;
			}
		}

		stop() {
			this.running = false;
			clearTimeout(this.batchTimer);
			this.observer?.disconnect();
			this.observer = null;
			this.mutationObserver?.disconnect();
			this.mutationObserver = null;
			this.injector.clear();
			this.pendingElements.clear();
			this.queuedElements = new WeakSet();
		}
	}

	function debounce(fn, wait) {
		let timer = null;
		return () => {
			clearTimeout(timer);
			timer = setTimeout(fn, wait);
		};
	}

	OBT.PageTranslator = PageTranslator;
})();
