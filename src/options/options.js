/**
 * 设置页逻辑
 */

import { rpcCall, rpcSubscribe } from '../shared/rpc.js';
import { OCR_LANGUAGES } from '../shared/models-registry.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../shared/settings.js';

/* ---------------- 表单绑定 ---------------- */

const fields = [
	'fontSize',
	'textColor',
	'hoverHighlight',
	'inlineFormat',
	'selectTranslateEnabled',
	'translateDirection',
	'ocrLangPath',
];

function setField(id, value) {
	const el = document.getElementById(id);
	if (!el) return;
	if (el.type === 'checkbox') el.checked = Boolean(value);
	else el.value = value ?? '';
}

function getField(id) {
	const el = document.getElementById(id);
	if (el.type === 'checkbox') return el.checked;
	if (el.type === 'number') return Number(el.value) || DEFAULT_SETTINGS[id];
	return el.value;
}

let savedTimer = null;
function flashSaved() {
	const saved = document.getElementById('saved');
	saved.classList.add('show');
	clearTimeout(savedTimer);
	savedTimer = setTimeout(() => saved.classList.remove('show'), 1500);
}

/* ---------------- 划词翻译开关（即时生效） ---------------- */

const selectToggle = document.getElementById('selectTranslateEnabled');
const selectState = document.getElementById('selectTranslateState');

function syncSelectToggle(enabled) {
	selectToggle.checked = enabled;
	selectState.textContent = enabled ? '已开启' : '已关闭';
	selectState.classList.toggle('on', enabled);
}

selectToggle.addEventListener('change', async () => {
	const enabled = selectToggle.checked;
	syncSelectToggle(enabled);
	await saveSettings({ selectTranslateEnabled: enabled });
	flashSaved();
});

// 工具栏弹窗里改动时，同步设置页显示
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local' || !changes.settings) return;
	syncSelectToggle(changes.settings.newValue?.selectTranslateEnabled !== false);
});

/* ---------------- 译文样式 / OCR / 排除规则 ---------------- */

async function loadSettings() {
	const settings = await getSettings();
	fields.forEach((id) => setField(id, settings[id]));
	syncSelectToggle(settings.selectTranslateEnabled !== false);
	setField('ocrLangs', settings.ocrLangs);
	setField('ocrDirection', `${settings.ocrFrom}${settings.ocrTo}`);
	setField('excludeSelectors', (settings.excludeSelectors || []).join('\n'));
}

async function saveAll() {
	const excludeText = getField('excludeSelectors');
	const ocrDirection = getField('ocrDirection');
	await saveSettings({
		fontSize: getField('fontSize'),
		textColor: getField('textColor').trim() || DEFAULT_SETTINGS.textColor,
		hoverHighlight: getField('hoverHighlight'),
		inlineFormat: getField('inlineFormat'),
		selectTranslateEnabled: getField('selectTranslateEnabled'),
		translateDirection: getField('translateDirection'),
		ocrLangs: getField('ocrLangs'),
		ocrFrom: ocrDirection.startsWith('en') ? 'en' : 'zh',
		ocrTo: ocrDirection.endsWith('en') ? 'en' : 'zh',
		ocrLangPath: getField('ocrLangPath').trim(),
		excludeSelectors: excludeText
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean),
	});

	flashSaved();
}

document.getElementById('save').addEventListener('click', saveAll);

// 生词本管理页（独立扩展页）
document.getElementById('open-vocab').addEventListener('click', (event) => {
	event.preventDefault();
	chrome.tabs.create({ url: chrome.runtime.getURL('src/vocab/vocab.html') });
});

/* ---------------- OCR 语言选项 ---------------- */

const ocrLangsSelect = document.getElementById('ocrLangs');
for (const [code, lang] of Object.entries(OCR_LANGUAGES)) {
	const option = document.createElement('option');
	option.value = code;
	option.textContent = `${lang.label}（${code}）`;
	ocrLangsSelect.appendChild(option);
}

/* ---------------- 语言包管理 ---------------- */

function formatBytes(n) {
	if (!n) return '';
	if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
	return `${Math.round(n / 1e3)} KB`;
}

const modelProgress = new Map();

function renderProgress(key, container, percent, text) {
	if (!modelProgress.has(key)) {
		const wrapper = document.createElement('div');
		wrapper.innerHTML = `
			<div class="progress"><div></div></div>
			<div class="hint progress-text"></div>
		`;
		container.appendChild(wrapper);
		modelProgress.set(key, {
			bar: wrapper.querySelector('.progress > div'),
			text: wrapper.querySelector('.progress-text'),
		});
	}
	const entry = modelProgress.get(key);
	entry.bar.style.width = `${percent}%`;
	entry.text.textContent = text;
}

/** 翻译方向下拉：追加已安装的「更多语言包」 */
function syncDirectionOptions(directions) {
	const select = document.getElementById('translateDirection');
	if (!select) return;
	const current = select.value || 'auto';
	select.querySelectorAll('option[data-extra]').forEach((option) => option.remove());
	for (const direction of directions || []) {
		const option = document.createElement('option');
		option.value = direction.value;
		option.textContent = `${direction.label}（已安装）`;
		option.dataset.extra = '1';
		select.appendChild(option);
	}
	if ([...select.options].some((option) => option.value === current)) {
		select.value = current;
	} else {
		// 语言包被删除后，避免设置里残留一个不可用的方向
		select.value = 'auto';
		void saveSettings({ translateDirection: 'auto' });
	}
}

async function renderModels() {
	const list = document.getElementById('model-list');
	const { builtin, extraDirections } = await rpcCall('models:list');
	syncDirectionOptions(extraDirections);

	list.innerHTML = '';
	modelProgress.clear();

	for (const [key, model] of Object.entries(builtin)) {
		const item = document.createElement('div');
		item.className = 'model-item';
		item.innerHTML = `
			<div>
				<div><b>${model.label}</b> <span class="hint">v${model.version} · ${formatBytes(model.totalSize)}</span></div>
				<div class="hint status">${model.installed ? '✓ 已就绪（离线可用）' : '未安装'}</div>
			</div>
			<div class="actions"></div>
		`;
		const actions = item.querySelector('.actions');

		const downloadBtn = document.createElement('button');
		downloadBtn.textContent = model.installed ? '重新下载' : '下载';
		downloadBtn.className = 'primary';
		downloadBtn.addEventListener('click', () => downloadModel(key, item));
		actions.appendChild(downloadBtn);

		if (model.installed) {
			const deleteBtn = document.createElement('button');
			deleteBtn.textContent = '删除';
			deleteBtn.className = 'danger';
			deleteBtn.addEventListener('click', async () => {
				if (!confirm(`确定删除「${model.label}」模型？删除后离线翻译不可用。`)) return;
				await rpcCall('models:delete', { key });
				renderModels();
			});
			actions.appendChild(deleteBtn);
		}

		list.appendChild(item);
	}
}

async function downloadModel(key, item, onDone) {
	const status = item.querySelector('.status');
	const unsubscribe = rpcSubscribe(`model-${key}`, (chunk) => {
		status.textContent = `下载中…`;
		if (chunk.total > 1 && chunk.total > chunk.loaded) {
			const percent = Math.floor((chunk.loaded / chunk.total) * 100);
			renderProgress(key, item, percent, `${chunk.label} ${percent}%（${formatBytes(chunk.loaded)}/${formatBytes(chunk.total)}）`);
		} else if (chunk.done && chunk.cached) {
			renderProgress(key, item, 100, `${chunk.label} 已缓存`);
		} else if (chunk.done) {
			renderProgress(key, item, 100, `${chunk.label} 完成`);
		}
	});

	try {
		await rpcCall('models:download', { key }, { timeoutMs: 0 }); // 语言包下载可达数分钟
	} catch (err) {
		alert(`模型下载失败：${err.message}`);
	}
	unsubscribe();
	await renderModels();
	if (onDone) await onDone();
}

/* ---------------- 更多语言包（Bergamot 官方仓库） ---------------- */

const extraPanel = document.getElementById('extra-panel');
const extraStatus = document.getElementById('extra-status');
const extraList = document.getElementById('extra-list');
const morePacksBtn = document.getElementById('more-packs');
let extraLoaded = false;

async function refreshExtra({ refresh = false } = {}) {
	extraList.innerHTML = '';
	modelProgress.clear();
	extraStatus.textContent = '正在获取语言包列表…';

	try {
		const { packs, source, error } = await rpcCall('models:extraList', { refresh });
		if (!packs.length) {
			extraStatus.textContent =
				`暂时无法获取语言包列表${error ? `（${error}）` : ''}，请联网后点「刷新列表」。`;
			return;
		}
		const origin = source === 'remote' ? '官方仓库（实时）' : '本地缓存';
		extraStatus.textContent =
			`共 ${packs.length} 个语言包 · 来源：${origin}${error ? `（${error}）` : ''}。` +
			'下载完成后即可在「翻译方向」中选用。';

		for (const pack of packs) {
			const item = document.createElement('div');
			item.className = 'model-item';
			item.innerHTML = `
				<div>
					<div><b>${pack.label}</b> <span class="hint">${pack.key} · ${formatBytes(pack.totalSize)}</span></div>
					<div class="hint status">${pack.installed ? '✓ 已就绪（离线可用）' : '未安装'}</div>
				</div>
				<div class="actions"></div>
			`;
			const actions = item.querySelector('.actions');

			const downloadBtn = document.createElement('button');
			downloadBtn.textContent = pack.installed ? '重新下载' : '下载';
			downloadBtn.className = 'primary';
			downloadBtn.addEventListener('click', () =>
				downloadModel(pack.key, item, () => refreshExtra()),
			);
			actions.appendChild(downloadBtn);

			if (pack.installed) {
				const deleteBtn = document.createElement('button');
				deleteBtn.textContent = '删除';
				deleteBtn.className = 'danger';
				deleteBtn.addEventListener('click', async () => {
					if (!confirm(`确定删除「${pack.label}」语言包？`)) return;
					await rpcCall('models:delete', { key: pack.key });
					await renderModels();
					await refreshExtra();
				});
				actions.appendChild(deleteBtn);
			}
			extraList.appendChild(item);
		}
	} catch (err) {
		extraStatus.textContent = `获取语言包列表失败：${err.message}`;
	}
}

morePacksBtn.addEventListener('click', async () => {
	extraPanel.hidden = !extraPanel.hidden;
	morePacksBtn.textContent = extraPanel.hidden ? '更多语言包 ▾' : '更多语言包 ▴';
	if (!extraPanel.hidden && !extraLoaded) {
		extraLoaded = true;
		await refreshExtra();
	}
});

document
	.getElementById('extra-refresh')
	.addEventListener('click', () => refreshExtra({ refresh: true }));

/* ---------------- 初始化 ---------------- */

(async () => {
	// 串行：先填充表单（含已保存的翻译方向），再追加已安装语言包选项
	await loadSettings();
	await renderModels();
})();
