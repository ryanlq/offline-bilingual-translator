#!/usr/bin/env node
/**
 * 打包发布包（零依赖）
 *
 * 产出：dist/offline-bilingual-translator-v<version>.zip
 * 包内为可直接「加载已解压的扩展程序」的目录结构（manifest.json 位于 zip 根）。
 *
 * 用法：node tools/package.mjs [--keep-stage]
 */

import { cp, mkdir, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
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
	'glossaries',
	'glossaries/dict',
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

/* ---------------- 纯 Node zip 写入（正斜杠路径） ---------------- */

// PowerShell Compress-Archive 会把条目分隔符写成 \，Linux/商店解包即坏；
// 这里用零依赖实现（deflate + UTF-8 文件名），跨平台条目路径统一为 /。
const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

async function collectFiles(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectFiles(full, base)));
		else if (entry.isFile())
			out.push({ full, arc: path.relative(base, full).split(path.sep).join('/') });
	}
	return out;
}

/** 把 stageDir 打成 zipPath（deflate，UTF-8 文件名，/ 分隔） */
async function writeZip(stageDir, zipPath) {
	const files = (await collectFiles(stageDir)).sort((a, b) => a.arc.localeCompare(b.arc));
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const file of files) {
		const data = await readFile(file.full);
		const deflated = deflateRawSync(data, { level: 9 });
		const nameBuf = Buffer.from(file.arc, 'utf8');
		const crc = crc32(data);
		const stats = await stat(file.full);
		const dosTime =
			((stats.mtime.getHours() << 11) |
			(stats.mtime.getMinutes() << 5) |
			(stats.mtime.getSeconds() >> 1)) &
			0xffff;
		const dosDate =
			(((stats.mtime.getFullYear() - 1980) << 9) |
				((stats.mtime.getMonth() + 1) << 5) |
				stats.mtime.getDate()) &
			0xffff;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 名称
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(deflated.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, nameBuf, deflated);

		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(0x031e, 4); // made by: unix
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0x0800, 8);
		cd.writeUInt16LE(8, 10);
		cd.writeUInt16LE(dosTime, 12);
		cd.writeUInt16LE(dosDate, 14);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(deflated.length, 20);
		cd.writeUInt32LE(data.length, 24);
		cd.writeUInt16LE(nameBuf.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([cd, nameBuf]));

		offset += local.length + nameBuf.length + deflated.length;
	}

	const cdBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(cdBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);

	await writeFile(zipPath, Buffer.concat([...chunks, cdBuf, eocd]));
	return files.length;
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
	const entryCount = await writeZip(STAGE, zipPath);
	console.log(`  ${entryCount} 个条目（正斜杠路径）`);

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
