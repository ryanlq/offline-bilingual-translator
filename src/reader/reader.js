/**
 * 双语阅读视图：渲染提取的正文，句级懒翻译（进入视口才批量请求），排版偏好即时生效。
 * 数据来源：后台把 content script 提取的正文写入 storage.local，hash 携带 key。
 *
 * 翻译粒度恒为「句子」（标签平衡切分，Bergamot 本就句级解码，质量等价）：
 * - 交替/双栏排版：显示整段原文 + 句译合并的段落译文
 * - 逐句排版：原文句/译文句交错成行
 * 排版切换纯 CSS，无需重译。
 */

import { rpcCall } from '../shared/rpc.js';
import { getSettings } from '../shared/settings.js';
import { splitSentences } from '../shared/sentences.js';

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
	blocks: [], // 原文数据
	pairs: [], // { block, el, sentences: [{orig, tranEl, text}], tranJoinedEl }
	direction: { from: 'en', to: 'zh' },
	total: 0,
	done: 0,
	title: '',
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

		const sentences = splitSentences(block.html).map((orig) => ({
			orig,
			text: null, // 译文（由翻译队列填充）
		}));
		if (sentences.length === 0) continue;

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

		const sentWrap = document.createElement('div');
		sentWrap.className = 'sentences';
		for (const s of sentences) {
			const row = document.createElement('div');
			row.className = 's-row';
			const sOrig = document.createElement('div');
			sOrig.className = 's-orig';
			sOrig.appendChild(sanitizeFragment(s.orig));
			const sTran = document.createElement('div');
			sTran.className = 's-tran';
			const sPh = document.createElement('span');
			sPh.className = 'ph';
			sPh.textContent = '…';
			sTran.appendChild(sPh);
			row.appendChild(sOrig);
			row.appendChild(sTran);
			sentWrap.appendChild(row);
			s.tranEl = sTran;
		}
		pair.appendChild(sentWrap);

		frag.appendChild(pair);
		state.pairs.push({ block, el: pair, sentences, tranEl: tran, origEl: orig });
		state.total += sentences.length;
	}
	contentEl.appendChild(frag);
	updateProgress();
}

function updateProgress() {
	document.getElementById('progress').textContent = state.total
		? `${state.done}/${state.total} 已翻译`
		: '';
}

/** 段落句译全部到齐后，合并写入交替/双栏视图的整段译文 */
function refreshJoined(pairItem) {
	const texts = pairItem.sentences.map((s) => s.text);
	if (texts.some((t) => t === null)) return;
	const joined = texts.join('');
	pairItem.tranEl.textContent = '';
	pairItem.tranEl.appendChild(sanitizeFragment(joined));
	pairItem.el.classList.remove('pending');
}

/* ---------------- 懒翻译（句子为单元；进入视口才入队；按字符数分片） ---------------- */

const MAX_BATCH_CHARS = 3000;
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
				if (seen.has(entry.target)) continue;
				seen.add(entry.target);
				queueEl.add(entry.target);
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
			// 展开段落里未翻译的句子
			const sentences = [];
			for (const el of queueEl) {
				const item = state.pairs.find((p) => p.el === el);
				if (!item) continue;
				for (const s of item.sentences) {
					if (s.text === null) sentences.push({ item, s, html: s.orig });
				}
			}
			queueEl.clear();
			if (!sentences.length) return;

			// 按字符数切一片（句子的 html 若无标签则转义后进 html 批，保护引擎解析器）
			const esc = (t) =>
				t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			let start = 0;
			while (start < sentences.length) {
				let end = 0;
				let chars = 0;
				while (end < sentences.length - start && end < MAX_BATCH_SIZE) {
					const len = sentences[start + end].html.length + 1;
					if (chars > 0 && chars + len > MAX_BATCH_CHARS) break;
					chars += len;
					end++;
				}
				const slice = sentences.slice(start, start + end);
				const prepared = slice.map(({ html }) => ({
					payload: html.includes('<') ? html : esc(html),
				}));
				try {
					const translations = await rpcCall('translate:texts', {
						texts: prepared.map(({ payload }) => payload),
						from: state.direction.from,
						to: state.direction.to,
						html: true,
					});
					slice.forEach(({ s }, index) => {
						s.text = translations[index] ?? '';
						s.tranEl.textContent = '';
						s.tranEl.appendChild(sanitizeFragment(s.text));
						state.done++;
					});
					// 有句子到齐的段落刷新合并译文
					for (const { item } of slice) refreshJoined(item);
					updateProgress();
				} catch (err) {
					slice.forEach(({ s }) => {
						s.text = '';
						s.tranEl.classList.add('fail');
						s.tranEl.textContent = `⚠ ${err.message}`;
					});
					for (const { item } of slice) refreshJoined(item);
					return; // 模型缺失等错误对后续同样成立
				}
				start += end;
			}
		}
	} finally {
		flushing = false;
	}
}

/* ---------------- 工具栏 ---------------- */

function wireToolbar() {
	// 返回原文：阅读标签通过 openerTabId 记录了来源页（tabs.getCurrent 在扩展页不可靠）。
	// 激活原标签后关闭自己；会话恢复等场景找不到来源时至少关闭自己。
	document.getElementById('back').addEventListener('click', async () => {
		let currentId = null;
		try {
			const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
			currentId = current?.id ?? null;
			let source = null;
			if (currentId != null) {
				const tab = await chrome.tabs.get(currentId).catch(() => null);
				source = tab?.openerTabId ?? null;
			}
			if (source != null) await chrome.tabs.update(source, { active: true });
		} catch {
			/* 查询失败也要关自己 */
		}
		try {
			if (currentId != null) await chrome.tabs.remove(currentId);
		} catch {
			/* 标签可能已被关闭 */
		}
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

	// 导出：双语 Markdown（逐句交错视图优先，交替视图给段落级合并）
	const toMarkdown = () => {
		const lines = [`# ${document.getElementById('a-title').textContent}`, ''];
		for (const p of state.pairs) {
			if (document.body.dataset.style === 'sentence' || p.sentences.every((s) => s.text !== null)) {
				for (const s of p.sentences) {
					const origText = s.tranEl.parentElement.querySelector('.s-orig').textContent.trim();
					const tranText = (s.text ?? '').trim();
					lines.push(origText, '', tranText ? `> ${tranText}` : '', '');
				}
			} else {
				const origText = p.origEl.textContent.trim();
				const tranText = p.tranEl.textContent.trim();
				const tran =
					!tranText || tranText === '…' || tranText.startsWith('⚠') ? '' : `\n\n> ${tranText}`;
				lines.push(`${origText}${tran}`, '');
			}
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
