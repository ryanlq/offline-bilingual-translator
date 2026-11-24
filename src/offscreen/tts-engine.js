/**
 * KittenTTS 2 Nano 发音引擎（英文，offscreen/background 上下文）
 *
 * 管线：tts-norm 规范化 → 词典链 G2P（gold → silver → CMUdict → espeak IPA 兜底）
 *     → tokens [0]+ids+[10,0] → nano int8 ONNX → 24kHz 音频
 *
 * 资产策略（重要）：
 * - 下载一律由后台完成（SW 有 host 权限的 CORS 豁免；offscreen 文档没有——
 *   HF 的 xet CDN 重定向无 CORS 头，在 offscreen 里 fetch 会被拦）
 * - offscreen/background 只从 IndexedDB 读取已下载的资产并合成
 * - 随包分发：ort.mjs / ort-wasm / phonemizer.js / vocab.json / us_gold / us_silver /
 *   voices-en.json（音色名表）
 * - 按需下载（首次启用发音包，约 26MB，sha256 校验，model-store 缓存）：
 *   nano int4 ONNX / voices_en.npz / cmu_misaki_us.json
 *
 * 模型来源 KittenML/kitten-tts-2-nano（Apache-2.0）；推理契约：
 *   input_ids [1,T] int64 + style [1,256] float32 + speed [1] float32 → wav, durations
 * 音色包每音色一组 [510, 256] 风格向量，按 token 数取行。
 */

import { getModelFile } from '../background/model-store.js';
import { rpcListen } from '../shared/rpc.js';
import { phonemize } from '../../vendor/kitten-tts/phonemizer.js';
import { encodeWav } from '../../vendor/kitten-tts/audio.js';
import { normalize as ttsNorm } from '../../vendor/kitten-tts-2/tts-norm.js';
import { createEnG2P, phonemeChunks } from '../../vendor/kitten-tts-2/g2p-en.js';
import { loadNpz } from '../../vendor/kitten-tts-2/zip-npz.js';

const SAMPLE_RATE = 24000;
const GAP_SAMPLES = Math.round(0.15 * SAMPLE_RATE); // 分块间 0.15s 静音（对齐官方合成）

/** @type {{ session: any, ort: any, g2p: any, packs: any, vocabTable: any } | null} */
let engine = null;
let enginePromise = null;

async function fetchPackageFile(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`读取扩展资源失败: ${url}`);
	return response.arrayBuffer();
}

async function fetchPackageJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`读取扩展资源失败: ${url}`);
	return response.json();
}

async function ensureEngine() {
	if (engine) return engine;
	if (!enginePromise) {
		enginePromise = (async () => {
			// 1. 从 IndexedDB 读取已由后台下载好的资产（不含下载逻辑，见 SW 侧 tts:download）
			const modelBuffer = await getModelFile('tts2', 'model').then((r) => r?.buffer);
			const voicesBuffer = await getModelFile('tts2', 'voices').then((r) => r?.buffer);
			const cmuBuffer = await getModelFile('tts2', 'cmu').then((r) => r?.buffer);
			if (!modelBuffer || !voicesBuffer || !cmuBuffer) {
				throw new Error('发音包未下载完成');
			}

			// 2. ONNX Runtime Web：wasm 二进制由包内直传，绕开路径解析
			const ort = await import('../../vendor/ort/ort.mjs');
			ort.env.wasm.wasmBinary = await fetchPackageFile(
				chrome.runtime.getURL('vendor/ort/ort-wasm-simd-threaded.wasm'));
			ort.env.wasm.numThreads = 1; // 扩展页无 COOP/COEP，单线程稳定
			ort.env.wasm.simd = true;
			const session = await ort.InferenceSession.create(modelBuffer, {
				executionProviders: ['wasm'],
			});

			// 3. 词典与音色
			const gold = await fetchPackageJson(chrome.runtime.getURL('vendor/kitten-tts-2/us_gold.json'));
			const silver = await fetchPackageJson(chrome.runtime.getURL('vendor/kitten-tts-2/us_silver.json'));
			const vocab = await fetchPackageJson(chrome.runtime.getURL('vendor/kitten-tts-2/vocab.json'));
			const cmu = JSON.parse(new TextDecoder().decode(cmuBuffer));
			const packs = await loadNpz(voicesBuffer);

			const g2p = createEnG2P({
				gold, silver, cmu, vocab,
				espeakPhonemize: async (text) => {
					const result = await phonemize(text);
					return Array.isArray(result) ? result.join(' ') : String(result ?? '');
				},
			});

			engine = { session, ort, g2p, packs, vocabTable: vocab };
			return engine;
		})();
		enginePromise.catch(() => {
			enginePromise = null;
		});
	}
	return enginePromise;
}

/* ---------------- 合成 ---------------- */

function tokensOf(phonemes, vocab) {
	const ids = [];
	for (const ch of phonemes) {
		if (ch in vocab) ids.push(vocab[ch]);
		else if (ch === '(' || ch === ')') ids.push(vocab[',']);
	}
	return [0, ...ids, 10, 0];
}

function bytesToBase64(bytes) {
	const parts = [];
	for (let i = 0; i < bytes.length; i += 8192) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
	}
	return btoa(parts.join(''));
}

/**
 * 合成一段文本 → WAV base64
 * @param {{ text: string, voice?: string, speed?: number }} params
 * @returns {Promise<{ wav: string, duration: number }>}
 */
export async function synthesize({ text, voice = 'serena', speed = 1.0 }) {
	speed = Math.min(2, Math.max(0.5, Number(speed) || 1)); // 防御性钳制
	const instance = await ensureEngine();
	const { session, ort, g2p, packs, vocabTable } = instance;

	const normalized = ttsNorm(text);
	const phonemes = await g2p.sayText(normalized);
	const chunks = phonemeChunks(phonemes);
	if (!chunks.length) throw new Error('没有可朗读的内容');

	const pack = packs[voice];
	if (!pack) throw new Error(`未知音色: ${voice}（可用: ${Object.keys(packs).join(',')}）`);
	const stylePack = pack.data instanceof Float32Array ? pack.data : new Float32Array(pack.data);
	const styleRows = stylePack.length / 256;

	const audioChunks = [];
	let keepStart = true;
	for (const chunkPhonemes of chunks) {
		const tokens = [0, ...tokensOf(chunkPhonemes, vocabTable), 10, 0];
		const row = Math.min(tokens.length - 1, styleRows - 1);
		const style = stylePack.slice(row * 256, row * 256 + 256);
		const feeds = {
			input_ids: new ort.Tensor('int64', BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]),
			style: new ort.Tensor('float32', new Float32Array(style), [1, 256]),
			speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
		};
		const results = await session.run(feeds);
		const outKeys = Object.keys(results);
		const wav = Float32Array.from(results[outKeys[0]].data, (v) => Math.max(-1, Math.min(1, v)));
		const durations = outKeys[1] ? results[outKeys[1]].data : null;
		let chunkAudio = wav;
		if (durations && durations.length >= 2) {
			const totalDur = [...durations].reduce((s, d) => s + Number(d), 0);
			const spf = Math.max(1, Math.round(wav.length / Math.max(totalDur, 1)));
			const lead = keepStart ? 0 : Math.max(0, Number(durations[0]) - 1) * spf;
			const trail = Math.max(0, Number(durations[durations.length - 1]) - 1) * spf;
			chunkAudio = wav.slice(lead, wav.length - trail);
		}
		audioChunks.push(chunkAudio);
		if (!keepStart) audioChunks.push(new Float32Array(GAP_SAMPLES));
		keepStart = false;
	}

	const totalLen = audioChunks.reduce((s, a) => s + a.length, 0);
	const combined = new Float32Array(totalLen);
	let offset = 0;
	for (const chunk of audioChunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	const wav = encodeWav(combined, SAMPLE_RATE);
	return {
		wav: bytesToBase64(new Uint8Array(wav)),
		duration: totalLen / SAMPLE_RATE,
	};
}


rpcListen('tts-engine:status', async () => {
	try {
		const cached = await getModelFile('tts2', 'model');
		return { installed: Boolean(cached), size: 26008029 };
	} catch {
		return { installed: false };
	}
});

rpcListen('tts-engine:synthesize', async ({ text, voice, speed }) => {
	if (!text?.trim()) throw new Error('缺少文本');
	return synthesize({ text, voice, speed });
});

rpcListen('tts-engine:voices', async () => {
	const names = JSON.parse(await fetchPackageFile(
		chrome.runtime.getURL('vendor/kitten-tts-2/voices-en.json')));
	return names.en.map((v) => ({ key: v.key, label: `${v.name} · ${v.description}` }));
});
