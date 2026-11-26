/**
 * 术语表匹配与强制管线（纯函数，无运行环境依赖；offscreen 与 node 测试共用）
 *
 * Bergamot WASM 无原生术语表接口（ResponseOptions 只有 quality/alignment/HTML 等），
 * 术语强制在 JS 层实现：
 *   1. 命中术语 → 替换为保护 token（NMT 对 OOV ASCII 串通常原样拷贝）
 *   2. 翻译后按 token 回贴目标词
 *   3. 回贴缺失（token 被 NMT 吞掉/改写）→ 调用方降级为分段拼接
 *
 * HTML 感知：替换只作用于文本部分，标签与其属性不动。
 */

/** 保护 token：构造/还原。ASCII 串，NMT subword 模型对 OOV 一般原样拷贝 */
export const TOKEN_PREFIX = 'ZGQ';
export const TOKEN_SUFFIX = 'QGZ';

export function tokenFor(index) {
	return `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
}

export function tokenRegex() {
	return new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g');
}

/** 元字符转义 */
function esc(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 纯 ASCII 词（可加 \b 边界） */
function isAsciiWord(s) {
	return /^[\w][\w\s.-]*$/.test(s);
}

/**
 * 构建匹配器
 * @param {{source: string, target: string}[]} terms
 * @returns {{re: RegExp, map: Map<string, string>}|null} 无术语时返回 null
 */
export function buildMatcher(terms) {
	if (!Array.isArray(terms) || terms.length === 0) return null;
	const cleaned = terms
		.filter((t) => t && typeof t.source === 'string' && typeof t.target === 'string' && t.source.trim() && t.target.trim())
		.map((t) => ({ source: t.source.trim(), target: t.target.trim() }));
	if (!cleaned.length) return null;
	// 长词优先（避免短词遮蔽长词的命中）
	const sorted = [...cleaned].sort((a, b) => b.source.length - a.source.length);
	const pattern = sorted
		.map((t) => (isAsciiWord(t.source) ? `\\b${esc(t.source)}\\b` : esc(t.source)))
		.join('|');
	return {
		re: new RegExp(pattern, 'gi'),
		map: new Map(sorted.map((t) => [t.source.toLowerCase(), t.target])),
	};
}

/**
 * HTML 感知替换：只替换标签外的文本部分
 * @param {string} html
 * @param {{re: RegExp, map: Map<string,string>}} matcher
 * @returns {string} 替换后的 html
 */
export function substituteHtml(html, matcher) {
	if (!matcher) return html;
	return html
		.split(/(<[^>]*>)/)
		.map((part, i) => {
			if (i % 2 === 1) return part; // 标签段
			return part.replace(matcher.re, (m) => {
				const index = [...matcher.map.keys()].indexOf(m.toLowerCase());
				return tokenFor(index);
			});
		})
		.join('');
}

/**
 * 回贴：token → 目标词。返回 {text, missing}，missing 为未恢复的 token 数
 * @param {string} text
 * @param {Map<string,string>} map（插入序即 token 序）
 * @returns {{text: string, missing: number}}
 */
export function restoreTokens(text, map) {
	const targets = [...map.values()];
	let missing = 0;
	const out = text.replace(tokenRegex(), (m, idx) => {
		const target = targets[Number(idx)];
		if (target === undefined) {
			missing++;
			return m;
		}
		return target;
	});
	return { text: out, missing };
}

/** 检查文本中是否还有未回贴的 token */
export function hasLeftoverTokens(text) {
	tokenRegex().lastIndex = 0;
	return tokenRegex().test(text);
}

/**
 * 按术语把 HTML 切成交替段：[文本, 术语, 文本, 术语, ..., 文本]
 * （术语位置直接放目标词，文本段交由调用方翻译后原序拼接）
 * @param {string} html
 * @param {{re: RegExp, map: Map<string,string>}} matcher
 * @returns {{plain: string, term: string|null}[]}
 */
export function splitByTerms(html, matcher) {
	const parts = [];
	let last = 0;
	const input = html;
	matchAll(matcher.re, input, (m) => {
		if (m.index > last) parts.push({ plain: input.slice(last, m.index), term: null });
		parts.push({ plain: '', term: matcher.map.get(m[0].toLowerCase()) });
		last = m.index + m[0].length;
	});
	if (last < input.length) parts.push({ plain: input.slice(last), term: null });
	return parts.length ? parts : [{ plain: html, term: null }];
}

function matchAll(re, input, cb) {
	const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
	let m;
	while ((m = rx.exec(input)) !== null) {
		cb(m);
		if (m.index === rx.lastIndex) rx.lastIndex++;
	}
}

/**
 * CSV 解析（source,target 每行一条；支持引号包裹）
 * @param {string} csv
 * @returns {{source: string, target: string}[]}
 */
export function parseCsv(csv) {
	const out = [];
	for (const lineRaw of String(csv).split(/\r?\n/)) {
		const line = lineRaw.trim();
		if (!line || line.startsWith('#')) continue;
		const cells = [];
		let cur = '';
		let inQuote = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inQuote) {
				if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
				else if (ch === '"') inQuote = false;
				else cur += ch;
			} else if (ch === '"') {
				inQuote = true;
			} else if (ch === ',' || ch === '\t') {
				cells.push(cur);
				cur = '';
			} else {
				cur += ch;
			}
		}
		cells.push(cur);
		if (cells.length >= 2 && cells[0].trim() && cells[1].trim()) {
			out.push({ source: cells[0].trim(), target: cells[1].trim() });
		}
	}
	return out;
}

/** 序列化为 CSV */
export function toCsv(entries) {
	const cell = (s) => (/[",\n\t]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
	return entries.map((e) => `${cell(e.source)},${cell(e.target)}`).join('\n');
}
