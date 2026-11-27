/**
 * 选区/文本语言粗判（取舍用，不追求精确）
 * @param {string} text
 * @returns {'zh'|'en'|'ja'|'ko'|null} null 表示无法判断
 */
export function detectTextLang(text) {
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
}
