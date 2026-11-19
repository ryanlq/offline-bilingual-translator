/**
 * 后台 Service Worker
 *
 * 职责：
 * 1. 管理 offscreen 文档（翻译引擎与 OCR 的宿主）
 * 2. 翻译编排：读取/下载模型缓存 → 组装 buffers → 调用引擎
 * 3. 右键菜单与快捷键命令
 * 4. 截屏（OCR 用）
 */

import { rpcCall, rpcListen, rpcEmit } from '../shared/rpc.js';
import {
	BUILTIN_MODELS,
	S3_REGISTRY_URL,
	buildExtraRegistry,
} from '../shared/models-registry.js';
import {
	getModelFile,
	listStoredModels,
	ensureModelFile,
	deleteModel,
} from './model-store.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

// Firefox 事件页：后台自带 DOM，引擎（offscreen.js）随本页加载，
// rpc.js 本地路由直调，无需（也无法）创建 offscreen 文档。
// Chrome SW 无 document → 走 offscreen 路径。
const LOCAL_ENGINE = typeof document !== 'undefined' && !chrome.offscreen?.createDocument;
const IS_FIREFOX = chrome.runtime.getURL('/').startsWith('moz-extension://');

/* ---------------- offscreen 管理 ---------------- */

let creatingOffscreen = null;

async function hasOffscreen() {
	if (LOCAL_ENGINE) return true;
	const contexts = await chrome.runtime.getContexts({
		contextTypes: ['OFFSCREEN_DOCUMENT'],
		documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
	});
	return contexts.length > 0;
}

async function ensureOffscreen() {
	if (LOCAL_ENGINE) return;
	if (await hasOffscreen()) return;

	if (!creatingOffscreen) {
		creatingOffscreen = chrome.offscreen
			.createDocument({
				url: OFFSCREEN_URL,
				reasons: ['WORKERS', 'DOM_PARSER'],
				justification: '承载离线翻译引擎 Worker 与 OCR',
			})
			.finally(() => {
				creatingOffscreen = null;
			});
	}
	return creatingOffscreen;
}

async function offscreenReady() {
	if (LOCAL_ENGINE) return; // 引擎已随本页加载，rpcCall 走本地路由，无需 ping
	// 创建后轮询 ping，避免 ready 事件先于订阅的竞态
	for (let i = 0; i < 40; i++) {
		await ensureOffscreen();
		try {
			await rpcCall('offscreen:ping', null);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error('翻译引擎启动超时');
}

/* ---------------- 更多语言包（Bergamot 官方仓库） ---------------- */

const EXTRA_MODELS_KEY = 'extraModels'; // 已安装语言包的元数据（持久化）
const EXTRA_INDEX_KEY = 'extraModelIndex'; // 索引缓存（离线兜底）

let extraModelsCache = null;
let extraIndexCache = null;
let extraIndexLoading = null;

async function getExtraModels() {
	if (!extraModelsCache) {
		const { [EXTRA_MODELS_KEY]: saved } = await chrome.storage.local.get(EXTRA_MODELS_KEY);
		extraModelsCache = saved && typeof saved === 'object' ? saved : {};
	}
	return extraModelsCache;
}

async function saveExtraModels(map) {
	extraModelsCache = map;
	await chrome.storage.local.set({ [EXTRA_MODELS_KEY]: map });
}

/** 运行时拉取官方索引；失败时退回上次成功缓存，绝不因断网让设置页空白 */
async function fetchExtraIndex({ refresh = false } = {}) {
	if (refresh) extraIndexCache = null;
	if (extraIndexCache) return { index: extraIndexCache, source: 'memory' };
	if (extraIndexLoading) return extraIndexLoading;

	extraIndexLoading = (async () => {
		try {
			const response = await fetch(S3_REGISTRY_URL, {
				credentials: 'omit',
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			// S3 上该对象带 Content-Encoding: gzip，多数环境 fetch 会自动解压；
			// 若拿到的是原始 gzip 字节则手动解压，避免列表空白
			const raw = await response.arrayBuffer();
			let index;
			try {
				index = JSON.parse(new TextDecoder().decode(raw));
			} catch {
				const stream = new Blob([raw])
					.stream()
					.pipeThrough(new DecompressionStream('gzip'));
				index = JSON.parse(await new Response(stream).text());
			}
			if (Object.keys(buildExtraRegistry(index)).length === 0) {
				throw new Error('索引格式异常');
			}
			extraIndexCache = index;
			await chrome.storage.local.set({ [EXTRA_INDEX_KEY]: index }).catch(() => {});
			return { index, source: 'remote' };
		} catch (err) {
			const { [EXTRA_INDEX_KEY]: cached } = await chrome.storage.local.get(EXTRA_INDEX_KEY);
			if (cached && Object.keys(buildExtraRegistry(cached)).length) {
				extraIndexCache = cached;
				return { index: cached, source: 'cache', error: err.message };
			}
			return { index: {}, source: 'unavailable', error: err.message };
		} finally {
			extraIndexLoading = null;
		}
	})();
	return extraIndexLoading;
}

/** 查找语言包：内置 → 已安装扩展包 → 官方索引（供首次安装） */
async function resolveModelMeta(key) {
	if (BUILTIN_MODELS[key]) return BUILTIN_MODELS[key];
	const installed = await getExtraModels();
	if (installed[key]) return installed[key];
	const { index } = await fetchExtraIndex();
	return buildExtraRegistry(index)[key] || null;
}

/* ---------------- 模型组装与翻译 ---------------- */

/**
 * 计算指定语言对需要的模型文件清单（meta 中的文件规格）
 * 通用逻辑：按 meta.files 实际存在的部件取，enzh 额外跳过 lex。
 * 官方仓库同时存在 vocab 单词表与 srcvocab/trgvocab 双词表两种形态。
 * @param {{from: string, to: string}} direction
 * @param {object} meta 语言包元数据
 */
function getModelFileSpecs(direction, meta) {
	const pairKey = `${direction.from}${direction.to}`;
	if (!meta) {
		throw new Error(
			`暂无 ${direction.from}→${direction.to} 的语言包，请到设置页「更多语言包」下载`,
		);
	}

	const fileSpecs = {};
	for (const [part, spec] of Object.entries(meta.files)) {
		if (meta.skipLex && part === 'lex') continue;
		fileSpecs[part] = { ...spec };
	}
	return { pairKey, fileSpecs };
}

const loadModelLocks = new Map();
/** 已确认加载完成的语言对（SW 可能被回收，重启后由 offscreen 侧再兜底） */
const loadedPairs = new Set();

async function ensureModelLoaded(direction, { streamId, force = false } = {}) {
	const pairKey = `${direction.from}${direction.to}`;

	// 已加载：直接返回，避免每批翻译都重新组装模型
	if (!force && loadedPairs.has(pairKey)) return true;

	// 并发去重
	if (loadModelLocks.has(pairKey)) return loadModelLocks.get(pairKey);

	const task = (async () => {
		// 关键：先确保 offscreen 文档存在，否则 engine:* 调用无人应答
		await offscreenReady();

		// 注意：模型缓冲区（数十 MB ArrayBuffer）不能通过 chrome.runtime 消息
		// 传输（JSON 序列化会破坏二进制），改传文件清单，由 offscreen 自行
		// 从 IndexedDB 缓存读取（必要时下载）。
		const meta = await resolveModelMeta(pairKey);
		const { fileSpecs } = getModelFileSpecs(direction, meta);
		await rpcCall('engine:ensureModel', {
			direction,
			pairKey,
			fileSpecs,
			config: meta.config ?? null,
			streamId: streamId ?? `model-${pairKey}`,
			force,
		});
		loadedPairs.add(pairKey);
		return true;
	})();

	loadModelLocks.set(pairKey, task);
	try {
		return await task;
	} finally {
		loadModelLocks.delete(pairKey);
	}
}

/** 翻译一批文本 */
async function translateTexts(texts, from, to, { streamId } = {}) {
	if (!Array.isArray(texts) || texts.length === 0) return [];

	const direction = { from, to };
	const pairKey = `${from}${to}`;
	await ensureModelLoaded(direction, { streamId });

	const run = () =>
		rpcCall('engine:translate', {
			texts,
			direction,
		}).then((results) => results.map((r) => r.target.text));

	try {
		return await run();
	} catch (err) {
		// offscreen 文档被回收会丢掉引擎内存，而 SW 的已加载标记还在：
		// 清标记、重新装配一次再试，避免整页翻译直接失败
		if (/模型尚未加载/.test(err.message)) {
			loadedPairs.delete(pairKey);
			await ensureModelLoaded(direction, { streamId });
			return run();
		}
		throw err;
	}
}

/* ---------------- RPC：翻译 ---------------- */

rpcListen('translate:texts', ({ texts, from, to, streamId }) =>
	translateTexts(texts, from, to, { streamId }),
);

/* ---------------- RPC：模型管理 ---------------- */

rpcListen('models:list', async () => {
	const stored = await listStoredModels();
	const extra = await getExtraModels();
	return {
		builtin: Object.fromEntries(
			Object.entries(BUILTIN_MODELS).map(([key, meta]) => [
				key,
				{
					label: meta.label,
					version: meta.version,
					totalSize: Object.values(meta.files)
						.filter((f) => !(meta.skipLex && f.part === 'lex'))
						.reduce((sum, f) => sum + (f.size || 0), 0),
					installed: stored.some((s) => s.direction === key && s.part === 'model'),
				},
			]),
		),
		// 供设置页 / 弹窗的翻译方向下拉追加「已安装的语言包」
		extraDirections: Object.entries(extra).map(([key, meta]) => ({
			value: key,
			label: meta.label,
		})),
		stored: stored.map((s) => ({
			direction: s.direction,
			part: s.part,
			name: s.name,
			size: s.size,
			updatedAt: s.updatedAt,
		})),
	};
});

/** 「更多语言包」列表：官方索引 + 安装状态（断网时退回上次缓存） */
rpcListen('models:extraList', async (payload) => {
	const refresh = Boolean(payload?.refresh);
	const [{ index, source, error }, extra, stored] = await Promise.all([
		fetchExtraIndex({ refresh }),
		getExtraModels(),
		listStoredModels(),
	]);
	const registry = buildExtraRegistry(index);
	return {
		source,
		error: error || null,
		packs: Object.entries(registry).map(([key, meta]) => ({
			key,
			label: meta.label,
			totalSize: Object.values(meta.files).reduce(
				(sum, f) => sum + (f.size || 0),
				0,
			),
			installed:
				Boolean(extra[key]) &&
				stored.some((s) => s.direction === key && s.part === 'model'),
		})),
	};
});

rpcListen('models:download', async ({ key }) => {
	// 内置模型 / 已安装的扩展包 / 官方索引中待安装的扩展包，统一入口
	const meta = await resolveModelMeta(key);
	if (!meta) throw new Error(`未知语言包: ${key}`);

	// 固定的进度流 id，popup/options 通过 `model-<key>` 订阅进度
	const streamId = `model-${key}`;
	const direction = { from: meta.from, to: meta.to };
	const pairKey = `${meta.from}${meta.to}`;

	// 该入口语义是「下载/重新下载」：force 让 offscreen 跳过缓存重新下载并校验，
	// 新文件就绪后才替换引擎内模型（下载失败不会破坏已装好的语言包）
	loadedPairs.delete(pairKey);

	// 下载 + 加载模型（完成或失败均返回；进度通过 rpcEmit 推送）
	await ensureModelLoaded(direction, { streamId, force: true });

	// 扩展语言包安装成功后写入注册表，之后才能作为翻译方向被解析
	if (!BUILTIN_MODELS[key]) {
		const installed = await getExtraModels();
		await saveExtraModels({ ...installed, [key]: meta });
	}
	return { ok: true, streamId };
});

rpcListen('models:delete', async ({ key }) => {
	const meta = await resolveModelMeta(key).catch(() => null);

	// 先释放引擎内存，再删缓存，避免模型仍驻留而缓存已失效
	if (meta) {
		if (loadedPairs.has(key)) {
			await offscreenReady().catch(() => {});
			await rpcCall('engine:freeModel', {
				direction: { from: meta.from, to: meta.to },
			}).catch(() => {});
		}
		loadedPairs.delete(key);
	}

	await deleteModel(key);

	// 扩展语言包同时移除注册信息，翻译方向下拉随之更新
	if (!BUILTIN_MODELS[key]) {
		const installed = await getExtraModels();
		if (installed[key]) {
			const next = { ...installed };
			delete next[key];
			await saveExtraModels(next);
		}
	}
	return true;
});

/* ---------------- RPC：OCR ---------------- */

rpcListen('ocr:translate', async ({ imageDataUrl, langs, from, to, langPath }) => {
	await offscreenReady();

	const { text } = await rpcCall('ocr:recognize', { imageDataUrl, langs, langPath });
	if (!text) return { text: '', translation: '' };

	const translation = await translateTexts([text], from, to);
	return { text, translation: translation[0] };
});

/** 裁剪图片（用 offscreen document 的 canvas） */
async function cropImage(dataUrl, rect, dpr = 1) {
	await offscreenReady();
	return rpcCall('image:crop', { dataUrl, rect, dpr });
}

/* ---------------- 命令与右键菜单 ---------------- */

chrome.commands.onCommand.addListener(async (command) => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;

	if (command === 'toggle-page-translation') {
		await sendToTab(tab.id, { type: 'command:togglePageTranslation' });
	} else if (command === 'ocr-screen-region') {
		await sendToTab(tab.id, { type: 'command:ocrScreenRegion' });
	}
});

async function sendToTab(tabId, message, frameId) {
	try {
		const options = typeof frameId === 'number' ? { frameId } : {};
		return await chrome.tabs.sendMessage(tabId, message, options);
	} catch (err) {
		// content script 可能未注入（chrome:// 页面等）
		console.warn('消息发送失败:', err.message);
		return null;
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type === 'command:fromContent') {
		handleContentCommand(message.payload, sender)
			.then((result) => sendResponse({ ok: true, result }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true; // 异步响应
	}
	return false;
});

async function handleContentCommand(payload, sender) {
	const tabId = sender.tab?.id;
	if (!tabId) return;

	if (payload.type === 'ocr-capture-region') {
		// 截屏 → 裁剪 → OCR → 翻译 → 一次回传结果（结果只送回发起的 frame）
		const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
			format: 'png',
		});
		const cropped = await cropImage(dataUrl, payload.rect, payload.devicePixelRatio);
		const { text, translation } = await ocrTranslate(cropped.dataUrl, payload);
		await sendToTab(tabId, { type: 'ocr:result', text, translation }, sender.frameId);
	} else if (payload.type === 'ocr-image-url') {
		// 把图片 URL 传给 offscreen 转成 dataUrl（避免 canvas 跨域污染）
		const result = await rpcCall('image:fetchAsDataUrl', { url: payload.url });
		const { text, translation } = await ocrTranslate(result.dataUrl, payload);
		await sendToTab(tabId, { type: 'ocr:result', text, translation }, sender.frameId);
	} else if (payload.type === 'ocr-image-data') {
		const { text, translation } = await ocrTranslate(payload.imageDataUrl, payload);
		await sendToTab(tabId, { type: 'ocr:result', text, translation }, sender.frameId);
	} else if (payload.type === 'translate-texts') {
		const translations = await translateTexts(payload.texts, payload.from, payload.to);
		return translations;
	}
	return null;
}

/** OCR 识别 + 翻译一条龙 */
async function ocrTranslate(imageDataUrl, payload) {
	await offscreenReady();
	const { text } = await rpcCall('ocr:recognize', {
		imageDataUrl,
		langs: payload.langs ?? 'eng',
		langPath: payload.langPath,
	});
	if (!text) return { text: '', translation: '' };
	const [translation] = await translateTexts([text], payload.from, payload.to);
	return { text, translation };
}

/* ---------------- 安装初始化 ---------------- */

/**
 * CDN 兼容规则：firefox-settings-attachments.cdn.mozilla.net 对 Chrome 的
 * User-Agent 会返回 406（实测 Chrome 全版本均触发），改为 Firefox UA。
 * 仅影响该模型 CDN 域名的请求头，不影响任何页面。
 */
const CDN_UA_RULE = {
	id: 20261107,
	priority: 1,
	action: {
		type: 'modifyHeaders',
		requestHeaders: [
			{
				header: 'User-Agent',
				operation: 'set',
				value:
					'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
			},
		],
	},
	condition: {
		urlFilter: '||firefox-settings-attachments.cdn.mozilla.net/',
		resourceTypes: ['xmlhttprequest', 'other'],
	},
};

async function ensureCdnRule() {
	// Firefox UA 本就能从 Mozilla CDN 正常下载，无需改写（且 MV2 下跳过 DNR）
	if (IS_FIREFOX) return;
	const existing = await chrome.declarativeNetRequest.getDynamicRules();
	const hasRule = existing.rules?.some((r) => r.id === CDN_UA_RULE.id);
	if (!hasRule) {
		await chrome.declarativeNetRequest.updateDynamicRules({
			addRules: [CDN_UA_RULE],
			removeRuleIds: [CDN_UA_RULE.id],
		});
	}
}

ensureCdnRule().catch(console.warn);

/** 划词开关联动右键菜单：关闭时菜单项置灰，避免点了没反应 */
async function syncSelectionMenu() {
	const { settings } = await chrome.storage.local.get('settings');
	const enabled = settings?.selectTranslateEnabled !== false;
	// 菜单可能尚未创建（首次安装 / 浏览器升级）；用回调形式兼容各版本
	try {
		chrome.contextMenus.update('translate-selection', { enabled }, () => {
			void chrome.runtime.lastError;
		});
	} catch {
		/* 忽略 */
	}
}

chrome.runtime.onInstalled.addListener(async () => {
	await ensureCdnRule().catch(() => {});

	const { settings } = await chrome.storage.local.get('settings');
	const selectEnabled = settings?.selectTranslateEnabled !== false;
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: 'translate-selection',
			title: '翻译选中文本',
			contexts: ['selection'],
			enabled: selectEnabled,
		});
		chrome.contextMenus.create({
			id: 'ocr-image',
			title: 'OCR 翻译此图片',
			contexts: ['image'],
		});
	});
});

chrome.runtime.onStartup.addListener(() => {
	syncSelectionMenu();
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && changes.settings) syncSelectionMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (!tab?.id) return;
	if (info.menuItemId === 'translate-selection') {
		await sendToTab(tab.id, { type: 'command:translateSelection' }, info.frameId);
	} else if (info.menuItemId === 'ocr-image') {
		// 只发给图片所在 frame（否则所有 frame 都会收到 undefined 的 srcUrl）
		const frameId = typeof info.frameId === 'number' ? info.frameId : undefined;
		await sendToTab(tab.id, { type: 'command:ocrImage', srcUrl: info.srcUrl }, frameId);
	}
});

// popup 打开时可能需要触发模型下载进度订阅
rpcEmit('background-started', { time: Date.now() });
