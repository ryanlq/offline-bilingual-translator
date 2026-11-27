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
		textColor: '#060606',
		backgroundColor: 'transparent',
		hoverHighlight: true,
		inlineFormat: true, // 译文保留粗体/斜体/链接等内联格式（引擎 html 模式）
		translateDirection: 'auto', // auto: 根据页面语言选择方向
		selectTranslateEnabled: true, // 划词翻译开关
		excludeSelectors: [],
		ocrLangs: 'eng',
		ocrFrom: 'en',
		ocrTo: 'zh',
		ocrLangPath: '',
	};

	/** 读取设置（Firefox MV2 storage.local 为回调约定，统一用回调风格） */
	const LEGACY_TEXT_COLOR = '#8b8b8b'; // 旧版默认灰：已存该值的老用户静默迁移到新默认
	OBT.getSettings = async function () {
		const stored = await new Promise((resolve) => chrome.storage.local.get('settings', resolve));
		const { settings } = stored || {};
		const merged = { ...DEFAULT_SETTINGS, ...settings };
		if (merged.textColor === LEGACY_TEXT_COLOR) merged.textColor = DEFAULT_SETTINGS.textColor;
		return merged;
	};

	/** 保存设置 */
	OBT.saveSettings = async function (patch) {
		const current = await OBT.getSettings();
		const settings = { ...current, ...patch };
		await new Promise((resolve) => chrome.storage.local.set({ settings }, resolve));
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
			const p = chrome.runtime
				.sendMessage({ channel: CALL_PREFIX + channel, id, payload });
			if (p && typeof p.then === 'function') {
				p.then((resp) => {
					if (resp && typeof resp === 'object' && resp.channel === RESP_PREFIX && resp.id === id) {
						chrome.runtime.onMessage.removeListener(listener);
						if (resp.error) {
							reject(new Error(resp.error.message));
						} else {
							resolve(resp.result);
						}
					}
					// 其余情况（无响应或由其它上下文回传）：保持等待广播 RESP
				});
			}
			// Firefox MV2 回调约定：sendMessage 返回 undefined，响应由上方广播监听回传
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

	/* ---------------- 翻译会话保活（Port 心跳） ---------------- */

	/* MV3 SW 空闲 30s 即休眠，每批翻译间的空档（用户滚动、阅读）会反复付
	   唤醒成本。Port 上的消息会持续重置空闲计时器（Chrome 110+/Firefox
	   event page 同理），翻译开启期间每 20s 一次心跳即可保活。 */
	let keepAlivePort = null;
	let keepAliveTimer = null;

	/** 开启保活（翻译会话开始时调用；幂等） */
	OBT.startSessionKeepAlive = function () {
		if (keepAlivePort) return;
		try {
			keepAlivePort = chrome.runtime.connect({ name: 'obt-keepalive' });
		} catch {
			return; // 后台不可达等场景直接放弃，不影响功能
		}
		keepAlivePort.onDisconnect.addListener(() => {
			clearInterval(keepAliveTimer);
			keepAliveTimer = null;
			keepAlivePort = null;
		});
		keepAliveTimer = setInterval(() => {
			try {
				keepAlivePort.postMessage({ ping: Date.now() });
			} catch {
				/* 端口已死：下次 disconnect 回调会清理 */
			}
		}, 20_000);
	};

	/** 结束保活（翻译关闭时调用；允许 SW 正常休眠） */
	OBT.stopSessionKeepAlive = function () {
		clearInterval(keepAliveTimer);
		keepAliveTimer = null;
		try {
			keepAlivePort?.disconnect();
		} catch {
			/* 已断开 */
		}
		keepAlivePort = null;
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
		// 假名是日语的确定性标志（几乎全部日文都含假名）；谚文对应韩语
		const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
		if (kana >= 2) return 'ja';
		const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
		if (hangul >= 2) return 'ko';
		const hanzi = (text.match(/[\u4e00-\u9fff]/g) || []).length;
		const latin = (text.match(/[a-zA-Z]/g) || []).length;
		if (hanzi > latin) return 'zh';
		if (latin > 0) return 'en';
		return null;
	};

	self.OBT = OBT;
})();
