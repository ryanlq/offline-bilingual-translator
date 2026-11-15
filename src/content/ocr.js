/**
 * OCR 图片翻译（内容脚本侧）
 *
 * 1. 框选屏幕区域：全屏遮罩 + 拖拽选区 → 后台截屏裁剪 → OCR → 翻译 → 结果浮窗
 * 2. 右键菜单图片翻译：图片 URL 交给后台抓取识别
 */

(function () {
	'use strict';

	const OBT = self.OBT;

	class OcrTranslator {
		constructor() {
			this.settings = null;
			this.overlay = null;
			this.resultPanel = null;
			/** closed shadow root 需自行持有（panel.shadowRoot 为 null） */
			this.resultRoot = null;
			this.selecting = false;
		}

		setSettings(settings) {
			this.settings = settings;
		}

		/* ---------- 框选区域 ---------- */

		startRegionSelection() {
			if (this.selecting) return;
			this.selecting = true;

			const overlay = document.createElement('div');
			overlay.setAttribute('data-obt-ocr-overlay', '');
			Object.assign(overlay.style, {
				position: 'fixed',
				inset: '0',
				zIndex: '2147483645',
				cursor: 'crosshair',
				background: 'rgba(0,0,0,0.25)',
			});

			const box = document.createElement('div');
			Object.assign(box.style, {
				position: 'absolute',
				border: '2px solid #1a73e8',
				background: 'rgba(26,115,232,0.1)',
				display: 'none',
			});
			overlay.appendChild(box);

			const hint = document.createElement('div');
			hint.textContent = '拖拽框选要翻译的区域，Esc 取消';
			Object.assign(hint.style, {
				position: 'absolute',
				top: '12px',
				left: '50%',
				transform: 'translateX(-50%)',
				background: 'rgba(32,33,36,0.85)',
				color: '#fff',
				padding: '6px 14px',
				borderRadius: '16px',
				font: '13px -apple-system, "Microsoft YaHei", sans-serif',
			});
			overlay.appendChild(hint);

			let startX = 0;
			let startY = 0;
			let dragging = false;

			const onMove = (event) => {
				if (!dragging) return;
				const x = Math.min(startX, event.clientX);
				const y = Math.min(startY, event.clientY);
				const w = Math.abs(event.clientX - startX);
				const h = Math.abs(event.clientY - startY);
				Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, display: 'block' });
			};

			const finish = (event) => {
				if (!dragging) return;
				dragging = false;
				const rect = {
					x: Math.min(startX, event.clientX),
					y: Math.min(startY, event.clientY),
					width: Math.abs(event.clientX - startX),
					height: Math.abs(event.clientY - startY),
				};
				cleanup();
				if (rect.width < 8 || rect.height < 8) return;
				this.requestRegionOcr(rect);
			};

			const cleanup = () => {
				this.selecting = false;
				overlay.remove();
				document.removeEventListener('mousemove', onMove, true);
				document.removeEventListener('mouseup', finish, true);
				document.removeEventListener('keydown', onKey, true);
			};

			const onKey = (event) => {
				if (event.key === 'Escape') cleanup();
			};

			overlay.addEventListener('mousedown', (event) => {
				event.preventDefault();
				dragging = true;
				startX = event.clientX;
				startY = event.clientY;
			});
			document.addEventListener('mousemove', onMove, true);
			document.addEventListener('mouseup', finish, true);
			document.addEventListener('keydown', onKey, true);

			document.documentElement.appendChild(overlay);
			this.overlay = overlay;
		}

		/** 请求后台截屏识别 */
		async requestRegionOcr(rect) {
			this.showResultPanel('OCR 识别中…');
			chrome.runtime.sendMessage(
				{
					type: 'command:fromContent',
					payload: {
						type: 'ocr-capture-region',
						rect,
						devicePixelRatio: window.devicePixelRatio || 1,
						langs: this.settings.ocrLangs,
						from: this.settings.ocrFrom,
						to: this.settings.ocrTo,
						langPath: this.settings.ocrLangPath || undefined,
					},
				},
				(response) => {
					if (chrome.runtime.lastError) {
						this.showResultPanel(`⚠ ${chrome.runtime.lastError.message}`);
						return;
					}
					// 失败会以 {ok:false} 直接回传；成功结果则通过 ocr:result 消息推送
					if (response && response.ok === false) {
						this.showResultPanel(`⚠ ${response.error || 'OCR 失败'}`);
					}
				},
			);
		}

		/* ---------- 右键图片 ---------- */

		async requestImageOcr(srcUrl) {
			// 命令会广播到所有 frame，只有真正包含该图片的 frame 才处理
			if (!srcUrl) return;
			if (![...document.images].some((img) => img.src === srcUrl)) return;
			this.showResultPanel('OCR 识别中…');
			chrome.runtime.sendMessage(
				{
					type: 'command:fromContent',
					payload: {
						type: 'ocr-image-url',
						url: srcUrl,
						langs: this.settings.ocrLangs,
						from: this.settings.ocrFrom,
						to: this.settings.ocrTo,
						langPath: this.settings.ocrLangPath || undefined,
					},
				},
				(response) => {
					if (chrome.runtime.lastError) {
						this.showResultPanel(`⚠ ${chrome.runtime.lastError.message}`);
						return;
					}
					if (response && response.ok === false) {
						this.showResultPanel(`⚠ ${response.error || 'OCR 失败'}`);
					}
				},
			);
		}

		/* ---------- 结果浮窗 ---------- */

		showResultPanel(content) {
			this.createResultPanel();
			const body = this.resultRoot.querySelector('.body');
			body.textContent = content;
			this.resultPanel.style.display = 'block';
		}

		showOcrResult(text, translation) {
			this.createResultPanel();
			const body = this.resultRoot.querySelector('.body');
			body.innerHTML = `
				<div class="label">识别原文</div>
				<div class="original"></div>
				<div class="label">译文</div>
				<div class="translation"></div>
			`;
			body.querySelector('.original').textContent = text || '（未识别到文字）';
			body.querySelector('.translation').textContent = translation || '—';
			this.resultPanel.style.display = 'block';
		}

		createResultPanel() {
			if (this.resultPanel) return;
			const panel = document.createElement('div');
			panel.setAttribute('data-obt-ocr-panel', '');
			panel.style.position = 'fixed';
			panel.style.zIndex = '2147483647';
			panel.style.right = '24px';
			panel.style.bottom = '24px';

			const root = panel.attachShadow({ mode: 'closed' });
			this.resultRoot = root;
			root.innerHTML = `
				<style>
					:host { all: initial; }
					.panel {
						width: 360px;
						max-height: 420px;
						overflow: auto;
						background: #ffffff;
						border: 1px solid #dadce0;
						border-radius: 10px;
						box-shadow: 0 6px 24px rgba(0,0,0,0.22);
						padding: 12px 14px;
						font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
						color: #202124;
					}
					.header {
						display: flex;
						justify-content: space-between;
						align-items: center;
						margin-bottom: 8px;
					}
					.title { font-weight: 600; }
					.close {
						border: none; background: none; cursor: pointer;
						color: #9aa0a6; font-size: 14px;
					}
					.close:hover { color: #5f6368; }
					.label {
						font-size: 11px;
						color: #80868b;
						margin: 8px 0 2px;
					}
					.original { color: #5f6368; white-space: pre-wrap; }
					.translation { color: #1a73e8; font-size: 14px; white-space: pre-wrap; }
					.body { /* 由脚本填充 */ }
				</style>
				<div class="panel">
					<div class="header">
						<span class="title">OCR 图片翻译</span>
						<button class="close" title="关闭">✕</button>
					</div>
					<div class="body"></div>
				</div>
			`;
			root.querySelector('.close').addEventListener('click', () => {
				panel.style.display = 'none';
			});

			document.documentElement.appendChild(panel);
			this.resultPanel = panel;
		}

		hideResultPanel() {
			this.resultPanel?.style && (this.resultPanel.style.display = 'none');
		}
	}

	OBT.OcrTranslator = OcrTranslator;
})();
