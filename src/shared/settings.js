/**
 * 设置读写（扩展页面用：popup / options）
 * 内容脚本侧的相同实现在 src/content/shared.js（经典脚本）
 */

const DEFAULT_SETTINGS = {
	fontSize: 14,
	textColor: '#060606',
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

const LEGACY_TEXT_COLOR = '#8b8b8b'; // 旧版默认灰：静默迁移到新默认

export async function getSettings() {
	const { settings } = await chrome.storage.local.get('settings');
	const merged = { ...DEFAULT_SETTINGS, ...settings };
	if (merged.textColor === LEGACY_TEXT_COLOR) merged.textColor = DEFAULT_SETTINGS.textColor;
	return merged;
}

export async function saveSettings(patch) {
	const settings = { ...(await getSettings()), ...patch };
	await chrome.storage.local.set({ settings });
	return settings;
}

export { DEFAULT_SETTINGS };
