/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * 本文件改编自 MPL-2.0 覆盖文件，按文件级 copyleft 保持 MPL-2.0，
 * 不随项目主体改授 Apache-2.0。详见 THIRD_PARTY_NOTICES.md。
 */

/**
 * Bergamot 翻译 Worker
 *
 * 职责：
 * 1. 通过 importScripts 加载 emscripten 胶水代码 bergamot-translator-worker.js
 *    并实例化 bergamot-translator-worker.wasm（引擎，MPL-2.0，原样分发）
 * 2. 管理模型生命周期（加载/释放），缓存已加载模型
 * 3. 批量翻译
 *
 * 消息协议：{id, name, args} → {id, result} | {id, error:{name,message,stack}}
 * 支持方法：initialize / hasTranslationModel / loadTranslationModel /
 *           freeTranslationModel / translate
 *
 * 改编自 bergamot-translator 的 translator-worker.js
 * （MPL-2.0, https://github.com/browsermt/bergamot-translator）
 * 及 Linguist 的封装（BSD-3-Clause, https://github.com/translate-tools/linguist）。
 *
 * 与上游的关键差异：loadTranslationModel 支持短列表为 null（禁用 shortlist），
 * 用于 enzh 模型（中文 lex 表与文档级 shortlisting 冲突）。
 *
 * 注意：当前生产路径为 offscreen 文档主线程直载引擎（src/offscreen/offscreen.js），
 * 本文件是保留的 Dedicated Worker 版封装（部分 Chromium 环境的专用 Worker
 * 存在异常，且主线程方案无需跨上下文传输模型缓冲区），
 * 供 tools/e2e-test.mjs 与后续平台适配使用，消息协议与主线程版保持一致。
 */

'use strict';

// eslint-disable-next-line no-var
var Module = {};

/**
 * @typedef {{model: ArrayBuffer, shortlist: ArrayBuffer|null, vocabs: ArrayBuffer[], qualityModel: ArrayBuffer|null, config?: Object<string, string|number>}} ModelBuffers
 */

class BergamotTranslatorWorker {
	constructor() {
		this.models = new Map();
	}

	/**
	 * 实例化 WASM 运行时
	 * @param {{cacheSize?: number, wasmBinary?: ArrayBuffer}} options
	 *   wasmBinary：可选。由宿主（offscreen 文档）预先读取 wasm 字节后传入，
	 *   使 Worker 内无需 fetch 扩展资源（部分环境下 worker 内 fetch 受限）。
	 *   未提供时回退为让 emscripten 胶水自行 fetch/locate。
	 */
	async initialize(options = {}) {
		this.options = options;
		this.models = new Map();
		this.module = await this.loadModule(options);
		this.service = new this.module.BlockingService({
			cacheSize: Math.max(this.options.cacheSize ?? 0, 0),
		});
	}

	/**
	 * 加载 emscripten 模块
	 */
	loadModule({ wasmBinary } = {}) {
		return new Promise((resolve, reject) => {
			const moduleOptions = {
				onRuntimeInitialized: () => resolve(Module),
			};
			if (wasmBinary) {
				// emscripten 原生支持：提供 wasmBinary 后跳过所有 fetch/XHR
				moduleOptions.wasmBinary = wasmBinary;
			}
			Object.assign(Module, moduleOptions);
			try {
				// 胶水代码内部已包含 mozIntGemm 优先 / 回退实现的 gemm 链接逻辑
				self.Module = Module;
				self.importScripts('../../vendor/bergamot/bergamot-translator-worker.js');
			} catch (err) {
				reject(err);
			}
		});
	}

	/**
	 * 查询模型是否已加载
	 */
	hasTranslationModel({ from, to }) {
		return this.models.has(JSON.stringify({ from, to }));
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

	/**
	 * 释放模型内存
	 */
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

function cloneError(error) {
	return {
		name: error?.name,
		message: error?.message ?? String(error),
		stack: error?.stack,
	};
}

const worker = new BergamotTranslatorWorker();

self.addEventListener('message', async (request) => {
	const {
		data: { id, name, args },
	} = request;
	if (!id) {
		console.error('收到无 id 的消息', request);
		return;
	}

	try {
		if (typeof worker[name] !== 'function') {
			throw new TypeError(`worker[${name}] 不是函数`);
		}

		const result = await Promise.resolve(
			Reflect.apply(worker[name], worker, args),
		);
		self.postMessage({ id, result });
	} catch (error) {
		self.postMessage({ id, error: cloneError(error) });
	}
});
