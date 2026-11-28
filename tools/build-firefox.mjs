#!/usr/bin/env node
/**
 * Firefox 版打包（MV2）
 *
 * 与 Chrome 版的差异：
 * - manifest 来自 manifest.firefox.json（MV2：browser_action / background.page /
 *   MV2 权限数组含 host 匹配模式 / MV2 格式 web_accessible_resources）
 * - 后台为持久页 background.html（自带 DOM，引擎同上下文直调，无 offscreen）
 * - 无 declarativeNetRequest 权限（UA 改写规则仅 Chrome 需要）
 *
 * 产出：dist/offline-bilingual-translator-firefox-v<version>.zip
 * 上传 AMO 时可直接改名 .xpi；本地临时加载亦可直接用 zip。
 *
 * 用法：node tools/build-firefox.mjs [--keep-stage]
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, '.build', 'firefox-stage');
const DIST = path.join(ROOT, 'dist');
const keepStage = process.argv.includes('--keep-stage');

/** 进入发布包的内容（与 Chrome 版一致，manifest 单独处理） */
const INCLUDE = [
	'_locales',
	'assets',
	'src',
	'glossaries',
	'glossaries/dict',
	'vendor',
	'LICENSE',
	'NOTICE',
	'PRIVACY.md',
	'THIRD_PARTY_NOTICES.md',
	'README.md',
];

function formatBytes(bytes) {
	if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

async function main() {
	const ffManifest = JSON.parse(
		await readFile(path.join(ROOT, 'manifest.firefox.json'), 'utf8'),
	);
	const chromeManifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
	const version = ffManifest.version;

	if (version !== chromeManifest.version) {
		throw new Error(
			`版本不一致：manifest.firefox.json(${version}) vs manifest.json(${chromeManifest.version})`,
		);
	}

	const problems = [];
	// MV2 关键结构自检
	if (ffManifest.manifest_version !== 2) problems.push('manifest_version 必须为 2');
	if (!ffManifest.background?.page) problems.push('缺少 background.page');
	if (ffManifest.background?.scripts) problems.push('MV2 不支持 background.scripts');
	if (ffManifest.background?.service_worker) problems.push('MV2 不支持 service_worker');
	if (ffManifest.permissions?.includes('offscreen')) problems.push('Firefox 无 offscreen 权限');
	if (ffManifest.permissions?.includes('declarativeNetRequest'))
		problems.push('Firefox 版已跳过 DNR，不应声明该权限');
	if (!ffManifest.browser_specific_settings?.gecko?.id)
		problems.push('缺少 browser_specific_settings.gecko.id');
	if (!ffManifest.browser_specific_settings?.gecko?.strict_min_version)
		problems.push('缺少 strict_min_version');
	if (ffManifest.host_permissions)
		problems.push('MV2 的 host 权限应并入 permissions 数组');
	if (problems.length) throw new Error('manifest.firefox.json 自检失败：\n- ' + problems.join('\n- '));

	const zipPath = path.join(DIST, `offline-bilingual-translator-firefox-v${version}.zip`);

	console.log('· 准备打包目录…');
	await rm(STAGE, { recursive: true, force: true });
	await mkdir(STAGE, { recursive: true });
	await mkdir(DIST, { recursive: true });
	await rm(zipPath, { force: true });

	for (const item of INCLUDE) {
		const source = path.join(ROOT, item);
		try {
			await stat(source);
		} catch {
			console.warn(`  ! 跳过不存在的条目: ${item}`);
			continue;
		}
		await cp(source, path.join(STAGE, item), { recursive: true });
	}
	await cp(
		path.join(ROOT, 'manifest.firefox.json'),
		path.join(STAGE, 'manifest.json'),
	);

	// 引用完整性：manifest 引用的关键文件在 stage 内必须存在
	const mustExist = [
		ffManifest.background.page,
		'src/background/firefox-entry.js',
		'src/workers/bergamot-worker.js',
		...ffManifest.content_scripts.flatMap((cs) => cs.js),
		ffManifest.options_ui.page,
		ffManifest.browser_action.default_popup,
		...Object.values(ffManifest.icons),
	];
	for (const rel of mustExist) {
		try {
			await stat(path.join(STAGE, rel));
		} catch {
			throw new Error(`stage 中缺少 manifest 引用的文件: ${rel}`);
		}
	}
	// web_accessible_resources 通配符至少命中一个文件
	for (const pattern of ffManifest.web_accessible_resources || []) {
		const prefix = pattern.replace(/\*.*$/, '');
		try {
			await stat(path.join(STAGE, prefix));
		} catch {
			throw new Error(`web_accessible_resources 前缀无匹配文件: ${pattern}`);
		}
	}

	console.log('· 压缩…');
	const entryCount = await writeZip(STAGE, zipPath);
	console.log(`  ${entryCount} 个条目（正斜杠路径）`);

	const info = await stat(zipPath);
	console.log(`\n✓ ${path.relative(ROOT, zipPath)}  (${formatBytes(info.size)})`);

	if (!keepStage) {
		await rm(path.join(ROOT, '.build'), { recursive: true, force: true });
	} else {
		console.log(`  暂存目录保留在 ${path.relative(ROOT, STAGE)}`);
	}

	console.log('  安装：Firefox about:debugging → 临时载入附加组件 → 选择 zip；');
	console.log('  或 AMO 提交：将 zip 改名 .xpi 上传（签名字段由 AMO 处理）。');
}

main().catch((err) => {
	console.error(`\n✗ Firefox 打包失败：${err.message}`);
	process.exit(1);
});
