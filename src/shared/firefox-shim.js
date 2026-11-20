/**
 * Firefox MV2 兼容垫片（仅在 Firefox 下生效，Chrome 中为无操作）。
 *
 * Firefox MV2 的部分 chrome.* API 仍是回调约定：不带回调调用时返回 undefined
 * 而非 Promise。本垫片把常用回调 API 统一包成 Promise（带回调时保持原样），
 * 使 Chrome 风格的 `await chrome.xxx.yyy()` 代码无需改动即可运行。
 *
 * 以经典脚本（非 module）引用，必须在所有 module 脚本之前加载。
 */
(function () {
	'use strict';
	if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return;
	if (chrome.runtime.getURL('/').indexOf('moz-extension://') !== 0) return; // 非 Firefox

	const promisify = (ns, fn) => {
		const orig = ns[fn];
		if (typeof orig !== 'function') return;
		ns[fn] = function (...args) {
			const last = args[args.length - 1];
			if (args.length && typeof last === 'function') return orig.apply(this, args);
			// 必须只用回调形式包一层：不能先无回调探测返回值再补回调——
			// 对有副作用的 API（如 tabs.sendMessage）那会把调用/消息发两次
			return new Promise((resolve, reject) => {
				orig.apply(this, [
					...args,
					(r) => {
						const err = chrome.runtime.lastError;
						if (err) reject(new Error(err.message ?? String(err)));
						else resolve(r);
					},
				]);
			});
		};
	};

	promisify(chrome.runtime, 'sendMessage');
	if (chrome.tabs) {
		promisify(chrome.tabs, 'sendMessage');
		promisify(chrome.tabs, 'query');
		promisify(chrome.tabs, 'create');
		promisify(chrome.tabs, 'remove');
		promisify(chrome.tabs, 'update');
		promisify(chrome.tabs, 'captureVisibleTab');
	}
	if (chrome.storage) {
		for (const area of [chrome.storage.local, chrome.storage.sync].filter(Boolean)) {
			promisify(area, 'get');
			promisify(area, 'set');
			promisify(area, 'remove');
			promisify(area, 'clear');
		}
	}
	promisify(chrome.runtime, 'openOptionsPage');
})();
