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
	for (let i = 0; i < 120; i++) {
		await ensureOffscreen();
		try {
			await rpcCall('offscreen:ping', null);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 500));
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
/** 已确认装配完成的路径（SW 可能被回收，重启后由 offscreen 侧再兜底） */
const loadedPairs = new Set();

/**
 * 解析翻译路径：直连语言包 → 经英语中转（pivot）。
 * resolveModelMeta 会查内置/已安装/官方索引，结果按方向缓存避免每批重查。
 */
const translationPaths = new Map(); // "frzh" → { key, models: [{from,to}...] }
async function resolveTranslationPath(from, to) {
	const direct = `${from}${to}`;
	const cached = translationPaths.get(direct);
	if (cached) return cached;

	const tryMeta = async (key) => {
		const meta = await resolveModelMeta(key).catch(() => null);
		return meta ? { from: key.slice(0, 2), to: key.slice(2) } : null;
	};

	let path = null;
	if (await tryMeta(direct)) {
		path = { key: direct, models: [{ from, to }] };
	} else if (from !== 'en' && to !== 'en') {
		// 经英语中转：from→en + en→to，两个语言包都可用才成立（如 fr→zh = fren + enzh）
		const first = await tryMeta(`${from}en`);
		const second = await tryMeta(`en${to}`);
		if (first && second) {
			path = {
				key: `${direct}+${first.from}${first.to}+${second.from}${second.to}`,
				models: [first, second],
			};
		}
	}
	if (!path) {
		throw new Error(
			`暂无 ${from}→${to} 的语言包${from !== 'en' && to !== 'en' ? '（也未找到可用的英语中转路径）' : ''}，请到设置页「更多语言包」下载`,
		);
	}
	translationPaths.set(direct, path);
	return path;
}

/** 与某个语言对相关的所有路径缓存态一并失效（删除/重下语言包时） */
function invalidatePathCaches(pairKey) {
	translationPaths.delete(pairKey);
	for (const key of [...loadedPairs]) {
		if (key.includes(pairKey)) loadedPairs.delete(key);
	}
}

async function ensurePathLoaded(path, { streamId, force = false } = {}) {
	// 已装配：直接返回，避免每批翻译都重新检查
	if (!force && loadedPairs.has(path.key)) return true;

	// 并发去重
	if (loadModelLocks.has(path.key)) return loadModelLocks.get(path.key);

	const task = (async () => {
		// 关键：先确保 offscreen 文档存在，否则 engine:* 调用无人应答
		await offscreenReady();

		// 逐个装配模型（直连 1 个 / pivot 2 个）。模型缓冲区（数十 MB ArrayBuffer）
		// 不能经 chrome.runtime 消息传输（JSON 序列化会破坏二进制），改传文件
		// 清单，由 offscreen 自行从 IndexedDB 缓存读取（必要时下载）。
		for (const model of path.models) {
			const pairKey = `${model.from}${model.to}`;
			const meta = await resolveModelMeta(pairKey);
			const { fileSpecs } = getModelFileSpecs(model, meta);
			await rpcCall('engine:ensureModel', {
				direction: model,
				pairKey,
				fileSpecs,
				config: meta.config ?? null,
				streamId: streamId ?? `model-${pairKey}`,
				force,
			});
		}
		loadedPairs.add(path.key);
		return true;
	})();

	loadModelLocks.set(path.key, task);
	try {
		return await task;
	} finally {
		loadModelLocks.delete(path.key);
	}
}

/** 翻译一批文本（直连不可用时自动走英语中转） */
async function translateTexts(texts, from, to, { streamId, html = false } = {}) {
	if (!Array.isArray(texts) || texts.length === 0) return [];

	const path = await resolveTranslationPath(from, to);
	await ensurePathLoaded(path, { streamId });

	const run = () =>
		rpcCall('engine:translate', {
			texts,
			direction: { from, to },
			models: path.models,
			html,
		}).then((results) => results.map((r) => r.target.text));

	try {
		return await run();
	} catch (err) {
		// offscreen 文档被回收会丢掉引擎内存，而后台的已装配标记还在：
		// 清标记、重新装配一次再试，避免整页翻译直接失败
		if (/模型尚未加载/.test(err.message)) {
			loadedPairs.delete(path.key);
			await ensurePathLoaded(path, { streamId });
			return run();
		}
		throw err;
	}
}

/* ---------------- RPC：翻译 ---------------- */

rpcListen('translate:texts', ({ texts, from, to, streamId, html }) =>
	translateTexts(texts, from, to, { streamId, html }),
);

/** 预热：popup 打开即后台装配当前方向模型，点「翻译」时通常已就绪 */
rpcListen('models:warmup', async ({ direction } = {}) => {
	const pair =
		direction && direction !== 'auto' && /^[a-z]{4}$/i.test(direction)
			? direction.toLowerCase()
			: 'enzh'; // auto 拿不到页面语言，按最常用的 en→zh 预热
	const meta = await resolveModelMeta(pair).catch(() => null);
	if (!meta) return { warmed: false };

	// 只在已缓存的情况下预热（静默预热不偷偷下载几十 MB 流量）
	const stored = await listStoredModels();
	const parts = Object.values(meta.files).filter(
		(spec) => !(meta.skipLex && spec.part === 'lex'),
	);
	const allCached = parts.every((spec) =>
		stored.some((s) => s.direction === pair && s.part === spec.part),
	);
	if (!allCached) return { warmed: false, reason: 'not-cached' };

	await ensurePathLoaded(
		{ key: pair, models: [{ from: pair.slice(0, 2), to: pair.slice(2) }] },
		{ streamId: `model-${pair}` },
	);
	return { warmed: true };
});

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
	invalidatePathCaches(pairKey);
	await ensurePathLoaded({ key: pairKey, models: [direction] }, { streamId, force: true });

	// 扩展语言包安装成功后写入注册表，之后才能作为翻译方向被解析
	if (!BUILTIN_MODELS[key]) {
		const installed = await getExtraModels();
		await saveExtraModels({ ...installed, [key]: meta });
	}
	return { ok: true, streamId };
});

rpcListen('models:delete', async ({ key }) => {
	const meta = await resolveModelMeta(key).catch(() => null);

	// 先释放引擎内存，再删缓存，避免模型仍驻留而缓存已失效；
	// 依赖该模型的所有路径（含 pivot 中转）一并失效
	if (meta) {
		const affectedPaths = [...loadedPairs].filter((k) => k.includes(key));
		for (const pathKey of affectedPaths) {
			const path = translationPaths.get(pathKey);
			const models = path?.models ?? [{ from: meta.from, to: meta.to }];
			for (const m of models) {
				if (`${m.from}${m.to}`.includes(key)) {
					await offscreenReady().catch(() => {});
					await rpcCall('engine:freeModel', { direction: m }).catch(() => {});
				}
			}
		}
	}
	invalidatePathCaches(key);

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

/* ---------------- 双语阅读模式 ---------------- */

/**
 * 提取当前页正文并打开阅读视图：
 * 按需注入 Readability 与提取器（解析器 90KB 不常驻普通页面）→
 * content 侧提取 → 写 storage → 新标签打开 reader 页（原页保留）。
 */
async function openReaderMode(tabId) {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: [
			'vendor/readability/Readability.js',
			'vendor/readability/Readability-readerable.js',
			'src/content/article-extractor.js',
		],
	});
	const [injection] = await chrome.scripting.executeScript({
		target: { tabId },
		func: () => (typeof OBT === 'object' && OBT.extractArticle ? OBT.extractArticle() : { ok: false, reason: 'not-injected' }),
	});
	const result = injection?.result;
	if (!result?.ok) {
		throw new Error(
			result?.reason === 'no-content'
				? '未能从该页面提取出正文（可能不是文章页）。可改用整页双语对照模式。'
				: '阅读模式提取失败，请改用整页双语对照模式。',
		);
	}

	const key = `reader:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	await chrome.storage.local.set({ [key]: result.data });
	const tab = await chrome.tabs.get(tabId);
	await chrome.tabs.create({
		url: `${chrome.runtime.getURL('src/reader/reader.html')}#${encodeURIComponent(key)}`,
		index: tab.index + 1,
		openerTabId: tabId, // 阅读页「返回原文」依赖它找到原标签
	});
	return { key };
}

rpcListen('reader:open', async ({ tabId } = {}) => {
	if (!tabId) throw new Error('缺少 tabId');
	return openReaderMode(tabId);
});

/* ---------------- 生词本与 AnkiConnect ---------------- */

const ANKI_ENDPOINT = 'http://127.0.0.1:8765/';
const VOCAB_KEY = 'vocab';
const VOCAB_LIMIT = 10000;

async function ankiInvoke(action, params = {}) {
	let response;
	try {
		response = await fetch(ANKI_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, version: 6, params }),
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		throw new Error('无法连接 Anki（需桌面版运行并安装 AnkiConnect 插件，代码 2055492159）');
	}
	if (!response.ok) throw new Error(`AnkiConnect HTTP ${response.status}`);
	const body = await response.json();
	if (body.error) throw new Error(String(body.error));
	return body.result;
}

async function vocabLoad() {
	const { [VOCAB_KEY]: vocab } = await chrome.storage.local.get(VOCAB_KEY);
	return Array.isArray(vocab) ? vocab : [];
}

async function vocabSave(vocab) {
	await chrome.storage.local.set({ [VOCAB_KEY]: vocab });
}

rpcListen('vocab:add', async ({ source, translation, sourceUrl = '', title = '', pair = '' } = {}) => {
	if (!source || typeof source !== 'string') throw new Error('缺少原文');
	const vocab = await vocabLoad();
	const trimmed = source.trim();
	if (vocab.some((e) => e.source === trimmed)) {
		return { added: false, total: vocab.length, reason: 'duplicate' };
	}
	const entry = {
		id: `v${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
		source: trimmed,
		translation: typeof translation === 'string' ? translation.trim() : '',
		sourceUrl,
		title,
		pair,
		createdAt: Date.now(),
	};
	vocab.unshift(entry);
	if (vocab.length > VOCAB_LIMIT) vocab.length = VOCAB_LIMIT;
	await vocabSave(vocab);
	return { added: true, total: vocab.length, id: entry.id };
});

rpcListen('vocab:list', async () => {
	const vocab = await vocabLoad();
	return { entries: vocab, total: vocab.length };
});

rpcListen('vocab:delete', async ({ id } = {}) => {
	const vocab = await vocabLoad();
	const next = vocab.filter((e) => e.id !== id);
	await vocabSave(next);
	return { total: next.length };
});

rpcListen('vocab:clear', async () => {
	await vocabSave([]);
	return { total: 0 };
});

rpcListen('anki:status', async () => {
	try {
		const version = await ankiInvoke('version');
		return { ok: true, version };
	} catch (err) {
		return { ok: false, error: err.message };
	}
});

rpcListen('anki:meta', async () => {
	const [deckNames, modelNames] = await Promise.all([
		ankiInvoke('deckNames'),
		ankiInvoke('modelNames'),
	]);
	deckNames.sort();
	modelNames.sort();
	return { deckNames, modelNames };
});

rpcListen('anki:fields', async ({ modelName } = {}) => {
	if (!modelName) throw new Error('缺少 modelName');
	return { fieldNames: await ankiInvoke('modelFieldNames', { modelName }) };
});

/** OBT 笔记模板定义（用户一键安装进自己的收藏，字段/模板/CSS 全部我们设计） */
const OBT_MODEL_NAME = 'OBT 双语';
const OBT_MODEL_SPEC = {
	modelName: OBT_MODEL_NAME,
	inOrderFields: ['原文', '译文', '来源', '发音'],
	cardTemplates: [
		{
			Name: '双语卡',
			Front:
				'<div class="obt-front">{{原文}}</div>\n<div class="obt-audio">{{发音}}</div>',
			Back:
				'{{FrontSide}}\n<hr id="answer">\n<div class="obt-back">\n\t<div class="obt-translation">{{译文}}</div>\n\t{{#来源}}<div class="obt-source">来源：{{来源}}</div>{{/来源}}\n</div>',
		},
	],
	css:
		'.card {\n\tfont-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Georgia, serif;\n\tfont-size: 22px;\n\ttext-align: left;\n\tcolor: #1f2430;\n\tbackground-color: #ffffff;\n}\n\n.night_mode .card, .card.night_mode {\n\tcolor: #d7dce5;\n\tbackground-color: #16181d;\n}\n\n.obt-front {\n\tfont-size: 1.12em;\n\tline-height: 1.65;\n}\n\n.obt-audio {\n\tmargin-top: 10px;\n}\n\n.obt-translation {\n\tfont-size: 1.05em;\n\tline-height: 1.7;\n\tcolor: #1a73e8;\n}\n\n.night_mode .obt-translation, .card.night_mode .obt-translation {\n\tcolor: #7aa7ff;\n}\n\n.obt-source {\n\tfont-size: 0.68em;\n\tcolor: #8a93a3;\n\tmargin-top: 14px;\n}\n\nhr#answer {\n\tmargin: 18px 0;\n\tborder: none;\n\tborder-top: 1px solid #e5e7eb;\n}\n\n.night_mode hr#answer, .card.night_mode hr#answer {\n\tborder-top-color: #2a2f3a;\n}',
	isCloze: false,
};

/** 一键创建 OBT 笔记模板（已存在则跳过） */
rpcListen('anki:createTemplate', async () => {
	const modelNames = await ankiInvoke('modelNames');
	if (modelNames.includes(OBT_MODEL_NAME)) {
		return { created: false, reason: 'exists' };
	}
	await ankiInvoke('createModel', OBT_MODEL_SPEC);
	return { created: true };
});

rpcListen('anki:push', async ({ ids, deckName, modelName, frontField, backField, tags = [], audio = {} } = {}) => {
	if (!Array.isArray(ids) || !ids.length) throw new Error('未选择条目');
	if (!deckName || !modelName || !frontField || !backField) {
		throw new Error('请先配置牌组、模板与字段');
	}
	const vocab = await vocabLoad();
	const byId = new Map(vocab.map((e) => [e.id, e]));
	let added = 0;
	let skipped = 0;
	const errors = [];
	for (const id of ids) {
		const entry = byId.get(id);
		if (!entry) continue;
		try {
			const fields = { [frontField]: entry.source, [backField]: entry.translation };
			const note = {
				deckName,
				modelName,
				fields,
				tags: ['obt', ...(Array.isArray(tags) ? tags : [])],
				options: { allowDuplicate: false },
			};
			// 音频协议：audio[id] = { data: base64, filename }（由本地 TTS 发音包生成后传入）
			const audioSpec = audio?.[id];
			if (audioSpec?.data && audioSpec?.filename) {
				const soundName = audioSpec.filename.replace(/[^\w.-]/g, '_'); // id 含冒号会被 Anki 媒体库拒绝
				note.audio = [{ data: audioSpec.data, filename: soundName, fields: ['发音'] }];
			}
			await ankiInvoke('addNote', { note });
			added++;
		} catch (err) {
			if (/duplicate/i.test(err.message)) skipped++;
			else errors.push(`${entry.source.slice(0, 24)}…: ${err.message.slice(0, 60)}`);
		}
	}
	return { added, skipped, errors: errors.slice(0, 5) };
});

/* ---------------- RPC：TTS 发音包（转发到 offscreen 引擎） ---------------- */

// offscreen 文档没有 host 权限的 CORS 豁免（HF xet CDN 重定向无 CORS 头会被拦），
// 因此下载由后台（SW/事件页，有权限豁免）完成后写入 IndexedDB；
// offscreen/background 引擎只从 IndexedDB 读取并合成。
const TTS2_ASSETS = [
	{
		direction: 'tts2', part: 'model', name: 'kitten_tts_2_nano_en.onnx',
		url: 'https://huggingface.co/KittenML/kitten-tts-2-nano/resolve/main/kitten_tts_2_nano_en.onnx',
		sha256: '3a63a18b3f5cb1dbd99d7f53cb60fdb995e23a21e98d21f9f32d378668dab98e',
	},
	{
		direction: 'tts2', part: 'voices', name: 'voices_en.npz',
		url: 'https://huggingface.co/KittenML/kitten-tts-2-nano/resolve/main/voices_en.npz',
		sha256: '8dd673489b0130f23dd32d8c8b7cd49cf454cad029eaa6f0cd8c0f386c374e3e',
	},
	{
		direction: 'tts2', part: 'cmu', name: 'cmu_misaki_us.json',
		url: 'https://huggingface.co/KittenML/kitten-tts-2-nano/resolve/main/g2p/cmu_misaki_us.json',
		sha256: 'ae564e1a76df3501058a5ec99d135d016759c9475042fb6c3811374daee1ef04',
	},
];

rpcListen('tts:status', async () => {
	const cached = await getModelFile('tts2', 'model');
	const total = TTS2_ASSETS.reduce((sum, a) => sum + 8828928 + 5224448 + 3418112, 0) || 16700000;
	return { installed: Boolean(cached), size: 16700000 };
});

rpcListen('tts:download', async ({ streamId } = {}) => {
	const sid = streamId ?? 'tts-pack';
	for (const spec of TTS2_ASSETS) {
		await ensureModelFile(spec, { streamId: sid });
	}
	return { ok: true };
});

rpcListen('tts:synthesize', async (payload) => {
	// 合成在 offscreen/background 引擎上下文执行（asset 已在 IndexedDB）
	await offscreenReady();
	return rpcCall('tts-engine:synthesize', payload);
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
	} else if (command === 'open-reader-mode') {
		openReaderMode(tab.id).catch((err) => console.warn('阅读模式打开失败:', err.message));
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
		chrome.contextMenus.create({
			id: 'reader-mode',
			title: '双语阅读模式',
			contexts: ['page'],
		});
		chrome.contextMenus.create({
			id: 'vocab-add',
			title: '加入生词本',
			contexts: ['selection'],
		});
	});
});

chrome.runtime.onStartup.addListener(() => {
	syncSelectionMenu();
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && changes.settings) syncSelectionMenu();
});

// 内容脚本会话保活：Port 消息持续重置 MV3 SW 的 30s 空闲计时器，
// 翻译会话期间避免休眠（每次唤醒要付 50-100ms 冷启动延迟）
chrome.runtime.onConnect.addListener(() => {
	// 仅需持有端口；消息到达本身就会保活
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (!tab?.id) return;
	if (info.menuItemId === 'translate-selection') {
		await sendToTab(tab.id, { type: 'command:translateSelection' }, info.frameId);
	} else if (info.menuItemId === 'ocr-image') {
		// 只发给图片所在 frame（否则所有 frame 都会收到 undefined 的 srcUrl）
		const frameId = typeof info.frameId === 'number' ? info.frameId : undefined;
		await sendToTab(tab.id, { type: 'command:ocrImage', srcUrl: info.srcUrl }, frameId);
	} else if (info.menuItemId === 'reader-mode') {
		openReaderMode(tab.id).catch((err) => console.warn('阅读模式打开失败:', err.message));
	} else if (info.menuItemId === 'vocab-add') {
		addSelectionToVocab(info.selectionText || '').catch((err) => console.warn('加入生词本失败:', err.message));
	}
});

/** 划词加入生词本：检测选中文本语言 → 走现有翻译管线 → 存储 */
async function addSelectionToVocab(selection) {
	const source = selection.trim();
	if (source.length < 1 || source.length > 2000) return;
	const { settings } = await chrome.storage.local.get('settings');
	let from;
	let to;
	const dir = settings?.translateDirection;
	if (dir && dir !== 'auto' && /^[a-z]{4}$/i.test(dir)) {
		from = dir.slice(0, 2).toLowerCase();
		to = dir.slice(2).toLowerCase();
	} else {
		// auto：按选中文本文字系统粗判（汉字/假名 → zh→en，否则 en→zh）
		const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(source);
		from = hasCJK ? 'zh' : 'en';
		to = hasCJK ? 'en' : 'zh';
	}
	const [translation] = await translateTexts([source], from, to);
	return rpcCall('vocab:add', {
		source,
		translation,
		pair: `${from}${to}`,
	});
}

// popup 打开时可能需要触发模型下载进度订阅
rpcEmit('background-started', { time: Date.now() });
