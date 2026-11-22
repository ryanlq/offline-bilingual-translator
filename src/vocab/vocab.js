/**
 * 生词本管理页：列表/搜索/删除、TSV 导出、AnkiConnect 直推与设置。
 */

import { rpcCall } from '../shared/rpc.js';

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
			const a = document.createElement('a');
			a.href = entry.sourceUrl || '#';
			a.textContent = entry.title || entry.sourceUrl;
			a.target = '_blank';
			a.rel = 'noreferrer';
			meta.appendChild(a);
		}
		for (const bit of bits) {
			if (!bit) continue;
			const span = document.createElement('span');
			span.textContent = bit;
			meta.appendChild(span);
		}
		texts.appendChild(meta);

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
		const result = await rpcCall('anki:push', {
			ids,
			deckName: $('anki-deck').value || settings.deckName,
			modelName: $('anki-model').value || settings.modelName,
			frontField: $('anki-front').value || settings.frontField,
			backField: $('anki-back').value || settings.backField,
			tags: $('anki-tags').value.split(/[\s,，]+/).filter(Boolean),
		});
		const bits = [`新增 ${result.added}`, `跳过(重复) ${result.skipped}`];
		if (result.errors?.length) bits.push(`失败 ${result.errors.length}`);
		$('anki-result').textContent = bits.join(' · ');
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
	connectAnki();
})();
