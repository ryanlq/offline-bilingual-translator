#!/usr/bin/env node
/**
 * 验证「更多语言包」链路（零依赖，需要联网下载模型）
 *
 *   1. 用 src/shared/models-registry.js 里的真实 buildExtraRegistry 转换官方索引
 *   2. 下载 1~2 个语言包的全部文件，逐个校验字节数与 sha256
 *   3. 用 vendor 的 Bergamot WASM 引擎在 Node 中实际加载模型并翻译一句
 *
 * 用法：
 *   node tools/verify-language-packs.mjs                     # 默认 ende + fren
 *   node tools/verify-language-packs.mjs --pairs=uken,enfr  # 指定语言对
 *   node tools/verify-language-packs.mjs --download-only    # 只验下载/校验
 *   node tools/verify-language-packs.mjs --fresh            # 忽略本地缓存重新下载
 *
 * 下载内容缓存在 .cache/language-packs/，不会进入发布包。
 */

import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'language-packs');
const args = new Set(process.argv.slice(2));
const argValue = (name, fallback) => {
	const hit = [...args].find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const pairs = argValue('pairs', 'ende,fren').split(',').map((s) => s.trim()).filter(Boolean);
const downloadOnly = args.has('--download-only');
const fresh = args.has('--fresh');

const problems = [];
function fail(message) {
	problems.push(message);
	console.log(`  ✗ ${message}`);
}
function ok(message) {
	console.log(`  ✓ ${message}`);
}
function formatBytes(n) {
	return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
}

/** 以 data URL 载入真实源码，确保验证的是扩展里实际使用的转换逻辑（registry 无外部 import） */
const registrySource = await readFile(
	path.join(ROOT, 'src/shared/models-registry.js'),
	'utf8',
);
const registry = await import(
	'data:text/javascript;base64,' + Buffer.from(registrySource).toString('base64')
);

/* ---------------- 1. 官方索引 ---------------- */

console.log('\n[1/3] 获取并转换官方语言包索引');
await mkdir(CACHE, { recursive: true });
const indexPath = path.join(CACHE, 'index.json');

let index = null;
let indexSource = 'remote';
try {
	const response = await fetch(registry.S3_REGISTRY_URL, {
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const raw = Buffer.from(await response.arrayBuffer());
	try {
		index = JSON.parse(raw.toString('utf8'));
	} catch {
		// S3 上该对象可能带 Content-Encoding: gzip，Node fetch 未必自动解压
		index = JSON.parse(gunzipSync(raw).toString('utf8'));
	}
	await writeFile(indexPath, JSON.stringify(index));
} catch (err) {
	indexSource = 'cache';
	try {
		index = JSON.parse(await readFile(indexPath, 'utf8'));
	} catch {
		fail(`无法获取语言包索引，且没有本地缓存：${err.message}`);
		process.exit(1);
	}
}

const all = registry.buildExtraRegistry(index);
const shape = { singleVocab: 0, splitVocab: 0, withConfig: 0 };
for (const meta of Object.values(all)) {
	if (meta.files.vocab) shape.singleVocab += 1;
	else shape.splitVocab += 1;
	if (meta.config) shape.withConfig += 1;
}
ok(
	`索引来源 ${indexSource}，共 ${Object.keys(all).length} 个语言包全部通过格式校验` +
		`（单 vocab ${shape.singleVocab} / 双 vocab ${shape.splitVocab} / 带 config ${shape.withConfig}）`,
);
if (Object.keys(all).length < 10) fail('索引条目异常偏少，可能是格式不兼容');
for (const key of pairs) {
	if (!all[key]) fail(`索引中找不到指定的语言包 ${key}`);
}
if (problems.length) process.exit(1);

/* ---------------- 2. 下载 + 校验 ---------------- */

console.log('\n[2/3] 下载并校验语言包文件');
const downloaded = {};

async function cachedFileIsValid(file, spec) {
	try {
		const info = await stat(file);
		if (info.size !== spec.size) return false;
		const buf = await readFile(file);
		return createHash('sha256').update(buf).digest('hex') === spec.sha256;
	} catch {
		return false;
	}
}

for (const key of pairs) {
	const meta = all[key];
	const dir = path.join(CACHE, key);
	await mkdir(dir, { recursive: true });
	if (fresh) await rm(dir, { recursive: true, force: true }).then(() => mkdir(dir, { recursive: true }));

	const parts = Object.values(meta.files);
	const results = [];
	for (const spec of parts) {
		const dest = path.join(dir, spec.name);
		let state = 'cached';
		if (!(await cachedFileIsValid(dest, spec))) {
			const response = await fetch(spec.url, { signal: AbortSignal.timeout(180_000) });
			if (!response.ok) {
				fail(`${key}/${spec.name} 下载失败：HTTP ${response.status}`);
				continue;
			}
			const buf = Buffer.from(await response.arrayBuffer());
			if (buf.length !== spec.size) {
				fail(`${key}/${spec.name} 大小不符：${buf.length} ≠ ${spec.size}`);
				continue;
			}
			const hash = createHash('sha256').update(buf).digest('hex');
			if (hash !== spec.sha256) {
				fail(`${key}/${spec.name} SHA-256 不符`);
				continue;
			}
			await writeFile(dest, buf);
			state = 'downloaded';
		}
		results.push({ spec, dest, state });
	}

	const total = parts.reduce((sum, f) => sum + f.size, 0);
	if (results.length !== parts.length) {
		fail(`${key} 有文件未能下载/校验通过`);
		continue;
	}
	ok(
		`${key}（${meta.label}）${parts.length} 个文件 · ${formatBytes(total)} · sha256 全部匹配` +
			` · ${results.every((r) => r.state === 'cached') ? '命中本地缓存' : '本次下载'}`,
	);
	downloaded[key] = { meta, files: results };
}

if (problems.length || downloadOnly) {
	if (problems.length) process.exit(1);
	ok('已按 --download-only 跳过引擎实测');
	process.exit(0);
}

/* ---------------- 3. WASM 引擎实测翻译 ---------------- */

console.log('\n[3/3] 用 vendor 的 Bergamot WASM 引擎实际翻译');

const glue = await readFile(
	path.join(ROOT, 'vendor/bergamot/bergamot-translator-worker.js'),
	'utf8',
);
const wasm = await readFile(
	path.join(ROOT, 'vendor/bergamot/bergamot-translator-worker.wasm'),
);

let resolveInit;
const initialized = new Promise((resolve) => { resolveInit = resolve; });
const Module = {
	wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
	onRuntimeInitialized: () => resolveInit(),
	print: () => {},
	printErr: () => {},
	locateFile: () => 'bergamot-translator-worker.wasm',
};
const loadGlue = new Function('Module', `${glue}\nreturn Module;`);
const runtime = loadGlue(Module);
await Promise.race([
	initialized,
	new Promise((_, reject) => setTimeout(() => reject(new Error('WASM 初始化超时')), 60_000)),
]);
ok('WASM 运行时初始化成功');
const service = new runtime.BlockingService({ cacheSize: 0 });

function aligned(buffer, alignment) {
	const bytes = new Int8Array(
		buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
	);
	const memory = new runtime.AlignedMemory(bytes.byteLength, alignment);
	memory.getByteArrayView().set(bytes);
	return memory;
}

/** 与 src/offscreen/offscreen.js 的 loadTranslationModel 保持同一套配置 */
function buildTranslationModel({ meta, files }) {
	const byPart = {};
	for (const { spec, dest } of files) byPart[spec.part] = readFileSync(dest);

	const vocabBuffers = byPart.vocab
		? [byPart.vocab]
		: [byPart.srcvocab, byPart.trgvocab];
	if (vocabBuffers.some((b) => !b)) throw new Error('词表文件缺失');

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
	if (meta.config) Object.assign(modelConfig, meta.config);
	if (modelConfig['gemm-precision'] === 'int8') {
		modelConfig['gemm-precision'] = 'int8shiftAll';
	}
	const modelName = files.find((f) => f.spec.part === 'model')?.spec.name || '';
	if (modelName.endsWith('intgemm8.bin')) {
		modelConfig['gemm-precision'] = 'int8shiftAll';
	}

	const yaml = Object.entries(modelConfig)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join('\n');

	const vocabs = new runtime.AlignedMemoryList();
	for (const buffer of vocabBuffers) vocabs.push_back(aligned(buffer, 64));

	return new runtime.TranslationModel(
		yaml,
		aligned(byPart.model, 256),
		byPart.lex ? aligned(byPart.lex, 64) : null,
		vocabs,
		null,
	);
}

const SAMPLES = {
	ende: 'The weather is nice today.',
	fren: 'Bonjour le monde',
	enfr: 'The weather is nice today.',
	enes: 'The weather is nice today.',
	esen: 'El tiempo es agradable hoy.',
	uken: 'Привіт, світе',
	enuk: 'The weather is nice today.',
};

for (const [key, entry] of Object.entries(downloaded)) {
	const sample = SAMPLES[key] || 'Hello world';
	try {
		const model = buildTranslationModel(entry);
		const input = new runtime.VectorString();
		input.push_back(sample);
		const options = new runtime.VectorResponseOptions();
		options.push_back({ alignment: false, html: false, qualityScores: false });
		const responses = service.translate(model, input, options);
		const translated = responses.get(0).getTranslatedText();
		responses.delete();
		input.delete();
		options.delete();
		model.delete();

		if (!translated || translated === sample) {
			fail(`${key} 译文为空或与原句相同：「${translated}」`);
		} else {
			ok(`${key}「${sample}」→「${translated}」`);
		}
	} catch (err) {
		fail(`${key} 引擎加载/翻译失败：${err.message}`);
	}
}

console.log('');
if (problems.length) {
	console.log(`✗ 验证未通过（${problems.length} 项）`);
	process.exit(1);
}
console.log('✓ 语言包下载校验与引擎实测翻译全部通过');
