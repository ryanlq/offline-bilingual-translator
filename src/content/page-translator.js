/**
 * 页面双语对照翻译控制器
 *
 * 流程：收集段落 → 懒加载（进入视口才翻译）→ 批量请求后台 → 注入译文
 * 动态页面通过 MutationObserver 监听新增节点。
 */

(function () {
	'use strict';

	const OBT = self.OBT;

/** 单次请求的最大段落数：过大的一次调用会拖长首屏等待且难以反馈进度 */
const MAX_BATCH_SIZE = 20;

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
			this.mutationObserver = new MutationObserver(
				debounce(() => this.collectNew(), 400),
			);
			this.mutationObserver.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'hidden'],
			});
		}

		/** 收集新增的段落（MutationObserver 回调） */
		collectNew() {
			if (!this.running) return;
			const paragraphs = OBT.collectParagraphs({
				excludeSelectors: this.settings.excludeSelectors,
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

		/** 批量翻译队列中的段落（按 MAX_BATCH_SIZE 分片，逐片顺序请求） */
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
			const items = batch
				.map((element) => ({ element, text: OBT.__collectText(element) }))
				.filter(({ text }) => text.length > 0);

			this.flushing = true;
			try {
				for (let i = 0; i < items.length; i += MAX_BATCH_SIZE) {
					if (!this.running) return;
					const slice = items.slice(i, i + MAX_BATCH_SIZE);
					try {
						const translations = await OBT.rpcCall('translate:texts', {
							texts: slice.map(({ text }) => text),
							from: this.direction.from,
							to: this.direction.to,
						});
						slice.forEach(({ element }, index) => {
							this.injector.setTranslation(element, translations[index] ?? '');
						});
					} catch (err) {
						console.warn('OBT 翻译失败:', err.message);
						slice.forEach(({ element }) => {
							this.injector.setTranslation(element, `⚠ 翻译失败（${err.message}）`);
						});
						return; // 模型缺失等错误对后续分片同样成立，不再重试
					}
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
