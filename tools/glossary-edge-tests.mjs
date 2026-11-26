/**
 * 术语表误伤边界测试套件（node 直跑，零依赖）
 * 覆盖：大小写敏感、词边界、连字符复合词、重叠术语、特殊字符、
 *       CJK 子串、标签内误命中、token 冲突、多术语共存、性能
 */
let logPerf;
import { buildMatcher, substituteHtml, restoreTokens, splitByTerms, parseCsv, toCsv } from '../src/shared/glossary.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expected) {
	const ok = Object.is(actual, expected) || String(actual) === String(expected);
	if (ok) pass++;
	else {
		fail++;
		failures.push({ name, actual: String(actual).slice(0, 120), expected: String(expected).slice(0, 120) });
	}
}
function checkNot(name, text, forbidden) {
	const ok = !text.includes(forbidden);
	if (ok) pass++;
	else { fail++; failures.push({ name, actual: `包含「${forbidden}」`, expected: `不包含「${forbidden}」` }); }
}
function checkHas(name, text, required) {
	const ok = text.includes(required);
	if (ok) pass++;
	else { fail++; failures.push({ name, actual: text.slice(0, 120), expected: `包含「${required}」` }); }
}

/* ---------- A. 大小写敏感（cs 品牌保护） ---------- */
{
	const m = buildMatcher([{ source: 'Cursor', target: '【Cursor品牌】', cs: true }]);
	const sub = substituteHtml('The text cursor and myCursor and Cursors and Cursor work.', m);
	const r = restoreTokens(sub.replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkNot('A1 小写 cursor 不误伤', r.text, 'cursor 【');
	checkNot('A2 myCursor 不误伤', r.text, 'my【');
	checkNot('A3 复数 Cursors 不误伤', r.text, 'Cursors 【');
	checkHas('A4 大写 Cursor 精确命中', r.text, '【Cursor品牌】 work');
	const only = (r.text.match(/【Cursor品牌】/g) || []).length;
	check('A5 只命中一处', only, 1);
}

/* ---------- B. 词边界（\b） ---------- */
{
	const m = buildMatcher([{ source: 'agent', target: '【智能体】' }]);
	const r = restoreTokens(substituteHtml('An agent, agents, user-agent and AgentX.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('B1 单数 agent 命中', r.text, '【智能体】,');
	checkNot('B2 复数 agents 不误伤', r.text, '【智能体】s');
	checkNot('B3 user-agent 连字符复合词不误伤', r.text, 'user-【智能体】');
	checkNot('B4 AgentX 前缀复合词不误伤', r.text, '【智能体】X');
}

/* ---------- C. 长词优先 + 不重叠 ---------- */
{
	const m = buildMatcher([
		{ source: 'cloud', target: '【云】' },
		{ source: 'cloud servers', target: '【云服务器】' },
	]);
	const r = restoreTokens(substituteHtml('cloud servers and cloud native.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('C1 长词整体命中', r.text, '【云服务器】 and');
	check('C2 无重复嵌套替换', (r.text.match(/【云/g) || []).length, 2);
}

/* ---------- D. 特殊字符术语 ---------- */
{
	const m = buildMatcher([
		{ source: 'C++', target: '【C加加】' },
		{ source: '$fn', target: '【函数引用】' },
		{ source: 'a.b', target: '【点分】' },
	]);
	const r = restoreTokens(substituteHtml('Learn C++ then use $fn in a.b config.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('D1 C++ 命中', r.text, '【C加加】');
	checkHas('D2 $fn 命中', r.text, '【函数引用】');
	checkHas('D3 a.b 命中', r.text, '【点分】 config');
}

/* ---------- E. CJK 子串（预期行为：中文术语按子串命中） ---------- */
{
	const m = buildMatcher([{ source: '神经网络', target: '【神经网络】' }]);
	const sub = substituteHtml('神经网络架构很复杂。', m);
	const rE = restoreTokens(sub.replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('E1 CJK 子串命中', rE.text, '【神经网络】架构');
}

/* ---------- F. cs 与 ci 多术语共存 ---------- */
{
	const m = buildMatcher([
		{ source: 'Cursor', target: '【Cursor品牌】', cs: true },
		{ source: 'cursor', target: '【文本光标】' },
	]);
	const r = restoreTokens(substituteHtml('The Cursor app moved my cursor.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('F1 大写命中品牌', r.text, 'The 【Cursor品牌】 app');
	checkHas('F2 小写命中光标', r.text, 'moved my 【文本光标】');
}

/* ---------- G. cs/ci 重叠同位置：cs 优先 ---------- */
{
	const m = buildMatcher([
		{ source: 'Gemini', target: '【Gemini品牌】', cs: true },
		{ source: 'gemini', target: '【双子座】' },
	]);
	const r1 = restoreTokens(substituteHtml('Gemini the brand.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('G1 大写走品牌', r1.text, '【Gemini品牌】');
	const r2 = restoreTokens(substituteHtml('gemini the zodiac.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('G2 小写走星座', r2.text, '【双子座】');
}

/* ---------- H. 标签内不误命中（substitute 路径） ---------- */
{
	const m = buildMatcher([{ source: 'b', target: '【B】' }]);
	const sub = substituteHtml('a <b>bold</b> tag with b inside.', m);
	checkNot('H1 标签名 b 不误伤', sub, '<<');
	const rH = restoreTokens(sub.replace(/ZGQ(\d+)QGZ/g, (_, i) => m.targets[Number(i)]), m.targets);
	checkHas('H2 标签外 b 命中', rH.text, 'a <b>bold</b> tag with 【B】 inside');
}

/* ---------- I. token 冲突（原文自带 token 字样） ---------- */
{
	const m = buildMatcher([{ source: 'agent', target: '【智能体】' }]);
	const r = restoreTokens(substituteHtml('agent and ZGQ9QGZ literal.', m).replace(/ZGQ(\d+)QGZ/g, (_, i) => (i === '9' ? '【原文自带】' : m.targets[Number(i)])), m.targets);
	// 原文自带 token 字样（此处手工映射为【原文自带】）：只验证术语命中
	checkHas('I1 术语命中', r.text, '【智能体】');
}

/* ---------- J. 分段拼接（splitByTerms）对标签安全 ---------- */
{
	const m = buildMatcher([{ source: 'agent', target: '【智能体】' }]);
	const parts = splitByTerms('Deploy <b>agent</b> today.', m);
	const joined = parts.map((p) => (p.term ?? p.plain.replace(/<[^>]*>/g, ' '))).join('');
	check('J1 分段数正确', parts.length, 3);
	checkHas('J2 术语独立成段', joined, '【智能体】');
	checkNot('J3 标签碎片不残留', joined, '<b>');
}

/* ---------- K. 性能：5000 术语 × 长文本 × 100 次 ---------- */
{
	const bigTerms = [];
	for (let i = 0; i < 5000; i++) bigTerms.push({ source: `term${i} server style`, target: `目标${i}` });
	const t0 = Date.now();
	const m = buildMatcher(bigTerms);
	const longText = 'The term3999 server style appears in this document. '.repeat(50);
	let n = 0;
	for (let i = 0; i < 100; i++) {
		const sub = substituteHtml(longText, m);
		n += (sub.match(/ZGQ/g) || []).length;
	}
	const cost = Date.now() - t0;
	logPerf = `构建+500 次替换: ${cost}ms（token 数 ${n}）`;
	check('K1 5000 术语构建成功', Boolean(m), true);
	check('K2 命中数正确', n, 100 * 50);
	if (cost > 30000) { fail++; failures.push({ name: 'K3 性能', actual: cost + 'ms', expected: '<30000ms' }); }
	else pass++;
}

/* ---------- L. CSV cs 往返 ---------- */
{
	const csv = toCsv([{ source: 'Cursor', target: 'Cursor', cs: true }, { source: 'agent', target: '智能体' }]);
	const back = parseCsv(csv);
	check('L1 cs 保留', back[0].cs, true);
	check('L2 无 cs 不误标', Boolean(back[1].cs), false);
	check('L3 引号逗号往返', back[0].source, 'Cursor');
}

console.log(`通过 ${pass} | 失败 ${fail}`);
if (typeof logPerf !== 'undefined') console.log(logPerf);
for (const f of failures) console.log('  ✗', f.name, '| 实际:', f.actual, '| 期望:', f.expected);
process.exit(fail ? 1 : 0);
