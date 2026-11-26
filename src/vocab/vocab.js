/**
 * 生词本管理页：列表/搜索/删除、TSV 导出、AnkiConnect 直推与设置。
 */

import { rpcCall, rpcSubscribe } from '../shared/rpc.js';

const ANKI_SETTINGS_KEY = 'ankiSettings';
const DEFAULT_ANKI = {
	deckName: 'Default',
	modelName: 'Basic',
	frontField: 'Front',
	backField: 'Back',
	tags: '',
};

let entries = [];
let filter = '';

const $ = (id) => document.getElementById(id);

/* ---------------- 列表 ---------------- */

function visibleEntries() {
	const q = filter.trim().toLowerCase();
	if (!q) return entries;
	return entries.filter(
		(e) =>
			e.source.toLowerCase().includes(q) ||
			e.translation.toLowerCase().includes(q) ||
			(e.title || '').toLowerCase().includes(q),
	);
}

function renderList() {
	const list = visibleEntries();
	const container = $('vocab-list');
	container.textContent = '';
	$('count').textContent = `${entries.length} 条`;
	$('empty').style.display = entries.length ? 'none' : 'block';

	for (const entry of list) {
		const row = document.createElement('div');
		row.className = 'entry';

		const texts = document.createElement('div');
		texts.className = 'texts';

		const source = document.createElement('div');
		source.className = 'source';
		source.textContent = entry.source;
		texts.appendChild(source);

		const translation = document.createElement('div');
		translation.className = 'translation';
		translation.textContent = entry.translation || '（未翻译）';
		texts.appendChild(translation);

		const meta = document.createElement('div');
		meta.className = 'meta';
		const bits = [
			entry.pair || '',
			new Date(entry.createdAt).toLocaleString(),
		];
		if (entry.title || entry.sourceUrl) {
			// 仅 http(s) 链接可点（防 javascript: 等协议注入），其余按纯文本展示
			if (/^https?:/i.test(entry.sourceUrl || '')) {
				const a = document.createElement('a');
				a.href = entry.sourceUrl;
				a.textContent = entry.title || entry.sourceUrl;
				a.target = '_blank';
				a.rel = 'noreferrer';
				meta.appendChild(a);
			} else {
				const span = document.createElement('span');
				span.textContent = entry.title || '';
				meta.appendChild(span);
			}
		}
		for (const bit of bits) {
			if (!bit) continue;
			const span = document.createElement('span');
			span.textContent = bit;
			meta.appendChild(span);
		}
		texts.appendChild(meta);

		const toTerm = document.createElement('button');
		toTerm.className = 'del';
		toTerm.title = '加入术语表（翻译时强制按此译法）';
		toTerm.textContent = '词';
		toTerm.addEventListener('click', async () => {
			const res = await rpcCall('glossary:add', {
				source: entry.source,
				target: entry.translation || '',
				pair: entry.pair || '',
			});
			flash(res.added ? '已加入术语表 ✓' : '术语表已有该词');
			renderGlossary();
		});

		const del = document.createElement('button');
		del.className = 'del';
		del.title = '删除';
		del.textContent = '✕';
		del.addEventListener('click', async () => {
			await rpcCall('vocab:delete', { id: entry.id });
			entries = entries.filter((e) => e.id !== entry.id);
			renderList();
		});

		row.appendChild(texts);
		row.appendChild(toTerm);
		row.appendChild(del);
		container.appendChild(row);
	}
}

/* ---------------- TSV 导出 ---------------- */

function tsvContent() {
	const cell = (s) => String(s ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
	return visibleEntries()
		.map((e) => `${cell(e.source)}\t${cell(e.translation)}`)
		.join('\n');
}

function downloadTsv() {
	const blob = new Blob(['\ufeff' + tsvContent()], { type: 'text/tab-separated-values' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = `vocab-${new Date().toISOString().slice(0, 10)}.txt`;
	a.click();
	URL.revokeObjectURL(a.href);
	flash('已下载 TSV（Anki 文件导入可直接使用）');
}

/* ---------------- TTS 发音包 ---------------- */

const TTS_VOICES = [
	'serena', 'otis', 'eleanor', 'martha', 'iris', 'grace', 'edith', 'vincent', 'max', 'danny',
];

async function ttsSettings() {
	const { [ANKI_SETTINGS_KEY]: saved } = await chrome.storage.local.get(ANKI_SETTINGS_KEY);
	return { ttsVoice: 'serena', ...(saved && typeof saved === 'object' ? saved : {}) };
}

async function refreshTts() {
	try {
		const status = await rpcCall('tts:status');
		const installed = Boolean(status?.installed);
		$('tts-status').textContent = installed ? '已安装' : `未安装（约 ${Math.round((status?.size ?? 24000000) / 1048576)}MB）`;
		$('tts-status').className = `status ${installed ? 'ok' : ''}`;
		$('tts-install').style.display = installed ? 'none' : '';
		const { [ANKI_SETTINGS_KEY]: saved } = await chrome.storage.local.get(ANKI_SETTINGS_KEY);
		const voice = saved?.ttsVoice ?? 'serena';
		if (TTS_VOICES.includes(voice)) $('tts-voice').value = voice;
	} catch {
		$('tts-status').textContent = '状态未知';
	}
}

function wireTts() {
	$('tts-install').addEventListener('click', async () => {
		const button = $('tts-install');
		button.disabled = true;
		$('tts-status').textContent = '下载中…';
		const unsubscribe = rpcSubscribe('tts-pack', (chunk) => {
			if (chunk.channel) {
				$('tts-status').textContent = `下载中…（${chunk.channel === 'ms' ? '魔搭镜像' : 'HuggingFace'}）`;
			} else if (chunk.note) {
				$('tts-status').textContent = `下载中… ${chunk.note}`;
			} else if (chunk.label?.includes('onnx') && chunk.label) {
				$('tts-status').textContent = `下载中… ${chunk.label.slice(0, 24)}`;
			}
		});
		try {
			await rpcCall('tts:download', { streamId: 'tts-pack' }, { timeoutMs: 0 }); // 弱网下载可达数分钟
			$('tts-status').textContent = '安装完成';
			await refreshTts();
			flash('发音包安装完成 ✓');
		} catch (err) {
			$('tts-status').textContent = '安装失败';
			flash(`发音包安装失败：${err.message.slice(0, 50)}`);
		} finally {
			unsubscribe();
			button.disabled = false;
		}
	});
	$('tts-voice').addEventListener('change', async () => {
		const saved = await ttsSettings();
		await chrome.storage.local.set({
			[ANKI_SETTINGS_KEY]: { ...saved, ttsVoice: $('tts-voice').value },
		});
	});
}

/** 为英文条目合成发音（发音包已安装时）；返回 audio 映射供 anki:push 使用。
 * 批量串行合成，期间按 Esc 可取消（已生成的保留，剩余条目无音频推送）。 */
async function generateAudioFor(entries) {
	const status = await rpcCall('tts:status');
	if (!status?.installed) return { audio: {}, generated: 0, cancelled: false };
	const { ttsVoice } = await ttsSettings();
	const audio = {};
	const eligible = entries.filter((e) => e.pair?.startsWith('en') && e.source.trim());
	let generated = 0;
	let cancelled = false;
	const onCancel = (event) => {
		if (event.key === 'Escape') cancelled = true;
	};
	document.addEventListener('keydown', onCancel);
	try {
		for (const entry of eligible) {
			if (cancelled) break;
			flash(`生成发音 ${generated + 1}/${eligible.length}…（Esc 取消）`);
			try {
				const { wav } = await rpcCall('tts:synthesize', { text: entry.source, voice: ttsVoice });
				audio[entry.id] = { data: wav, filename: `obt-${entry.id}.wav` };
				generated++;
			} catch {
				/* 单条合成失败：无音频推送 */
			}
		}
	} finally {
		document.removeEventListener('keydown', onCancel);
	}
	return { audio, generated, cancelled };
}

async function createObtTemplate() {
	try {
		const result = await rpcCall('anki:createTemplate');
		flash(result.created ? 'OBT 模板已创建 ✓' : 'OBT 模板已存在');
		await connectAnki();
		$('anki-model').value = 'OBT 双语';
		$('anki-model').dispatchEvent(new Event('change'));
		$('anki-front').value = '原文';
		$('anki-back').value = '译文';
		await saveAnkiSettings();
	} catch (err) {
		flash(`创建失败：${err.message.slice(0, 60)}`);
	}
}

/* ---------------- AnkiConnect ---------------- */

function setAnkiStatus(ok, text) {
	const el = $('anki-status');
	el.className = `status ${ok ? 'ok' : 'bad'}`;
	el.textContent = text;
}

async function ankiSettings() {
	const { [ANKI_SETTINGS_KEY]: saved } = await chrome.storage.local.get(ANKI_SETTINGS_KEY);
	return { ...DEFAULT_ANKI, ...(saved && typeof saved === 'object' ? saved : {}) };
}

async function saveAnkiSettings() {
	await chrome.storage.local.set({
		[ANKI_SETTINGS_KEY]: {
			deckName: $('anki-deck').value,
			modelName: $('anki-model').value,
			frontField: $('anki-front').value,
			backField: $('anki-back').value,
			tags: $('anki-tags').value.trim(),
		},
	});
}

function fillSelect(select, values, current) {
	select.textContent = '';
	const placeholder = document.createElement('option');
	placeholder.value = '';
	placeholder.textContent = '—';
	select.appendChild(placeholder);
	for (const value of values) {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	if (current && values.includes(current)) select.value = current;
}

async function connectAnki() {
	setAnkiStatus(false, '连接中…');
	try {
		const status = await rpcCall('anki:status');
		if (!status?.ok) throw new Error(status?.error || '未响应');
		setAnkiStatus(true, `已连接 (API v${status.version})`);

		const saved = await ankiSettings();
		const meta = await rpcCall('anki:meta');
		fillSelect($('anki-deck'), meta.deckNames, saved.deckName);
		// 默认牌组名（Default）在本地化 Anki 里不存在（如中文版为「系统默认」）：
		// 未配置且只有一个牌组时自动选中，避免首次连接显示「—」
		if (!$('anki-deck').value && meta.deckNames.length === 1) {
			$('anki-deck').value = meta.deckNames[0];
		}
		fillSelect($('anki-model'), meta.modelNames, saved.modelName);
		await loadFields(saved);
		$('anki-tags').value = saved.tags || '';
	} catch (err) {
		setAnkiStatus(false, `未连接 — ${err.message.slice(0, 60)}`);
	}
}

async function loadFields(saved) {
	const model = $('anki-model').value;
	if (!model) return;
	try {
		const { fieldNames } = await rpcCall('anki:fields', { modelName: model });
		fillSelect($('anki-front'), fieldNames, saved.frontField);
		fillSelect($('anki-back'), fieldNames, saved.backField);
	} catch {
		/* 模板字段探测失败：保持手输空 */
	}
}

async function pushToAnki() {
	const settings = await ankiSettings();
	await saveAnkiSettings();
	const ids = visibleEntries().map((e) => e.id);
	if (!ids.length) {
		flash('没有可推送的条目');
		return;
	}
	const button = $('anki-push');
	button.disabled = true;
	$('anki-result').textContent = '推送中…';
	try {
		// 发音包已安装时为英文条目合成发音，随卡上传
		const { audio, cancelled: audioCancelled } = await generateAudioFor(visibleEntries());
		const result = await rpcCall('anki:push', {
			ids,
			deckName: $('anki-deck').value || settings.deckName,
			modelName: $('anki-model').value || settings.modelName,
			frontField: $('anki-front').value || settings.frontField,
			backField: $('anki-back').value || settings.backField,
			tags: $('anki-tags').value.split(/[\s,，]+/).filter(Boolean),
			audio,
		});
		const bits = [`新增 ${result.added}`, `跳过(重复) ${result.skipped}`];
		if (audioCancelled) bits.push('发音生成已取消');
		if (result.errors?.length) bits.push(`失败 ${result.errors.length}`);
		$('anki-result').textContent = bits.join(' · ');
		clearTimeout(flashTimer); // 保留最终统计，不被进度闪现覆盖
		if (result.errors?.length) console.warn('Anki 失败明细:', result.errors);
	} catch (err) {
		$('anki-result').textContent = `推送失败：${err.message.slice(0, 80)}`;
	} finally {
		button.disabled = false;
	}
}

/* ---------------- 交互接线 ---------------- */

let flashTimer = null;
function flash(text) {
	const el = $('anki-result');
	el.textContent = text;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		el.textContent = '';
	}, 2000);
}

function wire() {
	$('search').addEventListener('input', (e) => {
		filter = e.target.value;
		renderList();
	});
	$('export-tsv').addEventListener('click', downloadTsv);
	$('copy-tsv').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(tsvContent());
			flash('已复制 TSV');
		} catch {
			flash('复制失败');
		}
	});
	$('clear-all').addEventListener('click', async () => {
		if (!entries.length) return;
		if (!confirm(`确定清空全部 ${entries.length} 条生词？此操作不可撤销。`)) return;
		await rpcCall('vocab:clear');
		entries = [];
		renderList();
	});
	$('anki-refresh').addEventListener('click', connectAnki);
	wireGlossary();
	$('anki-template').addEventListener('click', createObtTemplate);

	$('anki-push').addEventListener('click', pushToAnki);
	$('anki-model').addEventListener('change', async () => {
		const saved = await ankiSettings();
		await loadFields(saved);
	});
	for (const id of ['anki-deck', 'anki-model', 'anki-front', 'anki-back', 'anki-tags']) {
		$(id).addEventListener('change', saveAnkiSettings);
	}
}

(async () => {
	wire();
	const { entries: list, total } = await rpcCall('vocab:list');
	entries = list ?? [];
	$('count').textContent = `${total} 条`;
	renderList();
	wireTts();
	refreshTts();
	refreshGlossary();
	connectAnki();
})();


/* ---------------- 术语表 ---------------- */

let glossaryEntries = [];

function glFlash(text) {
	const el = $('gl-result');
	el.textContent = text;
	setTimeout(() => {
		if (el.textContent === text) el.textContent = '';
	}, 2500);
}

async function refreshGlossary() {
	const { entries } = await rpcCall('glossary:list');
	glossaryEntries = entries ?? [];
	$('glossary-status').textContent = `${glossaryEntries.length} 条`;
	renderGlossary();
}

function renderGlossary() {
	const list = $('gl-list');
	list.textContent = '';
	for (const entry of glossaryEntries) {
		const row = document.createElement('div');
		row.className = 'gl-row';

		const src = document.createElement('span');
		src.className = 'gl-src';
		src.textContent = entry.source;
		row.appendChild(src);

		const arrow = document.createElement('span');
		arrow.className = 'gl-arrow';
		arrow.textContent = '→';
		row.appendChild(arrow);

		const dst = document.createElement('span');
		dst.className = 'gl-dst';
		dst.textContent = entry.target;
		row.appendChild(dst);

		const meta = document.createElement('span');
		meta.className = 'gl-meta';
		meta.textContent = [
			entry.pair || '全部方向',
			entry.site || '全部站点',
			entry.cs ? '区分大小写' : '',
		].filter(Boolean).join(' · ');
		row.appendChild(meta);

		const del = document.createElement('button');
		del.className = 'del';
		del.title = '删除';
		del.textContent = '✕';
		del.addEventListener('click', async () => {
			await rpcCall('glossary:delete', { id: entry.id });
			await refreshGlossary();
		});
		row.appendChild(del);

		list.appendChild(row);
	}
}

function wireGlossary() {
	$('gl-add').addEventListener('click', async () => {
		const source = $('gl-source').value.trim();
		const target = $('gl-target').value.trim();
		if (!source || !target) {
			glFlash('源词与译词不能为空');
			return;
		}
		const res = await rpcCall('glossary:add', {
			source,
			target,
			pair: $('gl-pair').value.replace('_', ''),
			site: $('gl-site').value.trim(),
			cs: $('gl-cs').checked,
		});
		glFlash(res.added ? '已添加 ✓' : '已存在，未重复添加');
		if (res.added) {
			$('gl-source').value = '';
			$('gl-target').value = '';
			await refreshGlossary();
		}
	});
	$('gl-import').addEventListener('click', () => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.csv,.txt';
		input.addEventListener('change', async () => {
			const file = input.files?.[0];
			if (!file) return;
			const csv = await file.text();
			const site = $('gl-site').value.trim();
			const pair = $('gl-pair').value.replace('_', '');
			const res = await rpcCall('glossary:importCsv', { csv, pair, site });
			glFlash(`导入 ${res.added}/${res.total} 条`);
			await refreshGlossary();
		});
		input.click();
	});
	$('gl-export').addEventListener('click', async () => {
		const { csv } = await rpcCall('glossary:exportCsv', {});
		const blob = new Blob(['\ufeff' + csv], { type: 'text/csv' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `glossary-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(a.href);
	});
	$('gl-clear').addEventListener('click', async () => {
		if (!glossaryEntries.length) return;
		if (!confirm(`确定清空全部 ${glossaryEntries.length} 条术语？此操作不可撤销。`)) return;
		await rpcCall('glossary:clear');
		await refreshGlossary();
	});
}
