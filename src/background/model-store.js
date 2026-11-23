/**
 * 模型文件存储：IndexedDB 缓存 + 下载 + 校验 + 解压
 *
 * 设计参考 Linguist 的模型缓存（BSD-3-Clause），代码重新实现：
 * - 以 sha256 为缓存键（内容寻址），语言对 + 文件名作为索引
 * - 下载过程通过 rpcEmit 推送进度事件
 */

import { rpcEmit } from '../shared/rpc.js';

const DB_NAME = 'model-store';
const DB_VERSION = 1;
const STORE_FILES = 'files';

let dbPromise = null;

function openDb() {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_FILES)) {
				const store = db.createObjectStore(STORE_FILES, {
					keyPath: ['direction', 'part'],
				});
				store.createIndex('sha256', 'sha256');
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

/** 将 IDBRequest 转为 Promise */
function reqToPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** 在单个只读事务中执行请求，返回请求结果 */
async function txRead(fn) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_FILES, 'readonly');
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
		try {
			const request = fn(tx.objectStore(STORE_FILES));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		} catch (err) {
			reject(err);
		}
	});
}

/** 在单个读写事务中执行请求，事务完成后返回请求结果 */
async function txWrite(fn) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_FILES, 'readwrite');
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
		try {
			const request = fn(tx.objectStore(STORE_FILES));
			request.onsuccess = () => {
				tx.oncomplete = () => resolve(request.result);
			};
			request.onerror = () => reject(request.error);
		} catch (err) {
			reject(err);
		}
	});
}

async function putFile(record) {
	return txWrite((store) => store.put(record));
}

export async function getModelFile(direction, part) {
	const record = await txRead((store) => store.get([direction, part]));
	return record ?? null;
}

export async function listStoredModels() {
	return txRead((store) => store.getAll());
}

export async function deleteModel(direction) {
	return txWrite((store) =>
		store.delete(IDBKeyRange.bound([direction, ''], [direction, '\uffff'])),
	);
}

/** hex → base64（fetch integrity 校验用） */
function hexToBase64(hex) {
	const match = hex.match(/\w{2}/g);
	if (!match) throw new TypeError('无效的十六进制字符串');
	const binary = match.map((a) => String.fromCharCode(parseInt(a, 16))).join('');
	return btoa(binary);
}

/**
 * 下载文件，推送进度事件
 * @param {string} url
 * @param {{streamId: string, label: string, integrity?: string}} options
 * @returns {Promise<ArrayBuffer>}
 */
// 注：不用 fetch 的 integrity 选项——SRI 与 HF 重定向/xet 分片存在兼容问题
// （表现为笼统的 Failed to fetch），改为下载完成后手动 sha256 校验（下方既有逻辑）。
async function fetchOnce(url) {
	return fetch(url, { credentials: 'omit' });
}

/** 下载（带重试）：HF 的 xet CDN 偶发瞬时失败（TLS/连接重置），弱网尤其常见 */
async function downloadWithRetry(url, opts) {
	let lastErr = null;
	for (const attempt of [1, 2, 3]) {
		try {
			return await fetchOnce(url, opts);
		} catch (err) {
			lastErr = err;
			if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
		}
	}
	throw lastErr;
}

async function downloadFile(url, { streamId, label, integrity }) {
	const response = await downloadWithRetry(url, { integrity });
	if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);

	if (!response.body) {
		return response.arrayBuffer();
	}

	const reader = response.body.getReader();
	const contentLength = Number(response.headers.get('content-length')) || 0;
	const chunks = [];
	let received = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		if (contentLength > 0) {
			rpcEmit(streamId, {
				label,
				loaded: received,
				total: contentLength,
			});
		}
	}

	const buffer = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer.buffer;
}

/** gzip 解压（DecompressionStream，Chrome 80+） */
async function gunzip(buffer) {
	const ds = new DecompressionStream('gzip');
	const stream = new Blob([buffer]).stream().pipeThrough(ds);
	const result = await new Response(stream).arrayBuffer();
	return result;
}

/** sha256 摘要（hex） */
async function sha256Hex(buffer) {
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * 下载并缓存一个模型文件（带 sha256 校验与进度推送）
 * @param {{direction: string, part: string, name: string, url: string, sha256: string, size: number, integrity?: boolean}} fileSpec
 * @param {{streamId: string, force?: boolean}} options
 *   force: 忽略缓存命中，强制重新下载（用于「重新下载」；下载失败时旧缓存不被破坏）
 * @returns {Promise<ArrayBuffer>}
 */
export async function ensureModelFile(fileSpec, { streamId, force = false }) {
	// 命中缓存？（force 时跳过，但新文件写入前不会删除旧记录）
	const cached = force ? null : await getModelFile(fileSpec.direction, fileSpec.part);
	if (cached) {
		if (!fileSpec.sha256 || cached.sha256 === fileSpec.sha256) {
			rpcEmit(streamId, { label: fileSpec.name, loaded: 1, total: 1, done: true, cached: true });
			return cached.buffer;
		}
		// 缓存损坏或不匹配，重新下载
	}

	const integrity = fileSpec.integrity !== false ? fileSpec.sha256 : null;
	let buffer;
	try {
		buffer = await downloadFile(fileSpec.url, { streamId, label: fileSpec.name, integrity });
	} catch (err) {
		throw err;
	}


	if (fileSpec.sha256) {
		const hash = await sha256Hex(buffer);
		if (hash !== fileSpec.sha256) {
			throw new Error(`文件校验失败: ${fileSpec.name}`);
		}
	}

	await putFile({
		direction: fileSpec.direction,
		part: fileSpec.part,
		name: fileSpec.name,
		sha256: fileSpec.sha256,
		size: buffer.byteLength,
		buffer,
		updatedAt: Date.now(),
	});

	rpcEmit(streamId, { label: fileSpec.name, loaded: 1, total: 1, done: true });
	return buffer;
}
