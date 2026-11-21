#!/usr/bin/env node
/**
 * 扩展静态自检（零依赖）
 *
 * 覆盖那些「Chrome 加载时才报错、或运行到一半才炸」的问题：
 *   1. manifest.json 可解析，且其中引用的每个文件真实存在
 *   2. 所有 src 下的 JS 语法合法（ES module 语法解析）
 *   3. 相对 import 路径可解析
 *   4. manifest 中的 __MSG_*__ 在默认语言包中都有定义，且各语言 key 一致
 *   5. CSS/脚本对 host_permissions 的覆盖：模型与 OCR 用到的域名都在权限内
 *   6. closed Shadow DOM 场景不得通过 element.shadowRoot 访问
 *      （attachShadow({mode:'closed'}) 后该属性恒为 null，曾导致注入层整体崩溃）
 *   7. content_scripts 声明的顺序与文件存在性
 *   8. 商店包校验字段长度：short_name ≤12 字符、name ≤75 字符（逐 locale，按字符数）
 *
 * 用法：node tools/check.mjs [--verbose]
 * 退出码：0 全部通过；1 存在问题
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const problems = [];
const passes = [];

function ok(message) {
	passes.push(message);
	if (verbose) console.log(`  ✓ ${message}`);
}

function fail(message, detail) {
	problems.push({ message, detail });
	console.log(`  ✗ ${message}`);
	if (detail) console.log(`    ${detail}`);
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function walk(dir, exts, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			await walk(full, exts, out);
		} else if (exts.some((ext) => entry.name.endsWith(ext))) {
			out.push(full);
		}
	}
	return out;
}

/* ---------------- 1. manifest ---------------- */

let manifest;
const manifestPath = path.join(ROOT, 'manifest.json');

try {
	manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	ok('manifest.json 可解析');
} catch (err) {
	fail('manifest.json 解析失败', err.message);
	process.exit(1);
}

const referenced = new Set();

function collectPaths(value) {
	if (typeof value === 'string') {
		if (/\.(js|html|png|json|wasm)$/.test(value) && !value.startsWith('__MSG_')) {
			referenced.add(value.replace(/^\/+/, ''));
		}
	} else if (Array.isArray(value)) {
		value.forEach(collectPaths);
	} else if (value && typeof value === 'object') {
		Object.values(value).forEach(collectPaths);
	}
}
collectPaths(manifest);

for (const file of referenced) {
	if (file.includes('*')) continue;
	if (!(await exists(path.join(ROOT, file)))) fail(`manifest 引用的文件缺失: ${file}`);
}
if (!problems.length) ok(`manifest 引用的 ${referenced.size} 个文件均存在`);

// web_accessible_resources 的 glob 至少要能匹配到文件
for (const entry of manifest.web_accessible_resources ?? []) {
	for (const pattern of entry.resources ?? []) {
		const dir = pattern.split('*')[0].replace(/\/$/, '');
		if (dir && !(await exists(path.join(ROOT, dir)))) {
			fail(`web_accessible_resources 目录不存在: ${pattern}`);
		}
	}
}
ok('web_accessible_resources 路径有效');

/* ---------------- 2/3. JS 语法与 import ---------------- */

const jsFiles = await walk(path.join(ROOT, 'src'), ['.js']);
const importRe = /(?:^|[^\w$])(?:import\s+[^'"]*?from\s*|import\s*|export\s+[^'"]*?from\s*)['"]([^'"]+)['"]/g;

for (const file of jsFiles) {
	const source = await readFile(file, 'utf8');

	const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
		input: source,
		encoding: 'utf8',
	});
	if (syntax.status !== 0) {
		const firstLine = (syntax.stderr || '').split('\n').find((l) => l.trim());
		fail(`语法错误: ${rel(file)}`, firstLine);
	}

	for (const match of source.matchAll(importRe)) {
		const spec = match[1];
		if (!spec.startsWith('.')) continue;
		const target = path.resolve(path.dirname(file), spec);
		if (!(await exists(target))) {
			fail(`import 路径无法解析: ${rel(file)} → ${spec}`);
		}
	}
}
ok(`检查 ${jsFiles.length} 个 JS 文件的语法与相对 import`);

/* ---------------- 4. 本地化 ---------------- */

const localesDir = path.join(ROOT, '_locales');
const defaultLocale = manifest.default_locale;
const localeKeys = new Map();
const localeMessages = new Map();

for (const locale of await readdir(localesDir, { withFileTypes: true })) {
	if (!locale.isDirectory()) continue;
	const file = path.join(localesDir, locale.name, 'messages.json');
	if (!(await exists(file))) {
		fail(`语言包缺少 messages.json: ${locale.name}`);
		continue;
	}
	const messages = JSON.parse(await readFile(file, 'utf8'));
	localeKeys.set(locale.name, new Set(Object.keys(messages)));
	localeMessages.set(locale.name, messages);
}

const defaultKeys = localeKeys.get(defaultLocale);
if (!defaultKeys) {
	fail(`default_locale 指向的语言包不存在: ${defaultLocale}`);
} else {
	const usedKeys = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map(
		(m) => m[1],
	);
	for (const key of usedKeys) {
		if (!defaultKeys.has(key)) fail(`manifest 使用了未定义的文案 key: ${key}`);
		for (const [locale, keys] of localeKeys) {
			if (!keys.has(key)) fail(`语言包 ${locale} 缺少文案 key: ${key}`);
		}
	}
	for (const [locale, keys] of localeKeys) {
		for (const key of defaultKeys) {
			if (!keys.has(key)) fail(`语言包 ${locale} 缺少 key: ${key}`);
		}
	}
	if (usedKeys.length) ok(`manifest 的 ${usedKeys.length} 个 __MSG_*__ 文案在各语言包中齐全`);
}

/* ---------------- 4b. 商店文案长度限制 ---------------- */

// Chrome Web Store / Edge Add-ons 上传时会逐 locale 校验包内字段：
// short_name 最多 12 个字符、name 最多 75 个字符，按字符数而非字节数。
// 例：en 的 "Offline Translator"(17) 会触发
//   "The translation for field ShortName in locale en is too long ... limit of 12 characters"
const storeFieldLimits = [
	{ field: 'short_name', value: manifest.short_name, max: 12 },
	{ field: 'name', value: manifest.name, max: 75 },
];

const beforeLimits = problems.length;
let checkedValues = 0;

for (const { field, value, max } of storeFieldLimits) {
	const key = /^__MSG_([A-Za-z0-9_]+)__$/.exec(value ?? '')?.[1];
	if (key) {
		for (const [locale, messages] of localeMessages) {
			const text = messages[key]?.message;
			if (typeof text !== 'string') continue; // 缺 key 已在第 4 项报错
			checkedValues++;
			const length = [...text].length;
			if (length > max) fail(`${field} 在 ${locale} 超长: "${text}" (${length} > ${max} 字符)`);
		}
	} else if (typeof value === 'string') {
		checkedValues++;
		const length = [...value].length;
		if (length > max) fail(`${field} 超长: "${value}" (${length} > ${max} 字符)`);
	}
}
if (problems.length === beforeLimits) {
	ok(`商店字段长度合规：${checkedValues} 个翻译值（short_name ≤12、name ≤75 字符）`);
}

/* ---------------- 5. host_permissions 覆盖 ---------------- */

const hostPermissions = manifest.host_permissions ?? [];
const registrySource = await readFile(
	path.join(ROOT, 'src/shared/models-registry.js'),
	'utf8',
);
const remoteHosts = new Set(
	[...registrySource.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]),
);

for (const host of remoteHosts) {
	const covered = hostPermissions.some((pattern) => {
		const cleaned = pattern.replace(/^https:\/\//, '').replace(/\/\*$/, '');
		return cleaned === host;
	});
	if (!covered) fail(`模型/OCR 域名不在 host_permissions 中: ${host}`);
}
if (remoteHosts.size) ok(`host_permissions 覆盖 ${remoteHosts.size} 个远程域名`);

/* ---------------- 6. closed Shadow DOM 回归检查 ---------------- */

let closedShadowHits = 0;
for (const file of jsFiles) {
	const source = await readFile(file, 'utf8');
	if (!/attachShadow\(\s*\{\s*mode:\s*['"]closed['"]/.test(source)) continue;
	closedShadowHits++;
	// 允许通过保存的引用访问（本文件内 const root = attachShadow(...) 或 this.shadowRoot 字段）；
	// 禁止在 DOM 节点上读 .shadowRoot —— closed 模式下它恒为 null
	const lines = source.split('\n');
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
		// 只检查 <节点>.shadowRoot 形式（this.shadowRoot 是自持引用的字段）
		for (const match of line.matchAll(/([A-Za-z_$][\w$]*)\.shadowRoot\b/g)) {
			if (match[1] === 'this') continue;
			fail(
				`closed shadow 上访问 .shadowRoot（恒为 null）: ${rel(file)}:${index + 1}`,
				trimmed,
			);
		}
	});
}
ok(`检查 ${closedShadowHits} 处 closed Shadow DOM 用法`);

/* ---------------- 7. content_scripts ---------------- */

for (const entry of manifest.content_scripts ?? []) {
	for (const file of entry.js ?? []) {
		if (!(await exists(path.join(ROOT, file)))) fail(`content_scripts 文件缺失: ${file}`);
	}
	if (entry.js?.[0] !== 'src/content/shared.js') {
		fail('content_scripts 首个脚本应为 src/content/shared.js（其余模块依赖 self.OBT）');
	}
}
ok('content_scripts 声明有效');

/* ---------------- 8. vendor JS 语法完整性 ---------------- */

/* AMO linter 会解析包内全部 JS（含 vendored 库）；任何截断/损坏文件都会直接拒绝。
   曾发生过 tesseract-core.wasm.js 下载中断截断（字符串未闭合）而本机 OCR 走
   SIMD 变体从未暴露——这里用 node --check 把 vendor 与 src 的所有 JS 全部过一遍。 */
{
	const allJs = [
		...(await walk(path.join(ROOT, 'vendor'), ['.js'])),
		...(await walk(path.join(ROOT, 'src'), ['.js'])),
	];
	let checked = 0;
	for (const file of allJs) {
		const r = spawnSync(process.execPath, ['--check', file], { timeout: 60000 });
		if (r.status !== 0) {
			fail(
				`JS 语法错误: ${rel(file)}\n${r.stderr.toString('utf8', 0, 300)}`, null,
			);
			problems.push(`JS 语法错误: ${rel(file)}`);
		}
		checked++;
	}
	if (!problems.some((p) => p.startsWith('JS 语法错误')))
		ok(`vendor/src 全部 ${checked} 个 JS 语法完整（node --check）`);
}

/* ---------------- 汇总 ---------------- */

console.log('');
if (problems.length) {
	console.log(`自检未通过：${problems.length} 个问题，${passes.length} 项通过`);
	process.exit(1);
}
console.log(`自检通过：${passes.length} 项全部正常`);
