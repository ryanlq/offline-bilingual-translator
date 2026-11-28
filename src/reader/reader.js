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
import { getSettings, saveSettings } from '../shared/settings.js';
import { splitSentences } from '../shared/sentences.js';
import { detectTextLang } from '../shared/detect-lang.js';

/* ---------------- 译文白名单净化 ---------------- */

const ALLOWED_TAGS = new Set([
	'B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'SMALL', 'SUB', 'SUP', 'ABBR', 'A', 'CODE',
]);

// 复用同一个 template 解析（比每次 DOMParser 建整份文档便宜；template 内容脚本惰性，安全性等同）
const parseTemplate = document.createElement('template');

function sanitizeFragment(html) {
	parseTemplate.innerHTML = html;
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
	build(parseTemplate.content, frag);
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
	pairs: [], // { block, el, sentences: [{orig, tranEl, text}], tranEl, origEl, joinedDirty }
	direction: { from: 'en', to: 'zh' },
	total: 0,
	done: 0,
	title: '',
	sourceUrl: '',
};
/** 阅读元素 → 段落条目（O(1) 反查，避免 flush/observer 循环里 O(n) 线性扫） */
const pairByEl = new Map();
const pairByOrigEl = new Map(); // display:contents 无盒元素无法被 IO 观察，改观察原文子元素

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

		// 代码块：只按代码样式渲染，不进翻译队列
		if (block.type === 'pre') {
			const pre = document.createElement('pre');
			pre.className = 'blk-pre';
			pre.appendChild(sanitizeFragment(block.html));
			frag.appendChild(pre);
			continue;
		}

		// 不支持翻译的源语言（日/韩）：只显示原文，不进翻译队列
		const blockLang = detectTextLang(block.html.replace(/<[^>]*>/g, ' '));
		if (blockLang === 'ja' || blockLang === 'ko') {
			const pair = document.createElement('div');
			pair.className = 'pair single';
			const orig = document.createElement('div');
			orig.className = 'orig';
			orig.appendChild(sanitizeFragment(block.html));
			pair.appendChild(orig);
			frag.appendChild(pair);
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
		const pairItem = { block, el: pair, sentences, tranEl: tran, origEl: orig, joinedDirty: false };
		state.pairs.push(pairItem);
		pairByEl.set(pair, pairItem);
		// display:contents 的 .pair 无盒子，IO 需观察有盒子的原文元素
		pairByOrigEl.set(orig, pairItem);
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

/** 段落句译全部到齐后，合并写入交替/双栏视图的整段译文。
 * 逐句风格下合并译文不可见：只标脏，切走逐句时批量重建（避免每句白做全量 DOM 重建）。 */
function refreshJoined(pairItem) {
	const texts = pairItem.sentences.map((s) => s.text);
	if (texts.some((t) => t === null)) return;
	if (document.body.dataset.style === 'sentence') {
		pairItem.joinedDirty = true;
		return;
	}
	const joined = texts.join('');
	pairItem.tranEl.textContent = '';
	pairItem.tranEl.appendChild(sanitizeFragment(joined));
	pairItem.el.classList.remove('pending');
	pairItem.joinedDirty = false;
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
				startKeepAlive(); // 有新内容待译即恢复心跳（幂等）
			}
			clearTimeout(batchTimer);
			batchTimer = setTimeout(() => flush(), 250);
		},
		{ rootMargin: '500px 0px' },
	);
	for (const p of state.pairs) observer.observe(p.origEl);
}

async function flush() {
	if (queueEl.size === 0 || flushing) return;
	// 单语原文模式：暂停拉取翻译（切出单语时自动续翻）
	if (currentStyle() === 'plain') return;
	flushing = true;
	try {
		while (queueEl.size) {
			// 展开段落里未翻译的句子；不能/不用翻译的直接搬到译文侧
			const sentences = [];
			for (const el of queueEl) {
				const item = pairByOrigEl.get(el);
				if (!item) continue;
				for (const s of item.sentences) {
					if (s.text !== null) continue;
					const plain = plainTextOf(s.orig);
					const lang = detectTextLang(plain);
					// 已是目标语言 / 日韩（引擎不支持）/ 非自然语言（纯代码、数字等）：
					// 原文 HTML 直接作为译文，保证阅读连贯不出现乱译
					if (!lang || lang === state.direction.to || lang === 'ja' || lang === 'ko') {
						s.text = s.orig;
						s.tranEl.textContent = '';
						s.tranEl.appendChild(sanitizeFragment(s.orig));
						state.done++;
						refreshJoined(item);
						continue;
					}
					sentences.push({ item, s, html: s.orig });
				}
			}
			queueEl.clear();
			if (!sentences.length) {
				maybeStopKeepAlive();
				return;
			}

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
						siteOrigin: state.sourceUrl ? new URL(state.sourceUrl).origin : undefined,
						signals: { title: state.title, description: '', h1h2: [...document.querySelectorAll('.pair[data-block="h"] .orig')].map((h) => h.textContent.trim()).join(' ').slice(0, 1500), body: document.getElementById('content').textContent.replace(/\s+/g, ' ').slice(0, 5000) },
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
					maybeStopKeepAlive();
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

// ---------------- 侧栏 + 顶栏接线 ----------------

/** 当前排版（plain 时暂停翻译，切出自动续翻） */
function currentStyle() {
	return document.body.dataset.style || 'columns';
}

async function wireSidebar() {
	// 排版模式按钮：切换 + 持久化；从单语切出时恢复翻译
	for (const btn of document.querySelectorAll('.style-btn')) {
		btn.addEventListener('click', () => {
			const wasPlain = currentStyle() === 'plain';
			document.body.dataset.style = btn.dataset.style;
			if (btn.dataset.style !== 'sentence') {
				for (const p of state.pairs) {
					if (p.joinedDirty) refreshJoined(p);
				}
			}
			for (const b of document.querySelectorAll('.side-btn'))
				b.classList.toggle('active', b === btn);
			saveSettings({ readerStyle: btn.dataset.style }).catch(() => {});
			// 从单语切出：恢复被暂停的翻译
			if (wasPlain && btn.dataset.style !== 'plain') flush();
		});
	}
	// 应用已保存的排版
	const savedStyle = (await getSettings()).readerStyle || 'columns';
	const styleBtn = document.querySelector(`.side-btn[data-style="${savedStyle}"]`) || document.querySelector('.side-btn[data-style="columns"]');
	if (styleBtn) {
		document.body.dataset.style = styleBtn.dataset.style;
		styleBtn.classList.add('active');
	}

	// 字号下拉：持久化
	const fontSel = document.getElementById('font-select');
	const savedFont = (await getSettings()).readerFontSize || 18;
	document.documentElement.style.setProperty('--reader-font-size', `${savedFont}px`);
	fontSel.value = String(savedFont);
	fontSel.addEventListener('change', () => {
		const size = Math.min(22, Math.max(14, Number(fontSel.value) || 18));
		document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
		saveSettings({ readerFontSize: size }).catch(() => {});
	});

	// 主题圆点：5 主题 + 持久化
	const savedTheme = (await getSettings()).readerTheme || 'light';
	document.body.dataset.theme = ['blue', 'sepia', 'ink', 'dark'].includes(savedTheme) ? savedTheme : 'light';
	for (const dot of document.querySelectorAll('.dot')) {
		dot.classList.toggle('active', dot.dataset.theme === document.body.dataset.theme);
		dot.addEventListener('click', () => {
			document.body.dataset.theme = dot.dataset.theme;
			for (const d of document.querySelectorAll('.dot'))
				d.classList.toggle('active', d === dot);
			saveSettings({ readerTheme: dot.dataset.theme }).catch(() => {});
		});
	}

	// 导出
	document.getElementById('export-md').addEventListener('click', exportMarkdown);
	document.getElementById('download-md').addEventListener('click', downloadMarkdown);
}

function wireTopbar() {
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

	wireSpeakAll();
	wireBookmark();
	wireSearch();
}

// ---------------- 朗读全文（顺序 TTS + 当前句高亮） ----------------

const speakCtl = { playing: false, stop: false };

function collectSpeakList() {
	const list = [];
	for (const p of state.pairs) {
		for (const s of p.sentences) {
			const row = s.tranEl?.parentElement;
			const text = (s.text ?? plainTextOf(s.orig)).trim();
			if (text) list.push({ row, text });
		}
	}
	return list;
}

function plainTextOf(html) {
	return new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
}

function clearSpeaking() {
	for (const el of document.querySelectorAll('.speaking')) el.classList.remove('speaking');
}

function wireSpeakAll() {
	const btn = document.getElementById('speak-all');
	btn.addEventListener('click', () => {
		if (speakCtl.playing) {
			speakCtl.stop = true;
			speechSynthesis.cancel();
			return;
		}
		const list = collectSpeakList();
		if (!list.length) return;
		speakCtl.playing = true;
		speakCtl.stop = false;
		btn.textContent = '⏹ 停止';
		let i = 0;
		const next = () => {
			clearSpeaking();
			if (speakCtl.stop || i >= list.length) {
				speakCtl.playing = false;
				btn.textContent = '▶ 朗读';
				return;
			}
			const item = list[i++];
			item.row?.classList.add('speaking');
			item.row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
			const u = new SpeechSynthesisUtterance(item.text);
			u.lang = /[\u4e00-\u9fff\u3040-\u30ff]/.test(item.text) ? 'zh-CN' : 'en-US';
			u.rate = 0.95;
			u.onend = () => setTimeout(next, 120);
			u.onerror = () => setTimeout(next, 120);
			speechSynthesis.speak(u);
		};
		next();
	});
}

// ---------------- 书签（按来源页记录阅读位置） ----------------

function bookmarkKey() {
	return state.sourceUrl ? `bm:${hashStr(state.sourceUrl)}` : null;
}

function hashStr(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h).toString(36);
}

function wireBookmark() {
	document.getElementById('bookmark').addEventListener('click', async () => {
		const key = bookmarkKey();
		if (!key) return;
		await chrome.storage.local.set({ [key]: { y: scrollY, t: Date.now() } });
		flash('已记录书签 ✓');
	});
}

async function restoreBookmark() {
	const key = bookmarkKey();
	if (!key) return;
	const { [key]: bm } = await chrome.storage.local.get(key);
	if (bm && typeof bm.y === 'number' && bm.y > 50) {
		scrollTo(0, bm.y);
		flash('已恢复上次阅读位置（书签）');
	}
}

// ---------------- 页内搜索（回车逐个跳转命中） ----------------

const searchState = { hits: [], cur: -1 };

function wireSearch() {
	const input = document.getElementById('search');
	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' || !input.value.trim()) return;
		const q = input.value.trim().toLowerCase();
		if (q !== searchState.q) {
			searchState.q = q;
			searchState.hits = state.pairs
				.filter((p) => p.el.textContent.toLowerCase().includes(q))
				.map((p) => p.el);
			searchState.cur = -1;
		}
		if (!searchState.hits.length) {
			flash(`未找到「${input.value.trim()}」`);
			return;
		}
		searchState.cur = (searchState.cur + 1) % searchState.hits.length;
		const el = searchState.hits[searchState.cur];
		el.scrollIntoView({ block: 'center', behavior: 'smooth' });
		el.classList.add('search-hit');
		setTimeout(() => el.classList.remove('search-hit'), 1600);
		flash(`命中 ${searchState.hits.length} 处 · 第 ${searchState.cur + 1} 个（回车下一个）`);
	});
}

// ---------------- 导出（双语 Markdown） ----------------

function toMarkdown() {
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
}

function exportMarkdown() {
	navigator.clipboard
		.writeText(toMarkdown())
		.then(() => flash('已复制到剪贴板'))
		.catch(() => flash('复制失败（剪贴板权限）'));
}

function downloadMarkdown() {
	const blob = new Blob([toMarkdown()], { type: 'text/markdown' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = (state.title || '双语文章').replace(/[\\/:*?"<>|]/g, '_') + '.md';
	a.click();
	URL.revokeObjectURL(a.href);
}
// ---------------- 目录（由标题块生成） ----------------

function buildToc() {
	const list = document.getElementById('toc-list');
	list.textContent = '';
	let n = 0;
	for (const p of state.pairs) {
		if (p.block?.type !== 'h') continue;
		n++;
		const level = Math.min(4, Math.max(1, Number(p.block.level) || 1));
		const el = p.el;
		el.id = `sec-${n}`;
		const btn = document.createElement('button');
		btn.className = `toc-item lv${level}`;
		btn.textContent = (el.querySelector('.orig') || el).textContent.replace(/\s+/g, ' ').trim().slice(0, 40) || `标题 ${n}`;
		btn.addEventListener('click', () => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
		list.appendChild(btn);
	}
	if (!n) list.textContent = '（本文无标题结构）';
}
let flashTimer = null;
function flash(text) {
	const el = document.getElementById('progress');
	const prev = el.textContent;
	el.textContent = text;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		el.textContent = prev;
	}, 2000);
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

/** 翻译全部完成（或队列清空）后停止心跳，让 SW 正常休眠；新内容入队时会重新启动 */
function maybeStopKeepAlive() {
	if (keepAlivePort && state.done >= state.total && queueEl.size === 0 && !flushing) {
		stopKeepAlive();
	}
}

function stopKeepAlive() {
	clearInterval(keepAliveTimer);
	keepAliveTimer = null;
	try {
		keepAlivePort?.disconnect();
	} catch {
		/* 已断开 */
	}
	keepAlivePort = null;
}

/* ---------------- 入口 ---------------- */

(async () => {
	const key = decodeURIComponent(location.hash.slice(1));
	const stored = key ? await chrome.storage.local.get(key) : {};
	const data = stored[key];
	if (key) chrome.storage.local.remove(key); // 一次性：读完即删

	const settings = await getSettings();
	document.body.dataset.theme = ['blue', 'sepia', 'ink', 'dark'].includes(settings.readerTheme)
		? settings.readerTheme
		: 'light';
	document.documentElement.style.setProperty('--reader-font-size', `${settings.readerFontSize || 18}px`);
	document.body.dataset.style = ['columns', 'sentence', 'interleave', 'plain'].includes(settings.readerStyle)
		? settings.readerStyle
		: 'columns';

	wireSidebar();
	wireTopbar();

	if (!data || !data.blocks?.length) {
		document.getElementById('a-title').textContent = '没有可用的阅读数据';
		const err = document.getElementById('error');
		err.style.display = 'block';
		err.textContent = '阅读数据不存在或已被消费。请回到原页面重新发起「双语阅读」。';
		return;
	}

	state.title = data.title;
	state.sourceUrl = data.sourceUrl || '';
	state.direction = resolveDirection(
		(await getSettings()).translateDirection,
		data.lang,
	);
	renderArticle(data);
	buildToc();
	observePairs();
	startKeepAlive();
	restoreBookmark();
	wireVocabSave();
})();

/* ---------------- 生词本：点击句子/段落收藏（原文+译文成对） ---------------- */

const plainText = (html) =>
	new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();

async function saveVocab(source, translation, el) {
	if (!source) return;
	try {
		const result = await rpcCall('vocab:add', {
			source,
			translation,
			sourceUrl: state.sourceUrl,
			title: state.title,
			pair: `${state.direction.from}${state.direction.to}`,
		});
		flash(result.added ? '已加入生词本 ✓' : '已在生词本中');
		el?.classList.add('saved');
	} catch (err) {
		flash(`收藏失败：${err.message.slice(0, 40)}`);
	}
}

function wireVocabSave() {
	// 点击句子行/段落：弹出操作菜单（加入生词本 / 朗读 / 复制），不再自动收藏
	contentEl.addEventListener('click', (event) => {
		const sRow = event.target.closest('.s-row');
		const pairEl = event.target.closest('.pair');
		const item = pairEl ? pairByEl.get(pairEl) : null;
		if (!item) return;

		if (sRow) {
			const idx = [...sRow.parentElement.children].indexOf(sRow);
			const sentence = item.sentences[idx];
			if (!sentence) return;
			const source = plainText(sentence.orig);
			const translation = sentence.text ?? '';
			openMenu(sRow.getBoundingClientRect(), [
				{ label: '➕ 加入生词本', action: () => saveVocab(source, translation, sRow) },
				{ label: '🔊 朗读原句', action: () => speak(source) },
				{ label: '🔊 朗读译文', action: () => speak(translation) },
				{ label: '📋 复制原文与译文', action: () => copyText(source, translation) },
			]);
			return;
		}
		if (event.target.closest('.tran') || event.target.closest('.orig')) {
			const source = item.origEl.textContent.trim();
			const translation = item.tranEl.textContent.trim();
			openMenu(
				(event.target.closest('.tran') ?? event.target.closest('.orig')).getBoundingClientRect(),
				[
					{ label: '➕ 加入生词本', action: () => saveVocab(source, translation, item.tranEl) },
					{ label: '🔊 朗读原文', action: () => speak(source) },
					{ label: '🔊 朗读译文', action: () => speak(translation) },
					{ label: '📋 复制原文与译文', action: () => copyText(source, translation) },
				],
			);
		}
	});

	// 划词收藏：正文内选中文字（含跨句/跨段）→ 菜单「加入生词本」（先翻译选中文本）
	document.addEventListener('mouseup', (event) => {
		if (event.target.closest('.action-menu')) return;
		if (!event.target.closest('#content')) return;
		const selection = window.getSelection();
		const text = selection?.toString().trim();
		if (!selection || selection.isCollapsed || !text || text.length < 2 || text.length > 2000) return;
		if (!contentEl.contains(selection.anchorNode)) return;

		const rect = selection.getRangeAt(0).getBoundingClientRect();
		openMenu(rect, [
			{
				label: '➕ 加入生词本',
				action: async () => {
					flash('翻译选中文本…');
					try {
						const [translation] = await rpcCall('translate:texts', {
							texts: [text],
							from: state.direction.from,
							to: state.direction.to,
							html: false,
							siteOrigin: state.sourceUrl ? new URL(state.sourceUrl).origin : undefined,
						});
						await saveVocab(text, translation ?? '', null);
					} catch (err) {
						flash(`收藏失败：${err.message.slice(0, 40)}`);
					}
				},
			},
			{ label: '🔊 朗读选中文本', action: () => speak(text) },
			{ label: '📋 复制', action: () => copyText(text, '') },
		]);
	});
}

/* ---------------- 操作菜单 / TTS / 复制 ---------------- */

let menuEl = null;
function closeMenu() {
	menuEl?.remove();
	menuEl = null;
}

// 双击单词查词（词典启用时）：双击处取单词 → rpc 查询 → 浮窗展示音标/释义
contentEl.addEventListener('dblclick', (event) => {
	const sel = window.getSelection();
	const word = (sel?.toString() || '').trim();
	if (!word || /\s/.test(word) || word.length > 40) return;
	if (!/[a-zA-Z]/.test(word)) return;
	let rect = null;
	try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch {}
	lookupWord(word, rect);
});

async function lookupWord(word, rect) {
	let enabled = false;
	let entry = null;
	try {
		enabled = Boolean((await rpcCall('dict:status', {}))?.installed);
		if (enabled) entry = await rpcCall('dict:lookup', { word });
	} catch {
		/* 查询失败静默 */
	}
	closeMenu();
	menuEl = document.createElement('div');
	menuEl.className = 'action-menu dict-menu';
	if (!enabled) {
		menuEl.textContent = '词典未启用（生词本页可开启）';
	} else if (!entry) {
		menuEl.textContent = `未收录「${word}」`;
	} else {
		const head = document.createElement('div');
		head.className = 'dict-head';
		head.textContent = `${entry.w}  /${entry.p || '—'}/`;
		menuEl.appendChild(head);
		const tran = document.createElement('div');
		tran.className = 'dict-body';
		tran.textContent = entry.t.replace(/\r\n/g, '\n');
		menuEl.appendChild(tran);
		const play = document.createElement('button');
		play.className = 'menu-item';
		play.textContent = '🔊 发音';
		play.addEventListener('click', () => {
			closeMenu();
			speak(word);
		});
		menuEl.appendChild(play);
	}
	document.body.appendChild(menuEl);
	const base = rect || { left: innerWidth / 2 - 150, bottom: innerHeight / 2 };
	menuEl.style.left = `${Math.max(8, Math.min(base.left, innerWidth - 320))}px`;
	menuEl.style.top = `${Math.max(8, base.bottom + 6)}px`;
}

function openMenu(anchorRect, items) {
	closeMenu();
	menuEl = document.createElement('div');
	menuEl.className = 'action-menu';
	for (const item of items) {
		const btn = document.createElement('button');
		btn.className = 'menu-item';
		btn.textContent = item.label;
		btn.addEventListener('click', () => {
			closeMenu();
			item.action();
		});
		menuEl.appendChild(btn);
	}
	document.body.appendChild(menuEl);
	let x = Math.max(8, Math.min(anchorRect.left, innerWidth - menuEl.offsetWidth - 8));
	let y = anchorRect.bottom + 6;
	if (y + menuEl.offsetHeight > innerHeight - 8) y = Math.max(8, anchorRect.top - menuEl.offsetHeight - 6);
	menuEl.style.left = `${x}px`;
	menuEl.style.top = `${y}px`;
}

document.addEventListener('mousedown', (event) => {
	if (menuEl && !menuEl.contains(event.target)) closeMenu();
}, true);
document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') closeMenu();
}, true);
addEventListener('scroll', () => closeMenu(), true);
addEventListener('resize', () => closeMenu());

/** 浏览器 TTS 朗读（系统语音，离线可用；按文本内容自动选语言） */
function speak(text) {
	const synth = window.speechSynthesis;
	if (!synth) {
		flash('当前浏览器不支持语音合成');
		return;
	}
	const clean = text.replace(/\s+/g, ' ').trim();
	if (!clean) return;
	synth.cancel();
	const utterance = new SpeechSynthesisUtterance(clean);
	utterance.lang = /[\u4e00-\u9fff\u3040-\u30ff]/.test(clean) ? 'zh-CN' : 'en-US';
	utterance.rate = 0.95;
	synth.speak(utterance);
}

async function copyText(source, translation) {
	const text = translation ? `${source}\n${translation}` : source;
	try {
		await navigator.clipboard.writeText(text);
		flash('已复制');
	} catch {
		flash('复制失败');
	}
}
