/**
 * Offscreen 文档：承载 Bergamot 翻译引擎与 Tesseract.js OCR
 *
 * 与 Linguist 相同，MV3 下引擎运行在 offscreen document 中。
 * 此处在文档主线程直接加载 emscripten 胶水代码与 WASM
 * （Module.wasmBinary 预读直传，避免在 Worker 中 fetch 扩展资源——
 * 部分 Chromium 环境的专用 Worker 存在 fetch/线程异常）。
 *
 * 模型协议与 src/workers/bergamot-worker.js 保持一致：
 * loadTranslationModel 支持短列表为 null（禁用 shortlist，enzh 必需）。
 */

import { rpcListen, rpcEmit } from '../shared/rpc.js';

import './tts-engine.js'; // TTS 发音包通道（tts-engine:status/synthesize/voices，下载在 SW 侧）
import { buildMatcher, substituteHtml, restoreTokens, splitByTerms, tokenRegex } from '../shared/glossary.js';
import { DEFAULT_OCR_LANG_PATH } from '../shared/models-registry.js';
import { ensureModelFile } from '../background/model-store.js';

/**
 * @typedef {{model: ArrayBuffer, shortlist: ArrayBuffer|null, vocabs: ArrayBuffer[], qualityModel: ArrayBuffer|null, config?: Object<string, string|number>, modelFileName?: string}} ModelBuffers
 */

class BergamotEngine {
	constructor() {
		this.module = null;
		this.service = null;
		/** @type {Map<string, object>} */
		this.models = new Map();
	}

	/** 实例化 WASM 运行时与 BlockingService */
	async initialize() {
		const wasmUrl = new URL(
			'../../vendor/bergamot/bergamot-translator-worker.wasm',
			self.location.href,
		).toString();
		const response = await fetch(wasmUrl);
		if (!response.ok) {
			throw new Error(`引擎 wasm 读取失败: ${response.status}`);
		}
		const wasmBinary = await response.arrayBuffer();

		// 经典脚本胶水会在加载时读取 self.Module，wasmBinary 直传跳过 fetch/XHR
		const moduleOptions = {
			wasmBinary,
			onRuntimeInitialized: () => {},
		};
		/** @type {any} */
		const modulePromise = new Promise((resolve, reject) => {
			moduleOptions.onRuntimeInitialized = () => resolve(self.Module);
			setTimeout(() => reject(new Error('WASM 运行时初始化超时')), 120_000);
		});
		self.Module = moduleOptions;
		await loadScript('../../vendor/bergamot/bergamot-translator-worker.js');
		this.module = await modulePromise;

		// 胶水代码自带 mozIntGemm 优先 / wasm 内置实现的 gemm 回退链接逻辑
		// 句级缓存：导航/页眉/模板文案/重复列表项等重复句只翻一次，
		// 长页面典型提速 10-30%（两千句约几 MB 内存）
		this.service = new this.module.BlockingService({ cacheSize: 2000 });
	}

	/**
	 * 从缓冲区加载模型
	 * @param {{from: string, to: string}} direction
	 * @param {ModelBuffers} buffers
	 */
	loadTranslationModel({ from, to }, buffers) {
		// 词表去重（service_bindings.cpp 中 prepareVocabsSmartMemories 的要求）
		const uniqueVocabs = buffers.vocabs.filter(
			(vocab, index, vocabs) => !vocabs.slice(0, index).includes(vocab),
		);

		const modelMemory = this.prepareAlignedMemory(buffers.model, 256);
		// 关键差异：shortlist 为 null 时跳过（禁用 shortlisting，enzh 必需）
		const shortlistMemory = buffers.shortlist
			? this.prepareAlignedMemory(buffers.shortlist, 64)
			: null;
		const qualityMemory = buffers.qualityModel
			? this.prepareAlignedMemory(buffers.qualityModel, 64)
			: null;
		const vocabMemories = uniqueVocabs.map((vocab) =>
			this.prepareAlignedMemory(vocab, 64),
		);

		const vocabs = new this.module.AlignedMemoryList();
		vocabMemories.forEach((vocab) => vocabs.push_back(vocab));

		// 默认配置（来自 bergamot wasm 示例与 Linguist）
		const modelConfig = {
			'beam-size': 1,
			normalize: 1.0,
			'word-penalty': 0,
			'cpu-threads': 0,
			'gemm-precision': 'int8shiftAlphaAll',
			'skip-cost': true,
			alignment: 'soft',
			quiet: true,
			'quiet-translation': true,
			'max-length-break': 128,
			'mini-batch-words': 1024,
			workspace: 128,
			'max-length-factor': 2.0,
		};

		if (buffers.config) Object.assign(modelConfig, buffers.config);

		// WASM 版 marian 仅编译了 shiftAll/shiftAlphaAll
		if (modelConfig['gemm-precision'] === 'int8') {
			modelConfig['gemm-precision'] = 'int8shiftAll';
		}

		// gemm-precision 由模型文件名决定（intgemm8 → int8shiftAll）
		if (buffers.modelFileName?.endsWith('intgemm8.bin')) {
			modelConfig['gemm-precision'] = 'int8shiftAll';
		}

		const yaml = Object.entries(modelConfig)
			.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
			.join('\n');

		const key = JSON.stringify({ from, to });
		this.models.set(
			key,
			new this.module.TranslationModel(yaml, modelMemory, shortlistMemory, vocabs, qualityMemory),
		);
	}

	/** 释放模型内存 */
	freeTranslationModel({ from, to }) {
		const key = JSON.stringify({ from, to });
		const model = this.models.get(key);
		if (model) {
			this.models.delete(key);
			model.delete();
		}
	}

	/**
	 * 执行翻译。需确保对应模型已加载。
	 * @param {{models: {from:string,to:string}[], texts: {text:string, html:boolean}[]}} params
	 * @returns {{target: {text: string}}[]}
	 */
	translate({ models, texts }) {
		const input = new this.module.VectorString();
		texts.forEach(({ text }) => input.push_back(text));

		const options = new this.module.VectorResponseOptions();
		texts.forEach(({ html, qualityScores }) =>
			options.push_back({ alignment: false, html, qualityScores }),
		);

		const translationModels = models.map(({ from, to }) => {
			const key = JSON.stringify({ from, to });
			return this.models.get(key);
		});

		const responses =
			models.length > 1
				? this.service.translateViaPivoting(...translationModels, input, options)
				: this.service.translate(...translationModels, input, options);

		input.delete();
		options.delete();

		const translations = texts.map((_, i) => ({
			target: { text: responses.get(i).getTranslatedText() },
		}));

		responses.delete();
		return translations;
	}

	prepareAlignedMemory(buffer, alignmentSize) {
		const bytes = new Int8Array(buffer);
		const memory = new this.module.AlignedMemory(bytes.byteLength, alignmentSize);
		memory.getByteArrayView().set(bytes);
		return memory;
	}
}

/** @type {BergamotEngine|null} */
let engine = null;
/** @type {Promise<BergamotEngine>|null} */
let enginePromise = null;

async function ensureEngine() {
	if (engine) return engine;
	if (!enginePromise) {
		enginePromise = (async () => {
			const instance = new BergamotEngine();
			await instance.initialize();
			engine = instance;
			return instance;
		})();
		enginePromise.catch(() => {
			enginePromise = null;
		});
	}
	return enginePromise;
}

/* ---------------- 翻译 RPC ---------------- */

/* ---------------- 术语表（后台翻译前推送，引擎内强制） ---------------- */

/** @type {{version: number, entries: {source: string, target: string}[]}} */
let glossaryState = { version: 0, entries: [] };

rpcListen('glossary:set', ({ entries }) => {
	glossaryState = { version: glossaryState.version + 1, entries: entries ?? [] };
	return { version: glossaryState.version };
});

rpcListen('engine:ensureModel', async ({ direction, pairKey, fileSpecs, streamId, force, config }) => {
	const instance = await ensureEngine();

	const modelKey = JSON.stringify({ from: direction.from, to: direction.to });

	// 已加载且非强制刷新则直接复用：每批翻译都会走到这里，重复 new TranslationModel
	// 会反复分配数十 MB 引擎内存（且旧模型不会释放）
	if (!force && instance.models.has(modelKey)) {
		return { loaded: true, cached: true };
	}

	// 模型文件在本上下文直接从 IndexedDB 缓存读取（必要时下载）——
	// 数十 MB 的 ArrayBuffer 不能经 chrome.runtime 消息跨上下文传输
	const buffers = {};
	for (const [part, spec] of Object.entries(fileSpecs)) {
		buffers[part] = await ensureModelFile(
			{ ...spec, direction: pairKey },
			{ streamId, force },
		);
	}

	const vocabs = fileSpecs.vocab ? [buffers.vocab] : [buffers.srcvocab, buffers.trgvocab];
	const shortlist = fileSpecs.lex ? buffers.lex : null;

	// 新文件已就绪再替换旧模型：下载/校验失败时原模型仍可用
	if (instance.models.has(modelKey)) {
		instance.freeTranslationModel({ from: direction.from, to: direction.to });
	}

	instance.loadTranslationModel(
		{ from: direction.from, to: direction.to },
		{
			model: buffers.model,
			shortlist,
			vocabs,
			qualityModel: null,
			// 少数官方模型（如 uken/enuk）需要覆盖 gemm-precision；
			// modelFileName 也让引擎按 intgemm8.bin 自动切换精度
			config: config || undefined,
			modelFileName: fileSpecs.model?.name,
		},
	);

	return { loaded: true, cached: false };
});

/* ---------------- 翻译结果缓存与文本整理 ---------------- */

/** 译文 LRU 缓存：重复段落/导航文案跨页跨批秒出，停开整页重翻也不重算 */
const TRANSLATION_CACHE_LIMIT = 500;
const translationCache = new Map(); // "enzh|h|<text>" → 译文

const HALF_TO_FULL = { ',': '，', ';': '；', ':': '：', '.': '。', '!': '！', '?': '？' };

/**
 * 中文译文标点/空格整理（Bergamot 输出半角标点 + 杂乱空格）：
 * ① 全角标点前不留空格；② 半角标点前不留空格（后跟汉字时）；
 * ③ 标点后跟汉字不留空格；④ 跟在汉字后的半角标点转全角——
 *    前望字符需跳过 HTML 闭标签（</strong>, 这种写法也要转），
 *    后望不是数字/字母（保护 "2.2"、"e.g." 这类不转）。
 * 仅当目标语言为 zh 时应用，英文译文不动。
 */
function tidyCjkPunctuation(text) {
	// 半角→全角先行（仅汉字后，后望不是数字/字母），再做空格清理（这样全角化后残留的空格也能清掉）
	let t = text.replace(/[,;:.!?](?![\dA-Za-z])/g, (m, offset, s) => {
		// 向前找上一个可见字符（跳过 HTML 标签）
		let i = offset - 1;
		while (i >= 0 && s[i] === '>') {
			const lt = s.lastIndexOf('<', i);
			if (lt === -1) return m;
			i = lt - 1;
		}
		if (i < 0) return m;
		if (!/[\u4e00-\u9fff]/.test(s[i])) return m;
		return HALF_TO_FULL[m] ?? m;
	});

	t = t
		.replace(/ +([，。！？；：、）】》」』])/g, '$1')
		.replace(/ +([,.!?;:])(?=[\u4e00-\u9fff])/g, '$1')
		.replace(/([，。！？；：、）】》」』]) +(?=[\u4e00-\u9fff])/g, '$1');
	return t;
}

rpcListen('engine:translate', async ({ texts, direction, models, html = false, glossaryVersion = 0 }) => {
	const instance = await ensureEngine();
	const modelList = models?.length ? models : [direction];

	// 模型可能已被释放（删除语言包）或从未加载：显式报错，
	// 避免把 undefined 传给 WASM 绑定导致引擎 abort
	for (const model of modelList) {
		const key = JSON.stringify({ from: model.from, to: model.to });
		if (!instance.models.has(key)) {
			throw new Error('翻译模型尚未加载，请先下载对应语言包');
		}
	}

	// 术语表：仅当版本与当前状态一致时应用（SW 会在推送后传同版本号）
	const glossaryActive = glossaryVersion > 0 && glossaryVersion === glossaryState.version;
	const matcher = glossaryActive ? buildMatcher(glossaryState.entries) : null;
	const originalTexts = texts;

	// 命中术语：占位符替换（tag-aware，只动标签外文本）
	if (matcher) {
		texts = texts.map((t) => substituteHtml(t, matcher));
	}

	// LRU 缓存命中（键含路径/模式/术语版本：术语变更后旧缓存不命中）
	const pathId = modelList.map((m) => `${m.from}${m.to}`).join('+');
	const cacheKeys = texts.map(
		(text) => `${pathId}|${html ? 'h' : 't'}|g${glossaryVersion}|${text}`,
	);
	const cached = cacheKeys.map((k) => translationCache.get(k));
	if (cached.every((v) => v !== undefined)) {
		for (const k of cacheKeys) {
			const v = translationCache.get(k);
			translationCache.delete(k);
			translationCache.set(k, v); // LRU 触摸
		}
		return cached.map((text) => ({ target: { text } }));
	}

	const results = instance.translate({
		models: modelList,
		// html:true 时 texts 已是受限内联片段（页面侧已白名单化），引擎只保留标签结构
		texts: texts.map((text) => ({ text, html })),
	});

	// 术语回贴：token → 目标词；回贴缺失（NMT 吞改 token）的句子降级为
	// 分段拼接——按术语切分，纯文本段去标签后翻译，术语位置直接插目标词。
	// （降级损失的只是该句的内联格式与跨段流畅度，术语正确性优先）
	if (matcher) {
		for (let i = 0; i < results.length; i++) {
			// 哨兵计数：送入 N 个 token，译文必须原样出现 N 个。
			// 「出现的 token 回贴失败」与「token 被引擎整体吞掉」都视为缺失 → 降级。
			const sent = (texts[i].match(tokenRegex()) || []).length;
			const inOutput = (results[i].target.text.match(tokenRegex()) || []).length;
			const restored = restoreTokens(results[i].target.text, matcher.targets);
			if (sent > 0 && inOutput === sent && restored.missing === 0) {
				results[i].target.text = tidyCjkSpaces(restored.text);
				continue;
			}
			const parts = splitByTerms(originalTexts[i], matcher);
			const plainParts = parts
				.filter((p) => !p.term)
				.map((p) => p.plain.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
				.filter((t) => t);
			try {
				const sub = instance.translate({
					models: modelList,
					texts: plainParts.map((t) => ({ text: t, html: false })),
				});
				const translated = plainParts.map((t, k) => {
					void t;
					return sub[k]?.target.text ?? '';
				});
				let joined = '';
				let pi = 0;
				for (const part of parts) {
					if (part.term) joined += part.term;
					else {
						const piece = translated[pi] ?? '';
						pi++;
						joined += piece;
					}
				}
				results[i].target.text = tidyCjkSpaces(joined);
			} catch {
				// 分段降级也失败：至少把 token 还原为可读占位（目标词由调用侧兜底不可行，保留原样）
				results[i].target.text = restored.text;
			}
		}
	}

	// 写缓存：命中项保留原值，未命中项整理后写入；超限淘汰最旧
	const finalTo = modelList[modelList.length - 1].to;
	cacheKeys.forEach((k, i) => {
		const value =
			cached[i] !== undefined
				? cached[i]
				: finalTo === 'zh'
					? tidyCjkPunctuation(results[i].target.text)
					: results[i].target.text;
		translationCache.delete(k);
		translationCache.set(k, value);
		results[i].target.text = value;
	});
	while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
		translationCache.delete(translationCache.keys().next().value);
	}
	return results;
});

// 每批翻译完成后重置空闲计时器
if (modelIdleTimer !== undefined) touchModelActivity();

/** 术语回贴后的汉字间空格清理（回贴 token 时会带入空格） */
function tidyCjkSpaces(text) {
	return text.replace(/([\u4e00-\u9fff\u3040-\u30ff])[ ]+([\u4e00-\u9fff\u3040-\u30ff])/g, '$1$2');
}

rpcListen('engine:freeModel', async ({ direction }) => {
	if (!engine) return;
	return engine.freeTranslationModel({ from: direction.from, to: direction.to });
});

/* ---------------- OCR（Tesseract.js） ---------------- */

let tesseractLib = null;

/** 通过 <script> 标签加载 UMD 库（offscreen 是 window 上下文，无 importScripts） */
function loadScript(src) {
	return new Promise((resolve, reject) => {
		if (document.querySelector(`script[src="${src}"]`)) return resolve();
		const script = document.createElement('script');
		script.src = src;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`加载脚本失败: ${src}`));
		document.head.appendChild(script);
	});
}

/* OCR worker 池：createWorker 的 WASM 初始化需 1~2 秒，每次识别都重建
   是 OCR 慢的主因。按 langs+langPath 复用，空闲 5 分钟后回收释放内存。 */
const OCR_WORKER_IDLE_MS = 5 * 60_000;
/** @type {Map<string, {worker: Promise<object>, timer: ReturnType<typeof setTimeout>}>} */
const ocrWorkers = new Map();

function recycleOcrWorker(key) {
	const entry = ocrWorkers.get(key);
	if (!entry) return;
	ocrWorkers.delete(key);
	clearTimeout(entry.timer);
	void Promise.resolve(entry.worker)
		.then((w) => w.terminate())
		.catch(() => {});
}

async function getOcrWorker(langs, langPath) {
	const key = `${langs}|${langPath}`;
	const cached = ocrWorkers.get(key);
	if (cached) {
		clearTimeout(cached.timer);
		cached.timer = setTimeout(() => recycleOcrWorker(key), OCR_WORKER_IDLE_MS);
		return cached.worker;
	}
	const creating = tesseractLib.createWorker(langs, 1, {
		langPath,
		workerPath: '../../vendor/tesseract/worker.min.js',
		corePath: '../../vendor/tesseract',
		// MV3 扩展页 CSP 只放行 script-src 'self'，blob: worker 会被拦截；
		// 改为直接以同源脚本创建 Worker
		workerBlobURL: false,
		output: { text: true },
		errorHandler: (err) => console.warn('OCR worker 错误:', err),
	});
	ocrWorkers.set(key, {
		worker: creating,
		timer: setTimeout(() => recycleOcrWorker(key), OCR_WORKER_IDLE_MS),
	});
	// 创建失败立即出池，避免缓存住一个永远 reject 的 Promise
	creating.catch(() => recycleOcrWorker(key));
	return creating;
}

/**
 * OCR 识别
 * @param {{imageDataUrl: string, langs: string, langPath?: string}} params
 * @returns {Promise<{text: string, confidence: number}>}
 */
async function runOcr({ imageDataUrl, langs, langPath }) {
	if (!tesseractLib) {
		await loadScript('../../vendor/tesseract/tesseract.min.js');
		tesseractLib = self.Tesseract;
	}

	const resolvedLangPath = langPath || DEFAULT_OCR_LANG_PATH;
	const worker = await getOcrWorker(langs, resolvedLangPath);

	try {
		const result = await worker.recognize(imageDataUrl);
		return {
			text: result.data.text.trim(),
			confidence: result.data.confidence,
		};
	} catch (err) {
		// worker 可能已损坏（WASM 崩溃等）：出池，下次重建
		recycleOcrWorker(`${langs}|${resolvedLangPath}`);
		throw err;
	}
}

rpcListen('ocr:recognize', runOcr);

/** 后台轮询 offscreen 是否就绪（避免启动竞态） */
rpcListen('offscreen:ping', async () => true);


/* ---------------- 图片处理 ---------------- */

/** 加载图片为 HTMLImageElement（dataUrl 或扩展资源 URL） */
function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('图片加载失败'));
		img.src = src;
	});
}

/**
 * 裁剪全页截屏到指定矩形
 * @param {{dataUrl: string, rect: {x,y,width,height}, dpr: number}} params
 */
rpcListen('image:crop', async ({ dataUrl, rect, dpr }) => {
	const img = await loadImage(dataUrl);
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);
	const ctx = canvas.getContext('2d');
	ctx.drawImage(
		img,
		Math.round(rect.x * dpr),
		Math.round(rect.y * dpr),
		canvas.width,
		canvas.height,
		0,
		0,
		canvas.width,
		canvas.height,
	);
	return { dataUrl: canvas.toDataURL('image/png') };
});

/** 抓取任意图片 URL（绕过页面 canvas 跨域限制，仅限扩展权限内的资源） */
rpcListen('image:fetchAsDataUrl', async ({ url }) => {
	const response = await fetch(url, { credentials: 'omit' });
	if (!response.ok) throw new Error(`图片获取失败: ${response.status}`);
	const blob = await response.blob();
	const dataUrl = await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
	return { dataUrl };
});


/** 诊断：offscreen 内存（Bergamot WASM 堆计入 JS 堆） */
// 空闲自动卸载：15 分钟无翻译活动则释放模型内存（WASM 堆保留供复用，重载约 2 秒）
const MODEL_IDLE_MS = 15 * 60 * 1000;
let modelIdleTimer = null;
function touchModelActivity() {
	clearTimeout(modelIdleTimer);
	modelIdleTimer = setTimeout(async () => {
		if (!engine || engine.models.size === 0) return;
		for (const key of [...engine.models.keys()]) {
			const { from, to } = JSON.parse(key);
			engine.freeTranslationModel({ from, to });
		}
		engine.models.clear();
	}, MODEL_IDLE_MS);
}

rpcListen('offscreen:mem', () => {
	const mem = performance.memory || {};
	return {
		usedMB: Math.round((mem.usedJSHeapSize || 0) / 1048576),
		totalMB: Math.round((mem.totalJSHeapSize || 0) / 1048576),
		limitMB: Math.round((mem.jsHeapSizeLimit || 0) / 1048576),
		models: engine ? [...engine.models.keys()] : [],
	};
});
// 通知后台 offscreen 已就绪（尽力而为，后台会以 ping 轮询兜底）
rpcEmit('offscreen-ready', { ready: true });
