/**
 * 纯 Node zip 写入（零依赖）。
 *
 * PowerShell Compress-Archive 会把条目分隔符写成 \，Linux/商店解包即坏；
 * 这里用 deflate + UTF-8 文件名自行实现，跨平台条目路径统一为 /。
 */

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

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

/** 把 stageDir 打成 zipPath（deflate，UTF-8 文件名，/ 分隔）。返回条目数。 */
export async function writeZip(stageDir, zipPath) {
	const { writeFile, stat } = await import('node:fs/promises');
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
