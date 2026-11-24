/**
 * Popup 逻辑：开/关页面翻译、模型下载与进度、设置入口
 */

import { rpcCall, rpcSubscribe } from '../shared/rpc.js';
import { getSettings, saveSettings } from '../shared/settings.js';

const errorBox = document.getElementById('error');
const progressBars = new Map(); // key → {bar, text}

function showError(message) {
	errorBox.textContent = message;
	errorBox.style.display = 'block';
}

function ensureProgress(key, container) {
	if (progressBars.has(key)) return progressBars.get(key);

	const bar = document.createElement('div');
	bar.className = 'progress';
	bar.innerHTML = '<div></div>';
	const text = document.createElement('div');
	text.className = 'progress-text';
	container.prepend(text);
	container.prepend(bar);
	const entry = { bar: bar.firstElementChild, text };
	progressBars.set(key, entry);
	return entry;
}

function formatBytes(n) {
	if (!n) return '';
	if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
	return `${Math.round(n / 1e3)} KB`;
}

/* ---------------- 模型列表 ---------------- */

/** 翻译方向下拉：追加已安装的「更多语言包」 */
function syncDirectionOptions(directions) {
	const select = document.getElementById('direction');
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
		select.value = 'auto';
		void saveSettings({ translateDirection: 'auto' });
	}
}

async function renderModels() {
	const list = document.getElementById('model-list');
	const { builtin, extraDirections } = await rpcCall('models:list');
	syncDirectionOptions(extraDirections);

	list.innerHTML = '';
	for (const [key, model] of Object.entries(builtin)) {
		const row = document.createElement('div');
		row.innerHTML = `
			<div class="model-row">
				<span>${model.label} <span class="model-status ${
					model.installed ? 'installed' : ''
				}">${model.installed ? '✓ 已就绪' : `未安装 · ${formatBytes(model.totalSize)}`}</span></span>
				${model.installed ? '' : '<button class="btn secondary" style="width:auto;padding:4px 10px;font-size:12px">下载</button>'}
			</div>
		`;
		const button = row.querySelector('button');
		if (button) {
			button.addEventListener('click', () => downloadModel(key, row));
		}
		list.appendChild(row);
	}
}

async function downloadModel(key, row) {
	const entry = ensureProgress(`model-${key}`, row);
	entry.bar.parentElement.style.display = 'block';
	entry.text.style.display = 'block';
	entry.text.textContent = '准备下载…';

	const unsubscribe = rpcSubscribe(`model-${key}`, (chunk) => {
		if (chunk.total > 1 && chunk.total > chunk.loaded) {
			const percent = Math.floor((chunk.loaded / chunk.total) * 100);
			entry.bar.style.width = `${percent}%`;
			entry.text.textContent = `${chunk.label} ${percent}%（${formatBytes(chunk.loaded)}/${formatBytes(chunk.total)}）`;
		} else if (chunk.done && !chunk.cached) {
			entry.text.textContent = `${chunk.label} 下载完成`;
			entry.bar.style.width = '100%';
		} else if (chunk.done && chunk.cached) {
			entry.text.textContent = `${chunk.label} 已缓存`;
		}
	});

	// 订阅错误流
	const errorUnsubscribe = rpcSubscribe(`model-${key}-error`, (chunk) => {
		showError(`模型下载失败：${chunk.message}`);
		entry.text.textContent = '下载失败';
	});

	try {
		await rpcCall('models:download', { key }, { timeoutMs: 0 }); // 语言包下载可达数分钟
		entry.bar.style.width = '100%';
		entry.text.textContent = '安装完成 ✓';
		setTimeout(() => {
			unsubscribe();
			errorUnsubscribe();
			renderModels();
		}, 1200);
	} catch (err) {
		showError(`模型下载失败：${err.message}`);
		entry.text.textContent = '下载失败';
		unsubscribe();
		errorUnsubscribe();
	}
}

/* ---------------- 交互 ---------------- */

document.getElementById('toggle-btn').addEventListener('click', async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;
	try {
		await chrome.tabs.sendMessage(tab.id, { type: 'command:togglePageTranslation' });
		window.close();
	} catch (err) {
		showError('无法连接页面（浏览器内置页或刚打开的页面不支持）。');
	}
});

function openOptions() {
	chrome.runtime.openOptionsPage();
}

document.getElementById('open-options').addEventListener('click', openOptions);

// 「更多语言包」入口：设置页的语言包卡片内可浏览/下载官方仓库的模型
document.getElementById('more-packs').addEventListener('click', (event) => {
	event.preventDefault();
	openOptions();
});

// 双语阅读模式：提取正文后在新标签打开阅读视图（失败在弹窗内提示）
document.getElementById('reader-btn').addEventListener('click', async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;
	try {
		await rpcCall('reader:open', { tabId: tab.id });
		window.close();
	} catch (err) {
		showError(err.message);
	}
});

document.getElementById('ocr-region').addEventListener('click', async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;
	try {
		await chrome.tabs.sendMessage(tab.id, { type: 'command:ocrScreenRegion' });
		window.close();
	} catch (err) {
		showError('无法连接页面。');
	}
});

/* ---------------- 初始化 ---------------- */

(async () => {
	// 方向设置
	const directionSelect = document.getElementById('direction');
	const settings = await getSettings();
	directionSelect.value = settings.translateDirection;
	directionSelect.addEventListener('change', () =>
		saveSettings({ translateDirection: directionSelect.value }),
	);

	// 划词翻译开关：与设置页共用同一个设置项，改动即时生效
	const selectToggle = document.getElementById('selectTranslateEnabled');
	const selectState = document.getElementById('selectTranslateState');
	const syncSelectToggle = (enabled) => {
		selectToggle.checked = enabled;
		selectState.textContent = enabled
			? '已开启 · 选中源语言文本后弹出译文'
			: '已关闭 · 划词不会弹窗';
	};
	syncSelectToggle(settings.selectTranslateEnabled !== false);
	selectToggle.addEventListener('change', () => {
		syncSelectToggle(selectToggle.checked);
		saveSettings({ selectTranslateEnabled: selectToggle.checked });
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && changes.settings) {
			syncSelectToggle(changes.settings.newValue?.selectTranslateEnabled !== false);
		}
	});

	await renderModels();

	// 预热：popup 打开即后台装配当前方向模型（仅已缓存的语言包，不偷偷下载），
	// 用户点「翻译」时引擎通常已就绪，省掉冷启动的模型装配等待
	rpcCall('models:warmup', { direction: settings.translateDirection }).catch(() => {});
})();
