/**
 * 最小 ZIP + NumPy .npy 读取器（用于 TTS 音色包 voices_*.npz）。
 * 支持存储与 deflate 两种条目（deflate 走 DecompressionStream('deflate-raw')）。
 * 仅实现本场景需要的子集：无加密、无分卷、数据描述符不使用。
 */

const EOCD = 0x06054b50;
const CDEntry = 0x02014b50;

async function inflateRaw(data) {
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseNpy(bytes) {
	const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
	for (let i = 0; i < 6; i++) {
		if (bytes[i] !== magic[i]) throw new Error('不是有效的 .npy 文件');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const major = bytes[6];
	const headerLen = major >= 2 ? view.getUint32(8, true) : view.getUint16(8, true);
	const headerOffset = major >= 2 ? 12 : 10;
	const header = new TextDecoder().decode(bytes.subarray(headerOffset, headerOffset + headerLen)).trim();
	const descr = header.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
	const shapeM = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
	if (!descr || !shapeM) throw new Error(`无法解析 .npy 头部: ${header.slice(0, 80)}`);
	const shape = shapeM[1].trim() === '' ? [1] : shapeM[1].replace(' ', '').split(',').filter(Boolean).map(Number);
	const fortran = /'fortran_order'\s*:\s*True/.test(header);
	const dataOffset = headerOffset + headerLen;
	let data = bytes.subarray(dataOffset);
	const dtype = descr.replace(/[<>|=]/, '');
	switch (dtype) {
		case 'f4': data = new Float32Array(data.slice().buffer); break;
		case 'f8': {
			const f64 = new Float64Array(data.slice().buffer);
			data = new Float32Array(f64);
			break;
		}
		case 'i8': {
			const i64 = new BigInt64Array(data.slice().buffer);
			data = new Float32Array(i64.length);
			for (let i = 0; i < i64.length; i++) data[i] = Number(i64[i]);
			break;
		}
		default: throw new Error(`不支持的 .npy dtype: ${descr}`);
	}
	if (fortran && shape.length === 2) {
		const [rows, cols] = shape;
		const cOrder = new Float32Array(rows * cols);
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) cOrder[r * cols + c] = data[c * rows + r];
		}
		data = cOrder;
	}
	return { data, shape };
}

export async function loadNpz(buffer) {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0; i--) {
		if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
	}
	if (eocd === -1) throw new Error('不是有效的 ZIP（找不到 EOCD）');
	const count = view.getUint16(eocd + 10, true);
	let offset = view.getUint32(eocd + 16, true);
	const result = {};
	for (let n = 0; n < count; n++) {
		if (view.getUint32(offset, true) !== CDEntry) break;
		const method = view.getUint16(offset + 10, true);
		const compSize = view.getUint32(offset + 20, true);
		const nameLen = view.getUint16(offset + 28, true);
		const extraLen = view.getUint16(offset + 30, true);
		const commentLen = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
		offset += 46 + nameLen + extraLen + commentLen;
		if (!name.endsWith('.npy')) continue;
		const lhNameLen = view.getUint16(localOffset + 26, true);
		const lhExtraLen = view.getUint16(localOffset + 28, true);
		const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
		let data = bytes.subarray(dataStart, dataStart + compSize);
		if (method === 8) data = await inflateRaw(data);
		else if (method !== 0) continue;
		const key = name.replace(/\.npy$/, '');
		const parsed = parseNpy(data);
		result[key] = parsed;
	}
	return result;
}
