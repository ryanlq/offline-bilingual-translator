/**
 * 轻量 RPC：在 chrome.runtime 消息之上封装 请求/响应 与 事件流。
 *
 * - rpcCall(channel, payload)  → Promise<payload>
 * - rpcListen(channel, handler) → 可注销
 * - 事件流（如下载进度）：handler 可返回 {__stream: true} 的分片，
 *   通过 rpcListen 以 `channel:` 事件通道持续推送。
 */

const CALL_PREFIX = 'rpc:call:';
const RESP_PREFIX = 'rpc:resp:';
const EVENT_PREFIX = 'rpc:event:';

// 本地路由：Firefox 事件页中后台与引擎同上下文，rpcCall 直调本地 handler，
// 绕过消息总线（sendMessage 不会送达本上下文的 onMessage 监听）。
const localRoutes = new Map();

let serial = 0;
const pending = new Map();

/**
 * 发起一次 RPC 调用
 * @param {string} channel
 * @param {any} payload
 * @returns {Promise<any>}
 */
export function rpcCall(channel, payload) {
	// 本地直调（Firefox 事件页）：引擎 handler 已通过 rpcListen 注册在本上下文
	if (localRoutes.has(channel)) {
		const handler = localRoutes.get(channel);
		return Promise.resolve()
			.then(() => handler(payload, null))
			.then(
				(result) => result,
				(error) => {
					throw error instanceof Error ? error : new Error(String(error));
				},
			);
	}

	return new Promise((resolve, reject) => {
		const id = `${Date.now()}-${++serial}`;
		pending.set(id, { resolve, reject, channel });

		const settleFromResponse = (resp) => {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (resp?.error) {
				const err = new Error(resp.error.message ?? String(resp.error));
				err.stack = resp.error.stack;
				entry.reject(err);
			} else {
				entry.resolve(resp?.result);
			}
		};

		// 响应方通过 sendResponse 直接回传（广播式 RESP 监听作为兼容兜底）
		chrome.runtime
			.sendMessage({ channel: CALL_PREFIX + channel, id, payload })
			.then((resp) => {
				if (resp && typeof resp === 'object' && resp.channel === RESP_PREFIX) {
					settleFromResponse(resp);
					return;
				}
				const entry = pending.get(id);
				pending.delete(id);
				entry?.reject(
					new Error(`RPC 无响应: ${channel}（接收端未注册或已休眠）`),
				);
			})
			.catch((err) => {
				pending.delete(id);
				reject(err);
			});
	});
}

/**
 * 监听 RPC 调用。handler 返回值（或 Promise）作为响应发回。
 * @param {string} channel
 * @param {(payload: any, sender: any) => any} handler
 * @returns {() => void} 注销函数
 */
export function rpcListen(channel, handler) {
	localRoutes.set(channel, handler); // 注册本地路由（Firefox 同上下文直调用）
	const listener = (message, sender, sendResponse) => {
		if (!message || typeof message.channel !== 'string') return false;

		if (message.channel === CALL_PREFIX + channel) {
			Promise.resolve()
				.then(() => handler(message.payload, sender))
				.then(
					(result) => sendResponse({ channel: RESP_PREFIX, id: message.id, result }),
					(error) =>
						sendResponse({
							channel: RESP_PREFIX,
							id: message.id,
							error: { message: error?.message ?? String(error), stack: error?.stack },
						}),
				);
			return true; // 异步响应
		}

		return false;
	};

	chrome.runtime.onMessage.addListener(listener);
	return () => {
		chrome.runtime.onMessage.removeListener(listener);
		localRoutes.delete(channel);
	};
}

/**
 * 推送事件流分片（如下载进度）
 * @param {string} streamId 事件流 id
 * @param {any} chunk
 */
export function rpcEmit(streamId, chunk) {
	chrome.runtime
		.sendMessage({ channel: EVENT_PREFIX + streamId, payload: chunk })
		.catch(() => {
			/* 接收方可能已关闭，忽略 */
		});
}

/**
 * 订阅事件流分片
 * @param {string} streamId
 * @param {(chunk: any) => void} onChunk
 * @returns {() => void}
 */
export function rpcSubscribe(streamId, onChunk) {
	const listener = (message) => {
		if (message && message.channel === EVENT_PREFIX + streamId) onChunk(message.payload);
	};
	chrome.runtime.onMessage.addListener(listener);
	return () => chrome.runtime.onMessage.removeListener(listener);
}

chrome.runtime.onMessage.addListener((message) => {
	if (message && typeof message.channel === 'string' && message.channel === RESP_PREFIX) {
		const entry = pending.get(message.id);
		if (entry) {
			pending.delete(message.id);
			if (message.error) {
				const err = new Error(message.error.message);
				err.stack = message.error.stack;
				entry.reject(err);
			} else {
				entry.resolve(message.result);
			}
		}
	}
	return false;
});
