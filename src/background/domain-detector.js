/**
 * 领域识别：内置领域术语包 + 页面信号 → 加权打分 → 选包挂载
 *
 * 纯本地实现（零模型、零网络）；打分算法在 src/shared/domain-detect.js。
 * 信号权重：title×5 / meta description×4 / h1h2×4 / 正文采样×1。
 * 选包：score ≥ max(4, top×0.35) 且术语命中 ≥2，最多 3 包。
 */

import { scoreDomains, pickDomains } from '../shared/domain-detect.js';

/** 内置领域包（随扩展分发；术语格式 source,target,cs,weight） */
const BUILTIN_PACKS = [
	{ id: 'common-tech', label: '通用技术', file: 'glossaries/packs/common-tech.csv', always: true },
	{ id: 'ai', label: 'AI / 机器学习', file: 'glossaries/packs/ai.csv' },
	{ id: 'webdev', label: 'Web 开发', file: 'glossaries/packs/webdev.csv' },
	{ id: 'cloud', label: '云计算 / K8s', file: 'glossaries/packs/cloud.csv' },
];

let packsCache = null;

/** 加载内置领域包（懒加载；fetch 扩展内资源） */
async function loadPacks() {
	if (packsCache) return packsCache;
	const packs = [];
	for (const pack of BUILTIN_PACKS) {
		try {
			const url = chrome.runtime.getURL(`glossaries/packs/${pack.file}`);
			const text = await (await fetch(url)).text();
			const terms = [];
			for (const line of text.split(/\r?\n/).slice(1)) {
				if (!line.trim()) continue;
				const [source, target, cs, weight] = line.split(',');
				if (source?.trim() && target?.trim()) {
					terms.push({
						source: source.trim(),
						target: target.trim(),
						cs: /^(1|true|y|yes)$/i.test(cs ?? ''),
						weight: Number(weight) || 5,
					});
				}
			}
			packs.push({ id: pack.id, always: Boolean(pack.always), terms });
		} catch {
			/* 单包损坏跳过 */
		}
	}
	packsCache = packs;
	return packs;
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
