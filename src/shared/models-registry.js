/**
 * 模型注册表
 *
 * 数据来源：
 * - en↔zh：Mozilla Remote Settings（Firefox 翻译功能的官方模型分发渠道，
 *   附件 CDN：firefox-settings-attachments.cdn.mozilla.net，带 sha256 校验）
 * - 其他语言对：Bergamot 官方模型仓库
 *   （https://bergamot.s3.amazonaws.com/models/index.json，运行时拉取并缓存）
 *
 * 注意：enzh 模型必须禁用 shortlist（skipLex: true），否则中文 lex 表与
 * 文档级 shortlisting 冲突导致译文质量问题（mozilla 官方评测配置已注释掉
 * shortlist，见 firefox-translations-training issue #215）。
 *
 * 模型许可：CC-BY 等，逐个见 models 仓库 / "关于"页署名。
 */

const ATTACHMENT_CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const REMOTE_SETTINGS_RECORDS =
	'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';

/** Bergamot 官方模型注册表地址（「更多语言包」的数据源） */
export const S3_REGISTRY_URL = 'https://bergamot.s3.amazonaws.com/models/index.json';

/** 索引中每条文件的合法前缀（避免索引被篡改后指向任意主机） */
export const S3_MODEL_PREFIX = 'https://bergamot.s3.amazonaws.com/models/';

/** 语言代码 → 中文显示名（仅覆盖官方仓库现有语言对） */
export const LANGUAGE_NAMES = {
	en: '英语',
	zh: '中文',
	fr: '法语',
	de: '德语',
	it: '意大利语',
	pt: '葡萄牙语',
	ru: '俄语',
	cs: '捷克语',
	es: '西班牙语',
	et: '爱沙尼亚语',
	bg: '保加利亚语',
	uk: '乌克兰语',
};

/** 索引里允许出现的模型部件（其余字段如 config 单独处理） */
const MODEL_PARTS = ['model', 'vocab', 'srcvocab', 'trgvocab', 'lex'];

/**
 * 把 S3 索引的一条记录转换成 BUILTIN_MODELS 同结构的模型元数据。
 * 纯函数，便于在 Node 里对真实索引做校验（tools/verify-language-packs.mjs）。
 *
 * 索引字段形如：
 *   { name: "<完整 URL>", size: 17140835, expectedSha256Hash: "<64 hex>" }
 * 而引擎侧需要 { part, name, url, size, sha256 }。
 *
 * @param {string} key 四字母语言对，如 'ende'
 * @param {object} entry S3 索引中的单条记录
 * @returns {{key:string,from:string,to:string,label:string,version:string,skipLex:boolean,config?:object,files:object}}
 */
export function buildExtraModel(key, entry) {
	if (!/^[a-z]{4}$/.test(key)) throw new Error(`非法语言对键: ${key}`);
	if (!entry || typeof entry !== 'object') throw new Error(`语言包 ${key} 记录为空`);

	const files = {};
	for (const part of MODEL_PARTS) {
		const spec = entry[part];
		if (!spec) continue;
		const { name, size, expectedSha256Hash } = spec;
		if (typeof name !== 'string' || !name.startsWith(S3_MODEL_PREFIX)) {
			throw new Error(`语言包 ${key}.${part} 的地址不在 Bergamot 官方仓库`);
		}
		if (!/^[a-f0-9]{64}$/i.test(expectedSha256Hash || '')) {
			throw new Error(`语言包 ${key}.${part} 缺少合法的 sha256`);
		}
		files[part] = {
			part,
			name: name.slice(name.lastIndexOf('/') + 1),
			url: name,
			size: Number(size) || 0,
			sha256: expectedSha256Hash,
		};
	}

	if (!files.model) throw new Error(`语言包 ${key} 缺少模型文件`);
	if (!files.vocab && !(files.srcvocab && files.trgvocab)) {
		throw new Error(`语言包 ${key} 缺少词表`);
	}

	const from = key.slice(0, 2);
	const to = key.slice(2);
	return {
		key,
		from,
		to,
		label: `${LANGUAGE_NAMES[from] || from} → ${LANGUAGE_NAMES[to] || to}`,
		version: 'bergamot',
		skipLex: false,
		// 少数模型（uken/enuk）需要覆盖 gemm-precision
		...(entry.config && typeof entry.config === 'object' ? { config: entry.config } : {}),
		files,
	};
}

/**
 * 转换整个索引；跳过不合规格的记录，保证单个坏条目不影响列表展示。
 * @param {object} index S3 index.json 的原始内容
 */
export function buildExtraRegistry(index) {
	if (!index || typeof index !== 'object' || Array.isArray(index)) return {};
	const registry = {};
	for (const [key, entry] of Object.entries(index)) {
		try {
			registry[key] = buildExtraModel(key, entry);
		} catch {
			/* 忽略不合规条目 */
		}
	}
	return registry;
}

/** Remote Settings 附件基地址（供语言包刷新使用） */
export const REMOTE_SETTINGS = { ATTACHMENT_CDN, REMOTE_SETTINGS_RECORDS };

/**
 * 内置中英模型（首次使用引导下载）
 * version 2.2 (enzh) / 2.1 (zhen)，sha256 为解压后（即原始）文件摘要
 */
export const BUILTIN_MODELS = {
	enzh: {
		key: 'enzh',
		from: 'en',
		to: 'zh',
		label: '英语 → 中文',
		version: '2.2',
		skipLex: true, // enzh 必须禁用 shortlist
		files: {
			model: {
				part: 'model',
				name: 'model.enzh.intgemm.alphas.bin',
				size: 43849787,
				sha256: '4e5accc141373565ddc8fa1565bceaa8d0c3482a82cab8131c719ebcc6c2157c',
				url:
					ATTACHMENT_CDN +
					'main-workspace/translations-models/a7ff7d5e-e67e-406c-a34b-a7edea35b10e.bin',
			},
			srcvocab: {
				part: 'srcvocab',
				name: 'srcvocab.enzh.spm',
				size: 806952,
				sha256: 'bd9b65504acc6d9726dd281f7defc2adb7c2c22d0688fe2f84697de25197c8c5',
				url:
					ATTACHMENT_CDN +
					'main-workspace/translations-models/ea98c52c-58dc-45d5-af23-38f2b029d020.spm',
			},
			trgvocab: {
				part: 'trgvocab',
				name: 'trgvocab.enzh.spm',
				size: 772004,
				sha256: 'aded6993c36e440284d11cec3f6b8aef9c0e43188a772d80be342a713adf223d',
				url:
					ATTACHMENT_CDN +
					'main-workspace/translations-models/bddbda68-d4d2-4317-a0a1-119caa47525e.spm',
			},
		},
	},
	zhen: {
		key: 'zhen',
		from: 'zh',
		to: 'en',
		label: '中文 → 英语',
		version: '2.1',
		skipLex: false,
		files: {
			model: {
				part: 'model',
				name: 'model.zhen.intgemm.alphas.bin',
				size: 43977787,
				sha256: '5cd149601802fc8a18124a1c1306144dbbedc058630c4ddb2d53aa76fa9c7c06',
				url:
					ATTACHMENT_CDN +
					'main-workspace/translations-models/715efbde-c974-4696-981a-83c0c5f82ad5.bin',
			},
			vocab: {
				part: 'vocab',
				name: 'vocab.zhen.spm',
				size: 1359697,
				sha256: 'dff594318ab7d8b7b60b844ab98ebe6b932ae8045fab15235404c787715965b3',
				url:
					ATTACHMENT_CDN +
					'main-workspace/translations-models/17ff5d42-6d4c-42f8-ad3c-b8042b5bafa7.spm',
			},
			lex: {
				part: 'lex',
				name: 'lex.50.50.zhen.s2t.bin',
				size: 9219192,
				sha256: '8524dd4c93ffd7f0ae7be32f77a7c14fea7cdbbebe34ea6ad0ec368d5ddd8b13',
				url:
					ATTACHMENT_CDN +
					'main-workspace/translations-models/ae5f53d2-59ec-4aad-944d-999e50d6a65c.bin',
			},
		},
	},
};

/**
 * OCR 语言数据（Tesseract.js）
 * 默认使用 tesseract.js 官方 tessdata 镜像，下载后缓存于 IndexedDB；
 * 可在设置中更换为自建 langPath。
 */
export const OCR_LANGUAGES = {
	eng: { code: 'eng', label: '英语', approxSize: '约 11 MB' },
	chi_sim: { code: 'chi_sim', label: '简体中文', approxSize: '约 23 MB' },
};

export const DEFAULT_OCR_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
