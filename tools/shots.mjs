/**
 * Chrome Web Store 真机截图生成器（在 instabox-2 上跑）
 *
 * 用法：
 *   xvfb-run -a --server-args="-screen 0 1400x950x24" node shots.mjs \
 *     <扩展解压目录> <输出目录> <locale> [profile目录]
 *
 * 产物：1280×800 viewport 截图（Chrome Web Store 要求尺寸）
 *   zh run: 01 双语对照(hero) / 02 划词 / 03 OCR / 04 设置页
 *   en run: 01 zh→en 对照(hero) / 02 划词 / 03 OCR(中→英)
 *
 * 两类页面的关键区别：
 *   - 截图页 pageA：playwright 仿真 viewport 1280×800（page.screenshot 即商店尺寸）
 *   - OCR 页 pageB：不做 viewport 仿真（CSS 坐标 == captureVisibleTab 物理像素，
 *     拖拽矩形与裁剪区域才对齐）；出结果后再临时仿真 1280×800 截图
 *
 * 模型/识别数据缓存在 profile 里，两个 locale 共用一个 profile 免重复下载。
 */
import { createRequire } from 'module';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

const require = createRequire('/opt/browserless/node_modules/');
const { chromium } = require('playwright-core');

const [EXT_DIR, OUT_DIR, LOCALE = 'zh-CN', PROFILE = '/tmp/obt-profile'] = process.argv.slice(2);
if (!EXT_DIR || !OUT_DIR) {
	console.error('usage: node shots.mjs <extDir> <outDir> <locale> [profile]');
	process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launchPersistentContext(PROFILE, {
	executablePath: '/usr/bin/chromium', // 品牌 Google Chrome 137+ 忽略 --load-extension，必须用 Chromium
	headless: false, // xvfb 提供 display；headful 扩展行为最真实
	viewport: null, // 默认不仿真；截图页单独 setViewportSize
	locale: LOCALE,
	timezoneId: 'Asia/Shanghai',
	args: [
		`--disable-extensions-except=${path.resolve(EXT_DIR)}`,
		`--load-extension=${path.resolve(EXT_DIR)}`,
		'--window-size=1400,950',
		'--force-device-scale-factor=1',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-timer-throttling',
		'--no-sandbox',
		'--disable-dev-shm-usage',
	],
});

/* ---------------- 扩展发现 & 命令 ---------------- */

async function discoverExtId() {
	const cdp = await browser.browser().newBrowserCDPSession();
	try {
		const { targetInfos } = await cdp.send('Target.getTargets');
		const t = targetInfos.find((x) => x.url.startsWith('chrome-extension://'));
		return t ? new URL(t.url).host : null;
	} finally {
		await cdp.detach();
	}
}

const extPath = path.resolve(EXT_DIR);
const computedId = crypto
	.createHash('sha256')
	.update(extPath)
	.digest('hex')
	.slice(0, 32)
	.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

let EXT_ID = (await discoverExtId()) || computedId;
log('extension id =', EXT_ID, computedId === EXT_ID ? '(computed)' : '(from targets)');

async function getSW() {
	let w = browser.serviceWorkers().find((x) => x.url().startsWith('chrome-extension://'));
	if (w) {
		try {
			await w.evaluate('1');
			return w;
		} catch {
			// 句柄失效，重新等
		}
	}
	try {
		return await browser.waitForEvent('serviceworker', { timeout: 45000 });
	} catch {
		// 跳 options 页唤醒 SW（内部 rpcCall 会拉起它）
		const pg = browser.pages()[0] || (await browser.newPage());
		await pg.goto(`chrome-extension://${EXT_ID}/src/options/index.html`).catch(() => {});
		return browser.waitForEvent('serviceworker', { timeout: 45000 });
	}
}

/** 走弹窗按钮同款真实路径：SW → chrome.tabs.sendMessage → content script（发给当前激活标签页） */
async function extCommand(type, extra = {}) {
	const w = await getSW();
	const res = await w.evaluate(
		({ type, extra }) =>
			chrome.tabs
				.query({ active: true, currentWindow: true })
				.then(async ([tab]) => {
					if (!tab?.id) return 'no-tab';
					try {
						return JSON.stringify(await chrome.tabs.sendMessage(tab.id, { type, ...extra }));
					} catch (e) {
						return 'err:' + e.message;
					}
				}),
		{ type, extra },
	);
	log('extCommand', type, '->', res);
	return res;
}

/* ---------------- 截图页 pageA（仿真 1280×800） ---------------- */

const pageA = await browser.newPage();
await pageA.setViewportSize({ width: 1280, height: 800 });
pageA.on('dialog', (d) => {
	log('!! dialog:', d.message());
	d.dismiss().catch(() => {});
});
pageA.on('pageerror', (e) => log('!! pageerror:', e.message));
pageA.on('console', (m) => log('PAGE console:', m.type(), m.text().slice(0, 200)));

/* ---------- Step 1: 设置页，确保内置模型就绪 ---------- */
log('step1: options page, ensure models installed');
await pageA
	.goto(`chrome-extension://${EXT_ID}/src/options/index.html`, { waitUntil: 'domcontentloaded' })
	.catch(async () => {
		const real = await discoverExtId();
		if (real && real !== EXT_ID) {
			EXT_ID = real;
			log('ext id corrected to', EXT_ID);
			await pageA.goto(`chrome-extension://${EXT_ID}/src/options/index.html`);
		}
	});
await pageA.waitForTimeout(3000);
try {
	await pageA.waitForSelector('#model-list .model-item', { timeout: 45000 });
} catch {
	log(
		'!! model-list empty; url =',
		pageA.url(),
		'html =',
		(await pageA.locator('#model-list').innerHTML().catch(() => '<no element>')).slice(0, 300),
	);
	await pageA.screenshot({ path: path.join(OUT_DIR, 'debug-options.png') });
	await pageA.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
	await pageA.waitForTimeout(8000);
	await pageA.waitForSelector('#model-list .model-item', { timeout: 60000 });
}

async function ensureModelInstalled(index) {
	const items = pageA.locator('#model-list .model-item');
	const n = await items.count();
	if (index >= n) return;
	const item = items.nth(index);
	const status = item.locator('.status');
	if ((await status.textContent()).includes('已就绪')) return;
	log(`downloading builtin model #${index} ...`);
	await item.locator('button.primary').click();
	await pageA
		.waitForFunction(
			(i) =>
				document
					.querySelectorAll('#model-list .model-item')
					[i]?.querySelector('.status')
					?.textContent.includes('已就绪'),
			index,
			{ timeout: 15 * 60 * 1000, polling: 2000 },
		)
		.catch(() => {
			throw new Error(`model #${index} install timeout`);
		});
	log(`model #${index} ready`);
}
await ensureModelInstalled(0); // enzh
await ensureModelInstalled(1); // zhen

/** 隐藏维基百科横幅等干扰元素 */
async function cleanupWiki(page) {
	await page.evaluate(() => {
		document
			.querySelectorAll(
				'#siteNotice, .banner-container, .mw-dismissable-notice, [id*="fr-banner"], .cdx-banner',
			)
			.forEach((el) => el.remove());
	});
}

/** 等双语块注入完成且数量稳定 */
async function waitBilingual(page, minBlocks = 8, timeoutMs = 300000) {
	await page.waitForSelector('[data-obt-host]', { timeout: timeoutMs });
	let last = -1;
	let stableSince = Date.now();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const count = await page.evaluate(() => document.querySelectorAll('[data-obt-original]').length);
		if (count === last && count >= minBlocks && Date.now() - stableSince > 4000) return count;
		if (count !== last) {
			last = count;
			stableSince = Date.now();
		}
		await sleep(1500);
	}
	return last;
}

const isZhRun = LOCALE.startsWith('zh');

/* ---------- Step 2: 双语对照 hero（pageA） ---------- */
log('step2: bilingual hero');
if (isZhRun) {
	await pageA.goto('https://en.wikipedia.org/wiki/Machine_translation', {
		waitUntil: 'domcontentloaded',
	});
} else {
	await pageA.goto('https://zh.wikipedia.org/wiki/机器翻译', { waitUntil: 'domcontentloaded' });
}
await pageA.waitForLoadState('networkidle').catch(() => {});
await cleanupWiki(pageA);
await pageA.evaluate(() => {
	const h = document.querySelector('#firstHeading') || document.querySelector('h1');
	const p = document.querySelector('#mw-content-text p');
	(p || h).scrollIntoView({ block: 'start' });
	if (h && p) window.scrollBy(0, -(p.getBoundingClientRect().top - h.getBoundingClientRect().bottom - 8));
});
await pageA.bringToFront();
await extCommand('command:togglePageTranslation');
const blocks = await waitBilingual(pageA, 8);
log('translated blocks =', blocks);
await sleep(1500);
await pageA.screenshot({ path: path.join(OUT_DIR, '01-bilingual-hero.png') });
log('saved 01-bilingual-hero.png');

/* ---------- Step 3: 划词翻译弹窗（pageA） ---------- */
log('step3: selection popup');
await extCommand('command:togglePageTranslation'); // 关掉页面翻译，画面干净
await sleep(1200);
const paras = pageA.locator('#mw-content-text p:visible');
let target = null;
for (let i = 0; i < Math.min(10, await paras.count()); i++) {
	const p = paras.nth(i);
	const bb = await p.boundingBox().catch(() => null);
	if (bb && bb.y > 90 && bb.y < 560 && bb.height > 40) {
		target = p;
		break;
	}
}
if (target) {
	const box = await target.boundingBox();
	await pageA.mouse.move(box.x + 12, box.y + 18);
	await pageA.mouse.down();
	await pageA.mouse.move(box.x + box.width * 0.65, box.y + Math.min(70, box.height - 6), { steps: 10 });
	await pageA.mouse.up();
	await pageA.waitForSelector('[data-obt-select-popup]', { state: 'attached', timeout: 60000 });
	await sleep(2600);
	await pageA.screenshot({ path: path.join(OUT_DIR, '02-selection-popup.png') });
	log('saved 02-selection-popup.png');
} else {
	log('!! no suitable paragraph for selection shot');
}

/* ---------- Step 4: OCR（pageB：无仿真，CSS==物理像素） ---------- */
log('step4: ocr');
const pageB = await browser.newPage(); // 不 setViewportSize → 无仿真
pageB.on('dialog', (d) => {
	log('!! dialog:', d.message());
	d.dismiss().catch(() => {});
});

// 两个 locale 都显式写设置：共用 profile 时上一次运行写入的方向会残留
{
	const swNow = await getSW();
	await swNow.evaluate(async (isZh) => {
		const { settings = {} } = await chrome.storage.local.get('settings');
		const patch = isZh
			? { ocrLangs: 'eng', ocrFrom: 'en', ocrTo: 'zh' }
			: { ocrLangs: 'chi_sim', ocrFrom: 'zh', ocrTo: 'en' };
		await chrome.storage.local.set({ settings: { ...settings, ...patch } });
	}, isZhRun);
	await sleep(800); // 等 content script 收到 storage.onChanged
}

// en run 用本地静态页做 OCR：维基页面加载后仍会重排，坐标不稳；静态页零重排、大字号，识别最稳
let httpServer = null;
let demoPort = 0;
async function ensureLocalDemoPage() {
	if (httpServer) return;
	const { createServer } = await import('node:http');
	const html =
		'<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>机器翻译</title></head>' +
		'<body style="margin:0;font-family:Noto Sans CJK SC,Microsoft YaHei,sans-serif;background:#fff">' +
		'<div id="demo" style="display:inline-block;margin:120px 0 0 120px;padding:20px 28px;font-size:44px;font-weight:700;color:#111;letter-spacing:2px">机器翻译，完全离线运行</div>' +
		'</body></html>';
	httpServer = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(html);
	});
	await new Promise((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(0, '127.0.0.1', resolve);
	});
	demoPort = httpServer.address().port;
	log('local demo page on http://127.0.0.1:' + demoPort + '/');
}

async function ocrShot(panelTimeoutMs = 300000) {
	if (isZhRun) {
		await pageB.goto('https://en.wikipedia.org/wiki/Machine_translation', {
			waitUntil: 'domcontentloaded',
		});
	} else {
		await ensureLocalDemoPage();
		await pageB.goto(`http://127.0.0.1:${demoPort}/`, { waitUntil: 'domcontentloaded' });
	}
	await pageB.waitForLoadState('networkidle').catch(() => {});
	await cleanupWiki(pageB);
	await sleep(2500); // zh 页 webfont 换载会移动标题，等稳定后再测坐标
	await pageB.evaluate(() => window.scrollTo(0, 0));
	await pageB.bringToFront(); // captureVisibleTab 抓的是激活标签页
	await sleep(600);

	await extCommand('command:ocrScreenRegion');
	await pageB.waitForSelector('[data-obt-ocr-overlay]', { timeout: 30000 });
	// 拖拽目标：静态演示页用 #demo，维基用大标题（字号最大，识别最稳）
	const dragSel = !isZhRun ? '#demo' : '#firstHeading';
	let box = await pageB.locator(dragSel).boundingBox();
	if (box) {
		// 滚动到位后再测一次，避免布局变化导致坐标过期
		await pageB.evaluate((s) => {
			document.querySelector(s)?.scrollIntoView({ block: 'center' });
		}, dragSel);
		await sleep(400);
		box = await pageB.locator(dragSel).boundingBox();
	}
	if (!box) {
		const parasB = pageB.locator('#mw-content-text p:visible');
		for (let i = 0; i < Math.min(10, await parasB.count()); i++) {
			const bb = await parasB.nth(i).boundingBox().catch(() => null);
			if (bb && bb.y > 90 && bb.y < 600 && bb.width > 500) {
				box = bb;
				break;
			}
		}
	}
	log('ocr drag box:', JSON.stringify(box));
	if (box) {
		// 边距留在文本外侧，避免切掉首尾字符；纵向必须有真实高度（高度 0 的选区会让裁剪失败）
		const x0 = Math.max(2, box.x - 10);
		const x1 = Math.min(
			(await pageB.evaluate(() => innerWidth)) - 2,
			box.x + box.width + 10,
		);
		const y0 = Math.max(2, box.y + 3);
		const y1 = box.y + box.height - 3;
		await pageB.screenshot({ path: path.join(OUT_DIR, 'debug-preocr.png') });
		await pageB.mouse.move(x0, y0);
		await pageB.mouse.down();
		await pageB.mouse.move(x1, y1, { steps: 10 });
		await pageB.mouse.up();
	}
	await pageB.waitForSelector('[data-obt-ocr-panel]', { timeout: panelTimeoutMs });
	await sleep(2500);
	// 结果出来后再仿真 1280×800 截图（面板 fixed 定位不受重排影响）
	await pageB.setViewportSize({ width: 1280, height: 800 });
	await sleep(600);
	await pageB.screenshot({ path: path.join(OUT_DIR, '03-ocr-result.png') });
	log('saved 03-ocr-result.png');
}
for (let attempt = 1; attempt <= 2; attempt++) {
	try {
		await ocrShot(attempt === 1 ? 90000 : 300000);
		break;
	} catch (e) {
		log(`!! ocr attempt ${attempt} failed:`, e.message.split('\n')[0]);
		if (attempt === 2)
			await pageB.screenshot({ path: path.join(OUT_DIR, '03-ocr-fail.png') }).catch(() => {});
	}
}

/* ---------- Step 5: 设置页（仅中文 run，pageA） ---------- */
if (isZhRun) {
	log('step5: options page');
	await pageA.bringToFront();
	await pageA
		.goto(`chrome-extension://${EXT_ID}/src/options/index.html`, {
			waitUntil: 'domcontentloaded',
		})
		.catch(() => {});
	await pageA.waitForSelector('#model-list .model-item');
	await pageA.locator('#more-packs').click();
	await pageA
		.waitForFunction(
			() => document.querySelectorAll('#extra-list .model-item').length >= 15,
			{ timeout: 60000, polling: 2000 },
		)
		.catch(() => log('!! extra packs list incomplete, screenshot anyway'));
	await sleep(800);
	await pageA.screenshot({ path: path.join(OUT_DIR, '04-options.png') });
	log('saved 04-options.png');
}

await browser.close();
log('DONE');
