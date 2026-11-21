/**
 * 内容脚本入口：组装各模块，接收后台命令
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	/** @type {OBT.PageTranslator} */
	let pageTranslator = null;
	/** @type {OBT.SelectTranslator} */
	let selectTranslator = null;
	/** @type {OBT.OcrTranslator} */
	let ocrTranslator = null;

	async function init() {
		const settings = await OBT.getSettings();

		pageTranslator = new OBT.PageTranslator();
		selectTranslator = new OBT.SelectTranslator();
		ocrTranslator = new OBT.OcrTranslator();

		selectTranslator.setSettings(settings);
		selectTranslator.setEnabled(settings.selectTranslateEnabled !== false);
		ocrTranslator.setSettings(settings);

		// 设置变化时同步
		chrome.storage.onChanged.addListener(async (changes, area) => {
			if (area !== 'local' || !changes.settings) return;

			const newSettings = await OBT.getSettings();
			selectTranslator.setSettings(newSettings);
			selectTranslator.setEnabled(newSettings.selectTranslateEnabled !== false);
			ocrTranslator.setSettings(newSettings);

			// 切换到新装的语言包时，正在翻译的页面按新方向重启（run 内部会先 stop 清理译文）
			const oldDirection = changes.settings.oldValue?.translateDirection;
			if (pageTranslator?.isRun() && oldDirection !== newSettings.translateDirection) {
				try {
					await pageTranslator.run(
						OBT.resolveDirection(
							newSettings.translateDirection,
							document.documentElement.lang,
						),
						newSettings,
					);
				} catch (err) {
					console.warn('切换翻译方向失败:', err.message);
				}
			}
		});
	}

	/** 开/关页面双语翻译（加锁防重入：消息重复投递或快速连击只算一次） */
	let toggleBusy = false;
	async function togglePageTranslation() {
		if (toggleBusy) return;
		toggleBusy = true;
		try {
			if (!pageTranslator) return;
			const settings = await OBT.getSettings();

			if (pageTranslator.isRun()) {
				pageTranslator.stop();
				OBT.stopSessionKeepAlive();
				return;
			}

			const direction = OBT.resolveDirection(
				settings.translateDirection,
				document.documentElement.lang,
			);
			OBT.startSessionKeepAlive();
			await pageTranslator.run(direction, settings);
		} catch (err) {
			console.error('OBT 页面翻译启动失败:', err);
			alert(`双语翻译启动失败：${err.message}\n请检查是否已下载对应语言包（工具栏 → 设置）`);
		} finally {
			toggleBusy = false;
		}
	}

	/** 后台命令 */
	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (!message?.type) return false;

		switch (message.type) {
			case 'command:togglePageTranslation':
				togglePageTranslation();
				sendResponse({ ok: true });
				return true;

			case 'command:translateSelection':
				// 右键菜单入口：直接翻译当前选区（不依赖 mouseup 事件）
				selectTranslator?.translateSelection();
				sendResponse({ ok: true });
				return true;

			case 'command:ocrScreenRegion':
				// 框选/截屏都基于顶层视口坐标，只在主框架启动
				if (window.top === window) ocrTranslator?.startRegionSelection();
				sendResponse({ ok: true });
				return true;

			case 'command:ocrImage':
				ocrTranslator?.requestImageOcr(message.srcUrl);
				sendResponse({ ok: true });
				return true;

			case 'ocr:result':
				ocrTranslator?.showOcrResult(message.text, message.translation);
				sendResponse({ ok: true });
				return true;

			default:
				return false;
		}
	});

	init();
})();
