// Firefox e2e（xvfb + xdotool + selenium）：
// 临时加载扩展 → xdotool 导航进选项页 → UI 下载模型 → 双语翻译 → 划词 → 截图
import seleniumPkg from 'selenium-webdriver';
const { Builder } = seleniumPkg;
import inputMod from 'selenium-webdriver/lib/input.js';
const { Actions } = inputMod;
import firefoxMod from 'selenium-webdriver/firefox.js';
const firefox = firefoxMod.default || firefoxMod;
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const DRIVER = '/data/home/obt-shots/geckodriver';
const XPI = '/data/home/obt-shots/ff.zip';
const OUT = '/data/home/obt-shots/out-ff';
const ADDON_ID = 'offline-bilingual-translator@ryanlq.dev';
const FIXED_UUID = '7c3e1d2a-5b8f-4e69-9a2c-d14f8b6e5a70';
const OPT_URL = `moz-extension://${FIXED_UUID}/src/options/index.html`;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const service = new firefox.ServiceBuilder(DRIVER);
const options = new firefox.Options();
options.addArguments('-width=1280', '-height=920');
options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: FIXED_UUID }));

// 无 WM 时窗口无输入焦点，xdotool 键盘事件不可用：先启动 openbox 管理焦点
execSync(`${process.env.DISPLAY ? `DISPLAY=${process.env.DISPLAY}` : ''} openbox &`, {
	stdio: 'ignore',
	shell: '/bin/sh',
});
await sleep(1200);

const driver = await new Builder()
	.forBrowser('firefox')
	.setFirefoxService(service)
	.setFirefoxOptions(options)
	.build();

const xdo = (cmd) => execSync(`xdotool ${cmd}`, { encoding: 'utf8' });
function xdoNav(url) {
	// 真实浏览器窗口标题以 “— Mozilla Firefox” 结尾；隐藏辅助窗口名为 “Firefox”，需排除
	let wid = xdo('search --name "Mozilla Firefox" 2>/dev/null | tail -1').trim();
	if (!wid) throw new Error('firefox window not found on display');
	xdo(`windowactivate ${wid} 2>/dev/null || true`);
	sleep(400);
	xdo(`key --window ${wid} ctrl+l`);
	sleep(300);
	xdo(`type --window ${wid} --delay 10 '${url}'`);
	sleep(250);
	xdo(`key --window ${wid} Return`);
}

try {
	log('[1] 安装扩展（临时）...');
	await driver.installAddon(XPI, true);
	log('    installed');
	await sleep(2000);

	// 初始导航：xdotool 真键（geckodriver 禁 moz-extension 导航）
	log('[2] xdotool 导航进选项页...');
	await xdoNav(OPT_URL);
	await sleep(4000);

	// 此时 Selenium 当前句柄即选项页；等待模型列表渲染
	let ready = false;
	for (let i = 0; i < 20 && !ready; i++) {
		ready = await driver.executeScript(
			"return !!document.querySelector('#model-list .model-item');",
		).catch(() => false);
		if (!ready) await sleep(1500);
	}
	if (!ready) {
		const dbg = await driver.executeScript(
			'const ping = chrome.runtime.sendMessage({channel:"rpc:call:offscreen:ping", id:"d1", payload:null}).then((r) => JSON.stringify(r).slice(0,60)).catch((e) => "ERR:" + e.message); const ml = chrome.runtime.sendMessage({channel:"rpc:call:models:list", id:"d2", payload:{}}).then((r) => JSON.stringify(r).slice(0, 200)).catch((e) => "ERR:" + e.message); return Promise.all([ping, ml]).then(([p, m]) => ({ ping: p, ml: m }));',
		).catch((e) => 'ERR:' + e.message);
		console.log('    DEBUG:', JSON.stringify(dbg));
		throw new Error('选项页未就绪');
	}
	log('    选项页就绪');

	// 点第一个"下载"按钮，等两个内置模型就绪
	log('[3] 下载模型（真实 UI 按钮）...');
	const clickState = await driver.executeScript(`
		const btns = [...document.querySelectorAll('#model-list .model-item button.primary')];
		if (!btns.length) return 'no btn';
		let clicked = 0;
		for (const b of btns) if (b.textContent.trim() === '下载') { b.click(); clicked++; }
		return clicked > 0 ? 'clicked ' + clicked : 'already all';
	`);
	log('   ', clickState);
	let okCount = 0;
	for (let i = 0; i < 150 && okCount < 2; i++) {
		await sleep(4000);
		okCount = await driver.executeScript(
			"return (document.querySelector('#model-list').innerText.match(/已就绪/g) || []).length;",
		);
		if (i % 5 === 0) log(`    models ready: ${okCount}/2`);
	}
	if (okCount < 2) throw new Error('模型下载超时');
	log('    models ready');

	// 从选项页开新标签到维基百科（扩展 API，免 xdotool）
	log('[4] 开维基页并触发双语翻译...');
	const wikiOpened = await driver.executeScript(`
		return chrome.tabs.create({ url: 'https://en.wikipedia.org/wiki/Machine_translation', active: true }).then((tab) => 'tab ' + tab.id);
	`);
	log('   ', wikiOpened);
	await sleep(6000);
	// 切到 wiki 句柄
	const handles = await driver.getAllWindowHandles();
	let wikiH = null;
	let optH = null;
	for (const h of handles) {
		await driver.switchTo().window(h);
		const u = await driver.executeScript('return location.href;').catch(() => '');
		if (u.includes('wikipedia')) wikiH = h;
		if (u.includes('options/index.html')) optH = h;
	}
	if (!wikiH || !optH) throw new Error(`handles: wiki=${!!wikiH} opt=${!!optH}`);
	await driver.switchTo().window(wikiH);
	await driver.wait(
		async () => (await driver.executeScript('return document.readyState;')) === 'complete',
		120000,
	);
	await driver.sleep(2500);

	// 从选项页发 toggle 到 wiki 标签（弹窗按钮同路径）
	await driver.switchTo().window(optH);
	// Firefox 的 executeScript 不支持顶层 await，统一用 Promise 链
	const sent = await driver.executeScript(`
		return chrome.tabs
			.query({ url: '*://en.wikipedia.org/*' })
			.then((tabs) => {
				if (!tabs.length) throw new Error('wiki tab not found');
				return chrome.tabs.sendMessage(tabs[0].id, { type: 'command:togglePageTranslation' });
			})
			.then(() => 'toggle sent');
	`);
	log('   ', sent);

	// 等译文注入且稳定
	await driver.switchTo().window(wikiH);
	const start = Date.now();
	let last = -1;
	let stableSince = 0;
	let blocks = 0;
	while (Date.now() - start < 300000) {
		blocks = await driver.executeScript(
			"return document.querySelectorAll('[data-obt-original]').length;",
		);
		if (blocks === last && blocks >= 8 && Date.now() - stableSince > 4000) break;
		if (blocks !== last) {
			last = blocks;
			stableSince = Date.now();
		}
		await sleep(1500);
	}
	log('    translated blocks:', blocks);
	await sleep(1500);
	fs.writeFileSync(`${OUT}/ff-01-bilingual.png`, await driver.takeScreenshot(), 'base64');
	log('    saved ff-01-bilingual.png');

	// 划词：关页面翻译 → 拖选 → 等弹窗
	log('[5] 划词翻译...');
	await driver.switchTo().window(optH);
	await driver.executeScript(`
		return chrome.tabs
			.query({ url: '*://en.wikipedia.org/*' })
			.then((tabs) => chrome.tabs.sendMessage(tabs[0].id, { type: 'command:togglePageTranslation' }))
			.then(() => 'off');
	`);
	await driver.switchTo().window(wikiH);
	await sleep(1500);
	const rect = await driver.executeScript(`
		const ps = [...document.querySelectorAll('#mw-content-text p')].filter((p) => {
			const r = p.getBoundingClientRect();
			return r.y > 90 && r.y < 700 && r.width > 300 && p.offsetHeight > 30;
		});
		if (!ps.length) return null;
		const r = ps[0].getBoundingClientRect();
		return { x: Math.round(r.x + 10), y: Math.round(r.y + 14), w: Math.round(r.width * 0.6), y2: Math.round(r.y + 32) };
	`);
	if (rect) {
		await new Actions(driver)
			.move({ x: rect.x, y: rect.y })
			.press()
			.move({ x: rect.x + rect.w, y: rect.y2 })
			.release()
			.perform();
		let hasPopup = false;
		for (let i = 0; i < 30 && !hasPopup; i++) {
			hasPopup = await driver.executeScript(
				"return !!document.querySelector('[data-obt-select-popup]');",
			);
			if (!hasPopup) await sleep(1000);
		}
		if (hasPopup) {
			await sleep(2500);
			const pr = await driver.executeScript(`
				const el = document.querySelector('[data-obt-select-popup]');
				const r = el.getBoundingClientRect();
				return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vh: innerHeight, sel: String(getSelection()).length };
			`);
			log('    popup rect:', JSON.stringify(pr));
			fs.writeFileSync(`${OUT}/ff-02-selection.png`, await driver.takeScreenshot(), 'base64');
			log('    saved ff-02-selection.png');
		} else {
			log('    !! select popup not shown');
		}
	}

	log('DONE');
} finally {
	await driver.quit();
}
