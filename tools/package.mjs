#!/usr/bin/env node
/**
 * 打包发布包（零依赖）
 *
 * 产出：dist/offline-bilingual-translator-v<version>.zip
 * 包内为可直接「加载已解压的扩展程序」的目录结构（manifest.json 位于 zip 根）。
 *
 * 用法：node tools/package.mjs [--keep-stage]
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, '.build', 'stage');
const DIST = path.join(ROOT, 'dist');
const keepStage = process.argv.includes('--keep-stage');

/** 需要进入发布包的内容（顺序无关） */
const INCLUDE = [
	'manifest.json',
	'_locales',
	'assets',
	'src',
	'vendor',
	'LICENSE',
	'NOTICE',
	'PRIVACY.md',
	'THIRD_PARTY_NOTICES.md',
	'README.md',
];

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} 执行失败（${result.status}）\n${result.stderr || result.stdout || ''}`,
		);
	}
	return result;
}

function formatBytes(bytes) {
	if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

async function main() {
	const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
	const version = manifest.version;
	const zipPath = path.join(DIST, `offline-bilingual-translator-v${version}.zip`);

	// 自检不通过就不打包，避免把坏包发出去
	console.log('· 运行静态自检…');
	run(process.execPath, [path.join(ROOT, 'tools', 'check.mjs')], {
		cwd: ROOT,
		stdio: 'inherit',
	});

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

	console.log('· 压缩…');
	if (process.platform === 'win32') {
		const command = [
			`$ErrorActionPreference = 'Stop'`,
			`Compress-Archive -Path '${path.join(STAGE, '*').replace(/'/g, "''")}' ` +
				`-DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal`,
		].join('; ');
		run('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-Command',
			command,
		]);
	} else {
		run('zip', ['-r', '-q', zipPath, '.'], { cwd: STAGE });
	}

	const info = await stat(zipPath);
	console.log(`\n✓ ${path.relative(ROOT, zipPath)}  (${formatBytes(info.size)})`);

	if (!keepStage) {
		await rm(path.join(ROOT, '.build'), { recursive: true, force: true });
	} else {
		console.log(`  暂存目录保留在 ${path.relative(ROOT, STAGE)}`);
	}

	console.log('  安装：解压后在 chrome://extensions 开启开发者模式 → 加载已解压的扩展程序');
}

main().catch((err) => {
	console.error(`\n✗ 打包失败：${err.message}`);
	process.exit(1);
});
