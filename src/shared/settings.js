/**
 * 设置读写（扩展页面用：popup / options）
 * 内容脚本侧的相同实现在 src/content/shared.js（经典脚本）
 */

const DEFAULT_SETTINGS = {
	fontSize: 14,
	textColor: '#8b8b8b',
	backgroundColor: 'transparent',
	hoverHighlight: true,
	translateDirection: 'auto',
	selectTranslateEnabled: true, // 划词翻译开关
	excludeSelectors: [],
	ocrLangs: 'eng',
	ocrFrom: 'en',
	ocrTo: 'zh',
	ocrLangPath: '',
};

export async function getSettings() {
	const { settings } = await chrome.storage.local.get('settings');
	return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
	const settings = { ...(await getSettings()), ...patch };
	await chrome.storage.local.set({ settings });
	return settings;
}

export { DEFAULT_SETTINGS };
