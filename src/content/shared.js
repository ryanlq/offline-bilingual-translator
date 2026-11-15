/**
 * 内容脚本公共设施（经典脚本，通过 self.OBT 命名空间共享）
 */

(function () {
	'use strict';
	if (self.OBT) return; // 防止重复注入

	const OBT = {};

	/** 默认设置 */
	const DEFAULT_SETTINGS = {
		fontSize: 14,
		textColor: '#8b8b8b',
		backgroundColor: 'transparent',
		hoverHighlight: true,
		translateDirection: 'auto', // auto: 根据页面语言选择方向
		selectTranslateEnabled: true, // 划词翻译开关
		excludeSelectors: [],
		ocrLangs: 'eng',
		ocrFrom: 'en',
		ocrTo: 'zh',
		ocrLangPath: '',
	};

	/** 读取设置 */
	OBT.getSettings = async function () {
		const { settings } = await chrome.storage.local.get('settings');
		return { ...DEFAULT_SETTINGS, ...settings };
	};

	/** 保存设置 */
	OBT.saveSettings = async function (patch) {
		const current = await OBT.getSettings();
		const settings = { ...current, ...patch };
		await chrome.storage.local.set({ settings });
		return settings;
	};

	/* ---------------- RPC（与 src/shared/rpc.js 协议一致） ---------------- */

	const CALL_PREFIX = 'rpc:call:';
	const RESP_PREFIX = 'rpc:resp:';
	const EVENT_PREFIX = 'rpc:event:';
	let serial = 0;

	/**
	 * 内容脚本侧 RPC 调用
	 * @param {string} channel
	 * @param {any} payload
	 * @returns {Promise<any>}
	 */
	OBT.rpcCall = function (channel, payload) {
		return new Promise((resolve, reject) => {
			const id = `content-${Date.now()}-${++serial}`;
			// 响应方通过 sendResponse 直接回传（广播式 RESP 监听作为兼容兜底）
			const listener = (message) => {
				if (message?.channel === RESP_PREFIX && message.id === id) {
					chrome.runtime.onMessage.removeListener(listener);
					if (message.error) {
						reject(new Error(message.error.message));
					} else {
						resolve(message.result);
					}
				}
			};
			chrome.runtime.onMessage.addListener(listener);
			chrome.runtime
				.sendMessage({ channel: CALL_PREFIX + channel, id, payload })
				.then((resp) => {
					if (resp && typeof resp === 'object' && resp.channel === RESP_PREFIX && resp.id === id) {
						chrome.runtime.onMessage.removeListener(listener);
						if (resp.error) {
							reject(new Error(resp.error.message));
						} else {
							resolve(resp.result);
						}
					}
					// 其余情况（无响应或由其它上下文回传）：保持等待广播 RESP
				})
				.catch((err) => {
					chrome.runtime.onMessage.removeListener(listener);
					reject(err);
				});
		});
	};

	/**
	 * 订阅后台事件流
	 * @param {string} streamId
	 * @param {(chunk: any) => void} onChunk
	 * @returns {() => void}
	 */
	OBT.rpcSubscribe = function (streamId, onChunk) {
		const listener = (message) => {
			if (message && message.channel === EVENT_PREFIX + streamId) onChunk(message.payload);
		};
		chrome.runtime.onMessage.addListener(listener);
		return () => chrome.runtime.onMessage.removeListener(listener);
	};

	/** 语言方向解析（任意四字母语言对，如 enzh / ende / fren） */
	OBT.resolveDirection = function (setting, pageLanguage) {
		if (setting && setting !== 'auto') {
			const match = /^([a-z]{2})([a-z]{2})$/i.exec(setting);
			if (match) {
				return { from: match[1].toLowerCase(), to: match[2].toLowerCase() };
			}
		}
		// auto：中文页面 → 英文，其余 → 中文
		const isZhPage = /^(zh|.*[-_]zh|.*[-_]hans)/i.test(pageLanguage || '');
		return isZhPage ? { from: 'zh', to: 'en' } : { from: 'en', to: 'zh' };
	};

	/**
	 * 粗判一段文本的语言（够划词弹窗的取舍用，不追求精确）
	 * @param {string} text
	 * @returns {'zh'|'en'|null} null 表示无法判断（数字、符号等）
	 */
	OBT.detectTextLang = function (text) {
		if (!text) return null;
		const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
		const latin = (text.match(/[a-zA-Z]/g) || []).length;
		if (cjk > latin) return 'zh';
		if (latin > 0) return 'en';
		return null;
	};

	self.OBT = OBT;
})();
