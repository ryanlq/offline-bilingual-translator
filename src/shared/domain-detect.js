/**
 * 领域识别与术语包打分（纯函数，无运行环境依赖；SW 与 node 测试共用）
 *
 * 方案：不做独立「关键词表」——直接用领域术语包本身做加权命中打分。
 *   score(领域) = Σ (术语权重 × 命中区域权重)   区域权重：title×5 / meta×4 / h1h2×4 / 正文×1
 * 选包：score ≥ max(4, topScore × 0.35) 且命中 ≥2 个不同术语（单一弱词不触发），最多 3 包。
 * 通用词低权重（model=2）天然不会误触发；强指向词（transformer=10）一击即中。
 */

/** 区域权重：信号区越「标题化」权重越高 */
export const REGION_WEIGHTS = { title: 5, description: 4, h1h2: 4, body: 1 };

/** 元字符转义 */
function esc(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 纯 ASCII 词（连字符算词内：user-agent 不误伤） */
function isAsciiWord(s) {
	return /^[\w][\w\s.-]*$/.test(s);
}

/** 规格化术语条目：{source, target?, weight, cs} → 匹配用条目 */
function normalizeTerms(rawTerms) {
	return rawTerms
		.map((t) => ({
			source: String(t.source || '').trim(),
			target: String(t.target || '').trim(),
			weight: Number(t.weight) || 5,
			cs: Boolean(t.cs),
		}))
		.filter((t) => t.source);
}

/**
 * 构建单领域包的匹配器（词边界 + 连字符邻接过滤在计数回调里做）
 * @param {{source: string, weight: number}[]} terms
 * @returns {{re: RegExp, weightOf: Map<string, number>}}
 */
function buildPackMatcher(terms) {
	const sorted = [...terms].sort((a, b) => b.source.length - a.source.length);
	const re = new RegExp(
		sorted.map((t) => (isAsciiWord(t.source) ? `\\b${esc(t.source)}\\b` : esc(t.source))).join('|'),
		'gi',
	);
	const weightOf = new Map(sorted.map((t) => [t.source.toLowerCase(), t.weight]));
	return { re, weightOf };
}

/**
 * 单区域打分：返回 Map(小写源词 → 命中次数)
 * 连字符邻接（user-agent 里的 agent）不算独立命中
 */
function countRegion(text, matcher) {
	const hits = new Map();
	if (!text) return hits;
	const str = String(text);
	let m;
	const re = new RegExp(matcher.re.source, 'gi');
	while ((m = re.exec(str)) !== null) {
		if (m.index === re.lastIndex) re.lastIndex++;
		// 连字符邻接过滤
		if (m.index > 0 && /[\w-]/.test(str[m.index - 1])) continue;
		const end = m.index + m[0].length;
		if (end < str.length && /[\w-]/.test(str[end])) continue;
		const key = m[0].toLowerCase();
		hits.set(key, (hits.get(key) || 0) + 1);
	}
	return hits;
}

/**
 * 领域打分
 * @param {{title?: string, description?: string, h1h2?: string, body?: string}} signals 页面信号
 * @param {{id: string, terms: {source: string, weight: number}[]}[]} packs 领域包列表
 * @returns {{id: string, score: number, hits: number, termsHit: number}[]} 按分降序
 */
export function scoreDomains(signals, packs) {
	const regions = [
		['title', signals.title ?? ''],
		['description', signals.description ?? ''],
		['h1h2', signals.h1h2 ?? ''],
		['body', signals.body ?? ''],
	].filter(([, text]) => text);

	const out = [];
	for (const pack of packs) {
		const terms = normalizeTerms(pack.terms);
		if (!terms.length) continue;
		const matcher = buildPackMatcher(terms);
		const perRegionHits = regions.map(([region, text]) => ({ region, hits: countRegion(text, matcher), w: REGION_WEIGHTS[region] ?? 1 }));

		let score = 0;
		let hits = 0;
		const termWeights = new Map();
		for (const { region, hits: h, w } of perRegionHits) {
			for (const [key, count] of h) {
				const weight = matcher.weightOf.get(key) ?? 5;
				score += weight * w * count;
				hits += count;
				termWeights.set(key, weight);
			}
		}
		if (hits > 0) out.push({ id: pack.id, score: Math.round(score * 10) / 10, hits, termsHit: termWeights.size });
	}
	out.sort((a, b) => b.score - a.score || b.termsHit - a.termsHit);
	return out;
}

/**
 * 选包：得分达线且术语命中数达线的领域，最多 3 个
 * @param {{id: string, score: number, termsHit: number}[]} scored
 * @returns {string[]} 选中的领域 id
 */
export function pickDomains(scored) {
	if (!scored.length) return [];
	const top = scored[0];
	const floor = Math.max(4, top.score * 0.35);
	return scored
		.filter((s) => s.score >= floor && s.termsHit >= 2)
		.slice(0, 3)
		.map((s) => s.id);
}

/** 组装信号（扩展各上下文通用）：title / meta description / h1h2 / 正文采样 */
export function collectPageSignals(doc) {
	const d = doc || document;
	const metas = d.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
	const headings = [...d.querySelectorAll('h1, h2')]
		.map((h) => h.textContent.trim())
		.filter(Boolean)
		.slice(0, 30)
		.join(' ');
	const body = (d.body?.innerText || d.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
	return {
		title: (d.title || '').slice(0, 300),
		description: String(metas).slice(0, 300),
		h1h2: headings.slice(0, 2000),
		body,
	};
}
