/**
 * Chrome Web Store 提交助手（本机 Edge CDP 接管）
 * 用法：node tools/submit-cdp.mjs <命令> [参数]
 *   eval "<js>"            在 devconsole 页面执行 JS（支持 await，返回 JSON）
 *   shot [文件名]           截图到 /tmp/cdp-<名>.png
 *   nav "<url>"             导航
 *   els                    列出页面可交互元素（按钮/输入/下拉/链接的文本+选择器线索）
 *   file <css选择器> <文件>  往 file input 塞文件（可传多个文件，逗号分隔）
 *   click <js>             eval 的别名（语义化用）
 */
const BASE = 'http://127.0.0.1:9222';
const [, , cmd, ...args] = process.argv;

const list = await (await fetch(`${BASE}/json/list`)).json();
const target = process.env.CDP_TARGET
	? list.find((t) => t.id.startsWith(process.env.CDP_TARGET))
	: list.find((t) => t.type === 'page' && t.url.includes('chrome.google.com')) ||
	  list.find((t) => t.type === 'page' && !t.url.startsWith('edge://'));
if (!target) {
	console.error('no page target');
	process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
	ws.onopen = r;
	ws.onerror = j;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
	}
};
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
		ws.send(JSON.stringify({ id, method, params }));
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(js) {
	const r = await send('Runtime.evaluate', {
		expression: js,
		awaitPromise: true,
		returnByValue: true,
		replMode: true,
	});
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
	return r.result?.value;
}

try {
	if (cmd === 'eval') {
		const v = await evalJs(args[0]);
		console.log(JSON.stringify(v, null, 1));
	} else if (cmd === 'nav') {
		await send('Page.enable');
		await send('Page.navigate', { url: args[0] });
		await sleep(4000);
		console.log('navigated, url =', await evalJs('location.href'));
	} else if (cmd === 'shot') {
		await send('Page.enable');
		await sleep(300);
		const r = await send('Page.captureScreenshot', { format: 'png' });
		const fs = await import('node:fs');
		const p = `C:/Users/Administrator/AppData/Local/Temp/cdp-${args[0] || 'shot'}.png`;
		fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
		console.log(p);
	} else if (cmd === 'els') {
		const v = await evalJs(
			"(() => {" +
				"const out = []; const seen = new Set();" +
				"for (const el of document.querySelectorAll('button, input, select, textarea, a[role=button], [role=button], [role=radio], [role=checkbox], [role=tab], [role=combobox], [role=link]')) {" +
				"if (seen.has(el)) continue; seen.add(el);" +
				"const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 50);" +
				"const tag = el.tagName.toLowerCase();" +
				"const type = el.type || el.getAttribute('role') || '';" +
				"const id = el.id ? '#' + el.id : '';" +
				"const testid = el.getAttribute('data-testid') ? '[data-testid=' + el.getAttribute('data-testid') + ']' : '';" +
				"const name = el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '';" +
				"out.push(tag + (type ? ':' + type : '') + id + testid + name + ' | ' + t);" +
				"}" +
				"return out.slice(0, 120);})()",
		);
		console.log(v.join('\n'));
	} else if (cmd === 'file') {
		const [sel, filesArg, idxArg] = args;
		const files = filesArg.split(',').map((f) => f.trim());
		const doc = await send('DOM.getDocument', {});
		let nodeId;
		if (idxArg !== undefined) {
			const { nodeIds } = await send('DOM.querySelectorAll', {
				nodeId: doc.root.nodeId,
				selector: sel,
			});
			nodeId = nodeIds[Number(idxArg)];
		} else {
			({ nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel }));
		}
		if (!nodeId) throw new Error('selector not found: ' + sel + (idxArg !== undefined ? '[' + idxArg + ']' : ''));
		await send('DOM.setFileInputFiles', { files, nodeId });
		console.log(
			'files set on',
			sel,
			idxArg !== undefined ? '[' + idxArg + ']' : '',
			JSON.stringify(files.map((f) => f.split(/[\\/]/).pop())),
		);
	} else if (cmd === 'fill') {
		const [sel, file, idxArg] = args;
		const fs = await import('node:fs');
		const text = fs.readFileSync(file, 'utf8');
		const b64 = Buffer.from(text, 'utf8').toString('base64');
		const pick =
			idxArg !== undefined
				? "document.querySelectorAll('" + sel + "')[" + idxArg + "]"
				: "document.querySelector('" + sel + "')";
		const v = await evalJs(
			"(() => { const el = " + pick + "; if (!el) return 'no el';" +
			"const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0));" +
			"const text = new TextDecoder().decode(bytes);" +
			"const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
			"Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);" +
			"el.dispatchEvent(new Event('input', { bubbles: true }));" +
			"el.dispatchEvent(new Event('change', { bubbles: true }));" +
			"return 'filled ' + el.value.length + ' chars'; })()",
		);
		console.log(JSON.stringify(v));
	} else if (cmd === 'mouse') {
		// mouse click <js返回坐标的表达式>  —— 对 jsaction 组件必须用真实鼠标事件
		await send('Input.insertText' /* noop warmup */, {}).catch(() => {});
		const pos = await evalJs(args[0]);
		if (!pos || typeof pos.x !== 'number') throw new Error('no pos: ' + JSON.stringify(pos));
		for (const type of ['mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', {
				type,
				x: pos.x,
				y: pos.y,
				button: 'left',
				clickCount: 1,
			});
		}
		console.log('clicked', JSON.stringify(pos));
	} else if (cmd === 'dropfile') {
		// dropfile <zone序号> <文件路径>：页面内构造 File，派发 drag/drop 事件到拖放区
		const [zoneArg, file] = args;
		const fs = await import('node:fs');
		const buf = fs.readFileSync(file);
		const b64 = buf.toString('base64');
		const name = file.split(/[\\/]/).pop();
		const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
		const v = await evalJs(
			"(() => { const zones = [...document.querySelectorAll('*')].filter(x => x.childElementCount === 0 && x.innerText && x.innerText.includes('将图片拖放') && x.getBoundingClientRect().height > 5);" +
			"const zone = zones[" + (Number(zoneArg) || 0) + "] || zones[0]; if (!zone) return 'no zone';" +
			"const target = zone.closest('[class*=drop], div[draggable], section') || zone.parentElement;" +
			"const bytes = Uint8Array.from(atob('" + b64 + "'), c => c.charCodeAt(0));" +
			"const f = new File([bytes], '" + name + "', {type: '" + mime + "'});" +
			"const dt = new DataTransfer(); dt.items.add(f);" +
			"for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt}));" +
			"target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));" +
			"target.dispatchEvent(new DragEvent('dragleave', {bubbles: true, cancelable: true, dataTransfer: dt}));" +
			"return 'dropped ' + f.name + ' ' + f.size + 'B on ' + (target.className || target.tagName).toString().slice(0, 40); })()",
		);
		console.log(JSON.stringify(v));
	} else {
		console.error('unknown cmd:', cmd);
		process.exit(2);
	}
} finally {
	ws.close();
}
process.exit(0);
