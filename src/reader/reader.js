/**
 * 双语阅读视图：渲染提取的正文，懒翻译（进入视口才批量请求），排版偏好即时生效。
 * 数据来源：后台把 content script 提取的正文写入 storage.local，hash 携带 key。
 */

import { rpcCall } from '../shared/rpc.js';
import { getSettings } from '../shared/settings.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 译文白名单净化 ---------------- */

const ALLOWED_TAGS = new Set([
	'B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'SMALL', 'SUB', 'SUP', 'ABBR', 'A', 'CODE',
]);

function sanitizeFragment(html) {
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
	const frag = document.createDocumentFragment();
	const build = (from, to) => {
		for (const node of from.childNodes) {
			if (node.nodeType === Node.TEXT_NODE) {
				to.appendChild(document.createTextNode(node.nodeValue));
				continue;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			if (!ALLOWED_TAGS.has(node.tagName)) {
				build(node, to);
				continue;
			}
			const el = document.createElement(node.tagName.toLowerCase());
			if (node.tagName === 'A') {
				const href = node.getAttribute('href');
				if (href && /^https?:/i.test(href)) el.setAttribute('href', href);
				el.setAttribute('target', '_blank');
				el.setAttribute('rel', 'noreferrer');
			}
			build(node, el);
			to.appendChild(el);
		}
	};
	build(doc.body, frag);
	return frag;
}

/* ---------------- 翻译方向 ---------------- */

function resolveDirection(setting, pageLang) {
	if (setting && setting !== 'auto') {
		const m = /^([a-z]{2})([a-z]{2})$/i.exec(setting);
		if (m) return { from: m[1].toLowerCase(), to: m[2].toLowerCase() };
	}
	const isZhPage = /^(zh|.*[-_]zh|.*[-_]hans)/i.test(pageLang || '');
	return isZhPage ? { from: 'zh', to: 'en' } : { from: 'en', to: 'zh' };
}

/* ---------------- 渲染 ---------------- */

const contentEl = document.getElementById('content');
const state = {
	blocks: [], // {type, html, src?, alt?} 原文数据
	pairs: [], // 对应渲染出的 .pair 元素（文本块）
	direction: { from: 'en', to: 'zh' },
	pending: new Map(), // element → {text(html 片段), hasTags}
	translatedCount: 0,
	total: 0,
};

function renderArticle(data) {
	document.getElementById('a-title').textContent = data.title;
	const minutes = Math.max(1, Math.round(data.textLength / 1200));
	const bits = [
		data.byline,
		data.siteName,
		`约 ${minutes} 分钟`,
		data.method === 'fallback' ? '简化提取' : '',
	].filter(Boolean);
	document.getElementById('a-meta').textContent = bits.join(' · ');

	const frag = document.createDocumentFragment();
	for (const block of data.blocks) {
		if (block.type === 'img') {
			const figure = document.createElement('figure');
			figure.className = 'blk-img';
			const img = document.createElement('img');
			img.src = block.src;
			img.loading = 'lazy';
			figure.appendChild(img);
			if (block.alt) {
				const cap = document.createElement('figcaption');
				cap.textContent = block.alt;
				figure.appendChild(cap);
			}
			frag.appendChild(figure);
			continue;
		}

		const pair = document.createElement('div');
		pair.className = 'pair pending';
		pair.dataset.block = block.type;

		const orig = document.createElement('div');
		orig.className = 'orig';
		orig.appendChild(sanitizeFragment(block.html));
		pair.appendChild(orig);

		const tran = document.createElement('div');
		tran.className = 'tran';
		const ph = document.createElement('span');
		ph.className = 'ph';
		ph.textContent = '…';
		tran.appendChild(ph);
		pair.appendChild(tran);

		frag.appendChild(pair);
		state.pairs.push({ block, el: pair });
	}
	contentEl.appendChild(frag);
	state.total = state.pairs.length;
	updateProgress();
}

function updateProgress() {
	const el = document.getElementById('progress');
	el.textContent = state.total
		? `${state.translatedCount}/${state.total} 已翻译`
		: '';
}

/* ---------------- 懒翻译（进入视口才入队，按字符数分片） ---------------- */

const MAX_BATCH_CHARS = 4000;
const MAX_BATCH_SIZE = 40;

const queueEl = new Set();
const seen = new WeakSet();
let observer = null;
let batchTimer = null;
let flushing = false;

function observePairs() {
	observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				const item = state.pairs.find((p) => p.el === entry.target);
				if (!item || seen.has(item.el)) continue;
				seen.add(item.el);
				item.el.querySelector('.tran')?.classList.add('pending');
				queueEl.add(item.el);
			}
			clearTimeout(batchTimer);
			batchTimer = setTimeout(() => flush(), 250);
		},
		{ rootMargin: '500px 0px' },
	);
	for (const p of state.pairs) observer.observe(p.el);
}

async function flush() {
	if (queueEl.size === 0 || flushing) return;
	flushing = true;
	try {
		while (queueEl.size) {
			const items = [...queueEl]
				.map((el) => {
					const item = state.pairs.find((p) => p.el === el);
					return { el, html: item ? item.block.html : '' };
				})
				.filter(({ html }) => html.length > 0);
			if (!items.length) return;

			// 按字符数切一片
			let chars = 0;
			let end = 0;
			while (end < items.length && end < MAX_BATCH_SIZE) {
				const len = items[end].html.length + 1;
				if (chars > 0 && chars + len > MAX_BATCH_CHARS) break;
				chars += len;
				end++;
			}
			const slice = items.slice(0, end);
			for (const it of slice) queueEl.delete(it.el);

			const esc = (t) =>
				t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			const prepared = slice.map(({ html }) => ({
				payload: html.includes('<') ? html : esc(html),
				raw: html,
				hasTags: html.includes('<'),
			}));
			try {
				const translations = await rpcCall('translate:texts', {
					texts: prepared.map(({ payload }) => payload),
					from: state.direction.from,
					to: state.direction.to,
					html: true,
				});
				slice.forEach(({ el }, index) => {
					const tranEl = el.querySelector('.tran');
					tranEl.classList.remove('pending');
					tranEl.textContent = '';
					tranEl.appendChild(sanitizeFragment(translations[index] ?? ''));
					state.translatedCount++;
				});
				updateProgress();
			} catch (err) {
				slice.forEach(({ el }) => {
					const tranEl = el.querySelector('.tran');
					tranEl.classList.remove('pending');
					tranEl.classList.add('fail');
					tranEl.textContent = `⚠ ${err.message}`;
				});
				return; // 模型缺失等错误对后续同样成立
			}
		}
	} finally {
		flushing = false;
	}
}

/* ---------------- 工具栏 ---------------- */

function wireToolbar() {
	document.getElementById('back').addEventListener('click', async () => {
		const [tab] = await chrome.tabs.getCurrent();
		if (tab) chrome.tabs.remove(tab.id);
	});

	for (const btn of document.querySelectorAll('.style-btn')) {
		btn.addEventListener('click', () => {
			document.body.dataset.style = btn.dataset.style;
			for (const b of document.querySelectorAll('.style-btn'))
				b.classList.toggle('active', b === btn);
		});
	}
	document.querySelector('.style-btn[data-style="interleave"]').classList.add('active');

	const applyFont = (delta) => {
		const css = getComputedStyle(document.documentElement).getPropertyValue('--reader-font-size') || '18px';
		let size = parseInt(css) || 18;
		size = Math.min(28, Math.max(14, size + delta));
		document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
	};
	document.getElementById('font-minus').addEventListener('click', () => applyFont(-1));
	document.getElementById('font-plus').addEventListener('click', () => applyFont(1));

	for (const btn of document.querySelectorAll('.theme-btn')) {
		btn.addEventListener('click', () => {
			document.body.dataset.theme = btn.dataset.theme;
		});
	}

	// 导出：双语 Markdown（原文 + 已翻译的译文；未翻译的只有原文）
	const toMarkdown = () => {
		const lines = [`# ${document.getElementById('a-title').textContent}`, ''];
		for (const p of state.pairs) {
			const origText = p.el.querySelector('.orig').textContent.trim();
			const tranText = p.el.querySelector('.tran').textContent.trim();
			const tran = tranText.startsWith('⚠') || tranText === '…' ? '' : `\n\n> ${tranText}`;
			lines.push(`${origText}${tran}`, '');
		}
		return lines.join('\n');
	};
	document.getElementById('export-md').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(toMarkdown());
			flash('已复制到剪贴板');
		} catch {
			flash('复制失败（剪贴板权限）');
		}
	});
	document.getElementById('download-md').addEventListener('click', () => {
		const blob = new Blob([toMarkdown()], { type: 'text/markdown' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = (state.title || '双语文章').replace(/[\\/:*?"<>|]/g, '_') + '.md';
		a.click();
		URL.revokeObjectURL(a.href);
	});
}

let flashTimer = null;
function flash(text) {
	const el = document.getElementById('progress');
	const prev = el.textContent;
	el.textContent = text;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		el.textContent = prev;
	}, 1600);
}

/* ---------------- 会话保活（翻译期间防 SW 休眠） ---------------- */

let keepAlivePort = null;
let keepAliveTimer = null;
function startKeepAlive() {
	if (keepAlivePort) return;
	try {
		keepAlivePort = chrome.runtime.connect({ name: 'obt-keepalive' });
	} catch {
		return;
	}
	keepAliveTimer = setInterval(() => {
		try {
			keepAlivePort.postMessage({ ping: Date.now() });
		} catch {
			/* 端口已断 */
		}
	}, 20000);
}

/* ---------------- 入口 ---------------- */

(async () => {
	const key = decodeURIComponent(location.hash.slice(1));
	const stored = key ? await chrome.storage.local.get(key) : {};
	const data = stored[key];
	if (key) chrome.storage.local.remove(key); // 一次性：读完即删

	wireToolbar();

	if (!data || !data.blocks?.length) {
		document.getElementById('a-title').textContent = '没有可用的阅读数据';
		const err = document.getElementById('error');
		err.style.display = 'block';
		err.textContent = '阅读数据不存在或已被消费。请回到原页面重新发起「双语阅读」。';
		return;
	}

	state.title = data.title;
	state.direction = resolveDirection(
		(await getSettings()).translateDirection,
		data.lang,
	);
	renderArticle(data);
	observePairs();
	startKeepAlive();
})();
