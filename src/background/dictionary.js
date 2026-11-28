/**
 * 词典包（ECDICT 精简版）管理：按需下载 + IndexedDB 缓存 + 点词查询
 *
 * 数据：glossaries/dict/ecdict-lite.json.gz（gzip JSON，57447 词条，约 2MB）
 * 下载：用户在设置页主动开启后拉取，存入 IndexedDB（与语言包同库）
 * 查询：word → { phonetic, translation, pos }
 */

import { getModelFile, putFileRecord, deleteModel } from './model-store.js';


const DICT_KEY = { direction: 'dict', part: 'ecdict-lite' };

/** @type {Array<{w:string,p:string,t:string,pos:string,s:number}>|null} */
let dictCache = null;
/** 查询索引：word.toLowerCase() → 词条（懒建，约 50ms） */
let dictIndex = null;

export function dictInstalled() {
	return getModelFile(DICT_KEY.direction, DICT_KEY.part).then((r) => Boolean(r?.buffer));
}

export function dictDelete() {
	dictCache = null;
	dictIndex = null;
	return deleteModel(DICT_KEY.direction);
}

/** 启用词典：读取随扩展分发的 gzip 词库，解压后存入 IndexedDB（零网络依赖） */
export async function dictDownload(streamId = 'dict-pack') {
	try {
		const url = chrome.runtime.getURL('glossaries/dict/ecdict-lite.json.gz');
		const response = await fetch(url);
		if (!response.ok) throw new Error(`读取词典资源失败 HTTP ${response.status}`);
		const buf = new Uint8Array(await response.arrayBuffer());
		const ds = new DecompressionStream('gzip');
		const json = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
		const entries = JSON.parse(json);
		if (!Array.isArray(entries) || entries.length < 1000) throw new Error('词典数据异常');
		await putFileRecord({
			direction: DICT_KEY.direction,
			part: DICT_KEY.part,
			name: 'ecdict-lite.json.gz',
			sha256: '',
			size: buf.byteLength,
			buffer: buf,
			updatedAt: Date.now(),
		});
		dictCache = entries;
		dictIndex = null;
		return { entries: entries.length };
	} catch (err) {
		throw new Error(`词典启用失败：${String(err.message || err).slice(0, 60)}`);
	}
}

/** 确保词典已加载进内存（IndexedDB → 缓存 → 索引） */
async function ensureDict() {
	if (dictIndex) return dictCache;
	const record = await getModelFile(DICT_KEY.direction, DICT_KEY.part);
	if (!record?.buffer) throw new Error('词典未下载');
	if (!dictCache) {
		const ds = new DecompressionStream('gzip');
		const json = await new Response(new Blob([record.buffer]).stream().pipeThrough(ds)).text();
		dictCache = JSON.parse(json);
	}
	if (!dictIndex) {
		dictIndex = new Map();
		for (const entry of dictCache) dictIndex.set(entry.w.toLowerCase(), entry);
	}
	return dictCache;
}

/** 查词（精确 → 小写 → 去尾 s/es/d/ing 的弱还原尝试） */
export async function dictLookup(word) {
	await ensureDict();
	const w = String(word).trim().toLowerCase();
	if (!w) return null;
	const direct = dictIndex.get(w);
	if (direct) return direct;
	// 弱还原：复数/时态
	const tries = [];
	if (w.endsWith('s')) tries.push(w.slice(0, -1));
	if (w.endsWith('es')) tries.push(w.slice(0, -2));
	if (w.endsWith('ies')) tries.push(w.slice(0, -3) + 'y');
	if (w.endsWith('ing')) tries.push(w.slice(0, -3), w.slice(0, -3) + 'e');
	if (w.endsWith('ed')) tries.push(w.slice(0, -2), w.slice(0, -1));
	for (const t of tries) {
		const hit = dictIndex.get(t);
		if (hit) return hit;
	}
	return null;
}
