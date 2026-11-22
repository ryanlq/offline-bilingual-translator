/**
 * Kitten TTS 发音引擎（offscreen/background 上下文）
 *
 * 管线（基于 Algiras/kitten-tts-js 的 Apache-2.0 移植，见 vendor/kitten-tts/）：
 *   文本 → TextPreprocessor 规范化 → espeak-ng 音素化（Xenova/phonemizer.js，WASM 内嵌）
 *       → TextCleaner token IDs → KittenTTS nano-0.1 ONNX（ort-web WASM）→ 24kHz Float32 → WAV
 *
 * 资产策略：
 * - 随包分发：ort.mjs / ort-wasm-simd-threaded.wasm / phonemizer.js / voices.json（约 15MB）
 * - 按需下载：kitten_tts_nano_v0_1.onnx（22.7MB，HF，sha256 校验，存 model-store IndexedDB）
 * 下载完成后引擎常驻（session 复用）；释放由扩展生命周期管理。
 */

import { ensureModelFile } from '../background/model-store.js';
import { rpcEmit, rpcListen } from '../shared/rpc.js';
import { TextCleaner } from '../../vendor/kitten-tts/text-cleaner.js';
import { TextPreprocessor } from '../../vendor/kitten-tts/preprocess.js';
import { phonemize } from '../../vendor/kitten-tts/phonemizer.js';
import { encodeWav } from '../../vendor/kitten-tts/audio.js';

const TTS_MODEL_SPEC = {
	direction: 'tts',
	part: 'model',
	name: 'kitten_tts_nano_v0_1.onnx',
	url: 'https://huggingface.co/KittenML/kitten-tts-nano-0.1/resolve/main/kitten_tts_nano_v0_1.onnx',
	sha256: '8818e8f06eb34bc9d17ba3987a9b513c5759e2f5f119b1242cfbb503d12bdc0a',
	size: 23328896,
};

const SAMPLE_RATE = 24000;
const AUDIO_TRIM = 5000;
const MAX_CHUNK_CHARS = 400;

/** 音色目录：nano-0.1 内置 8 个 expr-voice 嵌入 */
const VOICES = [
	{ id: 'expr-voice-2-f', label: '女声 A（沉稳）' },
	{ id: 'expr-voice-2-m', label: '男声 A（沉稳）' },
	{ id: 'expr-voice-3-f', label: '女声 B（明亮）' },
	{ id: 'expr-voice-3-m', label: '男声 B（明亮）' },
	{ id: 'expr-voice-4-f', label: '女声 C' },
	{ id: 'expr-voice-4-m', label: '男声 C' },
	{ id: 'expr-voice-5-f', label: '女声 D' },
	{ id: 'expr-voice-5-m', label: '男声 D' },
];

/** @type {{ session: any, cleaner: any, preprocessor: any } | null} */
let engine = null;
let enginePromise = null;

async function fetchLocal(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`读取扩展资源失败: ${url}`);
	return response.arrayBuffer();
}

async function ensureEngine() {
	if (engine) return engine;
	if (!enginePromise) {
		enginePromise = (async () => {
			// 1. 按需下载模型（已缓存则秒回）
			const modelBuffer = await ensureModelFile(
				{ ...TTS_MODEL_SPEC, direction: TTS_MODEL_SPEC.direction, part: TTS_MODEL_SPEC.part },
				{ streamId: 'tts-pack' },
			);

			// 2. ort 运行时：包内静态资源，wasm 二进制直传（无需网络/路径解析）
			const ort = await import('../../vendor/ort/ort.mjs');
			const wasmBinary = await fetchLocal(chrome.runtime.getURL('vendor/ort/ort-wasm-simd-threaded.wasm'));
			ort.env.wasm.wasmBinary = wasmBinary;
			ort.env.wasm.numThreads = 1; // 扩展页无 COOP/COEP，单线程稳定
			ort.env.wasm.simd = true;

			const session = await ort.InferenceSession.create(modelBuffer, {
				executionProviders: ['wasm'],
			});

			// 3. 音色嵌入（包内 voices.json，构建期从 voices.npz 预转换）
			const voicesUrl = chrome.runtime.getURL('vendor/kitten-tts/voices.json');
			const voicesData = await fetch(voicesUrl).then((r) => r.json());
			const voices = {};
			for (const [key, v] of Object.entries(voicesData.voices)) {
				const bytes = Uint8Array.from(atob(v.b64), (c) => c.charCodeAt(0));
				const floats = new Float32Array(bytes.buffer);
				voices[key] = { data: floats, shape: v.shape };
			}

			const instance = {
				session,
				voices,
				ort,
				cleaner: new TextCleaner(),
				preprocessor: new TextPreprocessor({ remove_punctuation: false }),
			};
			engine = instance;
			return instance;
		})();
		enginePromise.catch(() => {
			enginePromise = null;
		});
	}
	return enginePromise;
}

/* ---------------- 合成 ---------------- */

function ensurePunctuation(text) {
	let t = text.trim();
	if (!t) return t;
	const last = t[t.length - 1];
	if (!['.', '!', '?', ',', ';', ':'].includes(last)) t += ',';
	return t;
}

/** 长文本按句/词切分为 ≤400 字符的处理块（移植自 kitten-tts-js） */
function chunkText(text) {
	const sentences = text.split(/[.!?]+/);
	const chunks = [];
	for (const s of sentences) {
		const sentence = s.trim();
		if (!sentence) continue;
		if (sentence.length <= MAX_CHUNK_CHARS) {
			chunks.push(ensurePunctuation(sentence));
			continue;
		}
		const words = sentence.split(/\s+/);
		let temp = '';
		for (const word of words) {
			if (temp.length + word.length + 1 <= MAX_CHUNK_CHARS) {
				temp += temp ? ` ${word}` : word;
			} else {
				if (temp) chunks.push(ensurePunctuation(temp.trim()));
				temp = word;
			}
		}
		if (temp) chunks.push(ensurePunctuation(temp.trim()));
	}
	return chunks;
}

const floatToBase64 = (floats) => {
	const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
	// 分片转二进制字符串：单次 spread 参数过多会触发栈溢出
	const parts = [];
	for (let i = 0; i < bytes.length; i += 8192) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
	}
	return btoa(parts.join(''));
};

/**
 * 合成一段文本 → WAV base64
 * @param {{ text: string, voice?: string, speed?: number }} params
 * @returns {Promise<{ wav: string, duration: number }>}
 */
export async function synthesize({ text, voice = 'expr-voice-2-f', speed = 1.0 }) {
	const instance = await ensureEngine();
	const { ort } = instance;
	const voiceEntry = instance.voices[voice];
	if (!voiceEntry) throw new Error(`未知音色: ${voice}`);
	const [numStyles, styleDim] = voiceEntry.shape;

	const chunks = chunkText(text);
	const samples = [];
	for (const chunk of chunks) {
		const processed = instance.preprocessor.process(chunk);
		const phonemes = await phonemize(processed);
		const tokenIds = instance.cleaner.clean(phonemes.trim());
		const refId = Math.min(tokenIds.length, numStyles - 1);
		const style = voiceEntry.data.slice(refId * styleDim, (refId + 1) * styleDim);

		const seqLen = tokenIds.length;
		const feeds = {
			input_ids: new ort.Tensor('int64', BigInt64Array.from(tokenIds.map(BigInt)), [1, seqLen]),
			style: new ort.Tensor('float32', new Float32Array(style), [1, styleDim]),
			speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
		};
		const results = await instance.session.run(feeds);
		const outKey = Object.keys(results)[0];
		const audio = results[outKey].data;
		samples.push(audio.slice(0, Math.max(0, audio.length - AUDIO_TRIM)));
	}

	const totalLen = samples.reduce((s, a) => s + a.length, 0);
	const combined = new Float32Array(totalLen);
	let offset = 0;
	for (const chunk of samples) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	const wav = encodeWav(combined, SAMPLE_RATE);
	return {
		wav: floatToBase64(new Uint8Array(wav)),
		duration: totalLen / SAMPLE_RATE,
	};
}

/* ---------------- RPC ---------------- */

rpcListen('tts-engine:status', async () => {
	try {
		const { getModelFile } = await import('../background/model-store.js');
		const cached = await getModelFile(TTS_MODEL_SPEC.direction, TTS_MODEL_SPEC.part);
		return { installed: Boolean(cached), size: TTS_MODEL_SPEC.size };
	} catch {
		return { installed: false };
	}
});

rpcListen('tts-engine:download', async ({ streamId } = {}) => {
	const sid = streamId ?? 'tts-pack';
	await ensureEngine();
	rpcEmit(sid, { label: TTS_MODEL_SPEC.name, done: true });
	return { ok: true };
});

rpcListen('tts-engine:synthesize', async ({ text, voice, speed }) => {
	if (!text?.trim()) throw new Error('缺少文本');
	return synthesize({ text, voice, speed });
});
