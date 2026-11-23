/**
 * KittenTTS 2 nano 英文 G2P（务实移植）。
 *
 * 官方管线：tts_norm 规范化 → misaki 词典 → CMUdict → BART 兜底 → vocab 过滤 → 分块。
 * 本移植：misaki 词典不可用（Python 包），查表链为 gold → silver → CMUdict；
 * 未收录词的兜底用 espeak-ng IPA 近似（vocab 过滤掉超出 119 符号集的部分），
 * Phase 2 计划用 BART（g2p_bart_en_us，2.87MB）替换该近似以修正生词发音。
 *
 * FOLD 表移植自 phonemize_v1（espeak 输出中 vocab 没有的附加记号，按官方测得值折叠）。
 */

import { normalize } from './tts-norm.js';

// phonemize_v1 的 FOLD 表中影响英文/通用的部分
const FOLD = {
	'\u0329': '',   // syllabic mark（espeak en 回退）
	'\u030d': '',   // vertical line above
	'\u032f': '',   // non-syllabic
	'\u00bf': '',   // ¿
	'\u00a1': '',   // ¡
	'\u202f': ' ',  // 窄不换行空格
	'\u0005': '', '\u0006': '', '\u0007': '', '\u0008': '',
	'{': '', '}': '', '[': '', ']': '',
};

const TRANSLIT = {
	'ø': 'o', 'Ø': 'O', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE',
	'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', '’': "'",
};

const DIGITS = 'zero one two three four five six seven eight nine'.split(' ');

export function createEnG2P(deps) {
	return new EnG2P(deps);
}

export class EnG2P {
	/**
	 * @param {{ gold: object, silver: object, cmu: object, vocab: object }} lexicons
	 * @param {(text: string) => Promise<string|string[]>} espeakPhonemize espeak 兜底音素化
	 */
	constructor({ gold, silver, cmu, vocab, espeakPhonemize }) {
		this.gold = gold;
		this.silver = silver;
		this.cmu = cmu;
		this.vocab = vocab;
		this.vocabSet = new Set(Object.keys(vocab));
		this.espeakPhonemize = espeakPhonemize;
	}

	/** CMUdict 查询：整词 → 所有格 's 规则 → 连字符分段 */
	_cmu(word) {
		const w = word.toLowerCase();
		if (this.cmu[w]) return this.cmu[w];
		if (w.endsWith("'s") && this.cmu[w.slice(0, -2)]) {
			const stem = this.cmu[w.slice(0, -2)];
			return stem + (/[ptkfθ]$/.test(stem) ? 's' : /[szʃʒʧʤ]$/.test(stem) ? 'ᵻz' : 'z');
		}
		return null;
	}

	/** 单词 → 音素：CMUdict → gold → silver → null（交给 espeak 兜底） */
	wordPhonemes(word) {
		const w = word.toLowerCase();
		if (this.cmu[w]) return this.cmu[w];
		if (this.gold[w]) return this.gold[w];
		if (this.silver[w]) return this.silver[w];
		if (w.includes('-')) {
			const parts = w.split('-').filter(Boolean).map((p) => this.cmuLookupChain(p));
			if (parts.every((p) => p !== null)) return parts.join('');
		}
		return null;
	}

	cmuLookupChain(word) {
		return this.cmu[word] ?? this.gold[word] ?? this.silver[word] ?? null;
	}

	/** espeak IPA 近似：保留 vocab 内符号；重音符 ˈ/ˌ 转为大写元音（misaki 约定） */
	async fallbackPhonemes(word) {
		try {
			const result = await this.espeakPhonemize(word);
			const ipa = Array.isArray(result) ? result.join(' ') : String(result ?? '');
			return this.foldIpa(ipa);
		} catch {
			return '';
		}
	}

	foldIpa(ipa) {
		let t = ipa;
		for (const [src, dst] of Object.entries(FOLD)) t = t.split(src).join(dst);
		let out = '';
		let capNext = false;
		for (const ch of t) {
			if (ch === 'ˈ' || ch === 'ˌ') {
				capNext = this.vocabSet.has(ch); // vocab 含 ˈˌ：保留符号本身
				out += ch;
				continue;
			}
			let c = ch;
			if (capNext && /[æɑɒəɛɪʊʌ PIOQWY]/i.test(c)) {
				const upper = c.toUpperCase();
				if (this.vocabSet.has(upper)) c = upper;
			}
			capNext = false;
			if (this.vocabSet.has(c)) out += c;
			// vocab 外的符号（espeak 特有记号）丢弃
		}
		return out;
	}

	/** 一个拼写词：NFKD 折叠重音 → 整词/连字符段查表 → espeak 兜底 */
	async say(word) {
		let t = word.normalize('NFKD').replace(/[øØßæÆœŒłŁđĐ’]/g, (c) => TRANSLIT[c] ?? c);
		t = [...t].filter((c) => !/\p{M}/u.test(c)).join('');
		const whole = this.wordPhonemes(t);
		if (whole !== null) return whole;
		if (t.includes('-')) {
			const parts = [];
			let allOk = true;
			for (const part of t.split('-').filter(Boolean)) {
				const ps = this.wordPhonemes(part) ?? (await this.fallbackPhonemes(part));
				if (!ps) { allOk = false; break; }
				parts.push(ps);
			}
			if (allOk) return parts.join(' ');
		}
		return this.fallbackPhonemes(t);
	}

	/** 文本 → 音素串（数字展开由 tts_norm 在上游完成；这里逐词查表/兜底） */
	async sayText(text) {
		const t = text.normalize('NFKC');
		const out = [];
		for (const match of t.matchAll(/([\p{L}'’-]+)|(\d+)|([^\s\p{L}\d]+)|(\s+)/gu)) {
			if (match[1]) {
				const ps = await this.say(match[1]);
				if (ps) out.push(ps);
			} else if (match[2]) {
				for (const d of match[2]) out.push(DIGIT_WORDS[+d]);
			} else if (match[3]) {
				out.push(match[3]);
			} else if (match[4]) {
				out.push(' ');
			}
		}
		return out.join('').replace(/\s+/g, ' ').trim();
	}
}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * 文本 → 句子级音素块（每块 ≤350 音素，句末优先切分）。
 * @param {{ normalizeText?: boolean }} options
 */
export function phonemeChunks(phonemes, { maxPhon = 350 } = {}) {
	const whole = phonemes;
	if (whole.length <= maxPhon) return whole ? [whole] : [];
	// 超长：按句末标点重切（规范化后的文本仍保留句读）
	const chunks = [];
	let current = '';
	for (const sent of whole.split(/(?<=[.!?]\s)/)) {
		const trimmed = sent.trim();
		if (!trimmed) continue;
		if (current && current.length + 1 + trimmed.length > maxPhon) {
			chunks.push(current);
			current = trimmed;
		} else {
			current = current ? `${current} ${trimmed}` : trimmed;
		}
	}
	if (current) chunks.push(current);
	// 单句仍超长：按空格硬切
	const final = [];
	for (const chunk of chunks) {
		if (chunk.length <= maxPhon) { final.push(chunk); continue; }
		let piece = '';
		for (const word of chunk.split(' ')) {
			if (piece && piece.length + 1 + word.length > maxPhon) {
				final.push(piece);
				piece = word;
			} else {
				piece = piece ? `${piece} ${word}` : word;
			}
		}
		if (piece) final.push(piece);
	}
	return final;
}
