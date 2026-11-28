/**
 * 领域识别：内置领域术语包 + 页面信号 → 加权打分 → 选包挂载
 *
 * 纯本地实现（零模型、零网络）；打分算法在 src/shared/domain-detect.js。
 * 信号权重：title×5 / meta description×4 / h1h2×4 / 正文采样×1。
 * 选包：score ≥ max(4, top×0.35) 且术语命中 ≥2，最多 3 包。
 */

import { scoreDomains, pickDomains } from '../shared/domain-detect.js';
import { BUILTIN_PACKS as PACK_DATA } from './domain-packs-data.js';

let packsCache = null;

/** 加载内置领域包（懒加载；fetch 扩展内资源） */
let lastLoadError = null;

async function loadPacks() {
	if (packsCache) return packsCache;
	// 数据构建时已内嵌（domain-packs-data.js），无需运行时 fetch
	packsCache = PACK_DATA.map((p) => ({
		id: p.id,
		always: Boolean(p.always),
		terms: p.terms.map((t) => ({ ...t })),
	}));
	lastLoadError = null;
	return packsCache;
}

/** 诊断：包加载状态 */
export async function debugPacks() {
	await loadPacks();
	return { count: packsCache.length, error: lastLoadError, ids: packsCache.map((p) => `${p.id}:${p.terms.length}`) };
}

/** 领域打分 + 选包 */
export async function detectDomains(signals) {
	const packs = await loadPacks();
	const scored = scoreDomains(signals, packs.filter((p) => p.terms.length));
	const picked = pickDomains(scored);
	const always = packs.filter((p) => p.always).map((p) => p.id);
	return { domains: [...new Set([...always, ...picked])], scored };
}

/** 领域包术语（不含用户术语） */
export async function packTermsFor(domains) {
	const packs = await loadPacks();
	const out = [];
	for (const pack of packs) {
		if (!domains.includes(pack.id)) continue;
		for (const t of pack.terms) {
			out.push({ source: t.source, target: t.target, cs: t.cs, domain: pack.id });
		}
	}
	return out;
}
