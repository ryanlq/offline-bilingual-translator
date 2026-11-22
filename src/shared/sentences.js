/**
 * 句子切分（纯函数，无运行环境依赖；reader 视图与 node 测试共用）
 *
 * 规则：
 * - 句末标点（.!?。！？；）+ 可选闭合引号/括号后为边界
 * - 边界后望（跳过空白）：大写字母/CJK/开引号开括号才切——
 *   「point.Drop it」无空格也切；「3.5」「drop it」（数字/小写续句）不切
 * - 单字母缩写保护：`.` 前是单个字母（J. / U.）不切
 * - 输出保证标签平衡：跨句的行内标签在句尾闭合、下句句首重开
 */

const CARRY_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'span', 'small', 'sub', 'sup', 'abbr', 'a', 'code']);
const TERMINATOR = /[.!?。！？；]/;
const CLOSER = /["')\]」』"]/;
const NEXT_STARTS_NEW = /[A-Z\u4e00-\u9fff"'「【(]/;

/** 对一段纯文本做句边界切分（返回子串数组；最后一段可能无句末标点） */
function splitTextPiece(text) {
	if (!TERMINATOR.test(text)) return [text];
	const out = [];
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!TERMINATOR.test(ch)) continue;

		// 吸收紧随的闭合引号/括号
		let end = i + 1;
		while (end < text.length && CLOSER.test(text[end])) end++;
		if (end >= text.length) break; // 标点收尾且后面没有内容：不再产生边界

		// 后望（跳过空白）：下一个可见字符要像「新句子开头」
		let j = end;
		while (j < text.length && /\s/.test(text[j])) j++;
		if (j >= text.length) break;
		if (!NEXT_STARTS_NEW.test(text[j])) {
			i = end - 1; // 数字/小写/符号续句：不切（循环 i++ 会跳过这一段）
			continue;
		}

		// 单字母缩写保护：`.` 前是单个字母且更前面不是字母（J. / U. 不切）
		if (ch === '.' && /[A-Za-z]/.test(text[i - 1] ?? '') && !/[A-Za-z]/.test(text[i - 2] ?? '')) {
			i = end - 1;
			continue;
		}

		out.push(text.slice(start, end));
		start = end;
		i = end - 1;
	}
	out.push(text.slice(start));
	return out;
}

/**
 * 把白名单内联 HTML 片段切成标签平衡的句子数组。
 * @param {string} html
 * @returns {string[]}
 */
export function splitSentences(html) {
	const pieces = html.match(/<[^>]+>|[^<]+/g) ?? [];
	const chunks = [];
	let cur = [];
	let openStack = [];

	const flush = () => {
		if (!cur.length) return;
		const open = openStack.map((t) => `<${t}>`).join('');
		const close = openStack
			.slice()
			.reverse()
			.map((t) => `</${t}>`)
			.join('');
		chunks.push(open + cur.join('') + close);
		cur = [];
	};

	for (const piece of pieces) {
		if (piece.startsWith('<')) {
			const m = /^<\s*(\/?)\s*([a-z]+)/i.exec(piece);
			const tag = m?.[2]?.toLowerCase();
			if (tag && CARRY_TAGS.has(tag)) {
				if (m[1]) openStack = openStack.filter((t) => t !== tag);
				else if (!openStack.includes(tag)) openStack.push(tag);
			}
			cur.push(piece);
			continue;
		}

		// 文本片段：句边界切分；最后一段与后续内容同句，边界处才闭合
		const parts = splitTextPiece(piece);
		for (let i = 0; i < parts.length; i++) {
			cur.push(parts[i]);
			if (i < parts.length - 1) flush();
		}
	}
	flush();
	return chunks.filter((c) => c.replace(/<[^>]*>/g, '').trim().length > 0);
}
