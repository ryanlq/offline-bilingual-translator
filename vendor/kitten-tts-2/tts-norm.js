/**
 * TTS 文本规范化（移植自 KittenTTS kittenml/kittentts2_tiny/frontend/tts_norm.py，
 * Apache-2.0；上游又源自 Kitten 训练代码）。语义对齐：只改「会被读错」的部分，
 * 句读标点（. , ! ? ; 破折号）保留给模型做韵律。规则顺序敏感：日期/时间先于通用数字。
 */

import { cardinal, ordinal, year } from './num2words.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
	'August', 'September', 'October', 'November', 'December'];

const UNITS = {
	km: 'kilometres', mi: 'miles', cm: 'centimetres', mm: 'millimetres',
	kg: 'kilograms', lb: 'pounds', lbs: 'pounds', oz: 'ounces',
	ml: 'millilitres', l: 'litres', ft: 'feet', in: 'inches',
	hr: 'hours', hrs: 'hours', min: 'minutes', mins: 'minutes',
	sec: 'seconds', secs: 'seconds', ms: 'milliseconds',
	gb: 'gigabytes', mb: 'megabytes', kb: 'kilobytes', tb: 'terabytes',
	hz: 'hertz', khz: 'kilohertz', mhz: 'megahertz', ghz: 'gigahertz',
	kw: 'kilowatts', mph: 'miles per hour', kph: 'kilometres per hour',
};
const MAG = { k: 'thousand', m: 'million', b: 'billion', t: 'trillion' };
const FRACTIONS = { '1/2': 'a half', '1/3': 'a third', '2/3': 'two thirds',
	'1/4': 'a quarter', '3/4': 'three quarters', '1/8': 'an eighth' };
const ABBREV = {
	mr: 'Mister', mrs: 'Missus', ms: 'Miss', dr: 'Doctor',
	prof: 'Professor', rev: 'Reverend', hon: 'Honourable', ext: 'extension',
	approx: 'approximately', vs: 'versus', est: 'estimated', dept: 'department',
	univ: 'university', fig: 'figure', eq: 'equation', ref: 'reference',
	vol: 'volume', incl: 'including', excl: 'excluding', min: 'minimum',
	max: 'maximum', avg: 'average', mt: 'mount', ft: 'fort',
	appt: 'appointment', pp: 'pages', jr: 'Junior', sr: 'Senior',
	inc: 'Incorporated', ltd: 'Limited', corp: 'Corporation',
	mins: 'minutes', hrs: 'hours', wks: 'weeks', yrs: 'years',
};
const DAYS = { Mon: 'Monday', Tue: 'Tuesday', Tues: 'Tuesday', Wed: 'Wednesday',
	Weds: 'Wednesday', Thu: 'Thursday', Thur: 'Thursday', Thurs: 'Thursday',
	Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const MONTHS_ABBR = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April',
	Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Sept: 'September',
	Oct: 'October', Nov: 'November', Dec: 'December' };
const SYMBOLS = { '%': ' percent ', '&': ' and ', '@': ' at ', '+': ' plus ',
	'=': ' equals ', '×': ' times ', '÷': ' divided by ', '<': ' less than ',
	'>': ' greater than ', '~': ' about ', '°': ' degrees ', '€': ' euros ',
	'£': ' pounds ', '¥': ' yen ', '©': ' copyright ', '™': ' trademark ',
	'§': ' section ' };
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9,
	x: 10, xi: 11, xii: 12 };
const ROMAN_CTX = '(?:chapter|section|part|volume|book|act|phase|appendix|world war|type|class|figure|table|step|stage)';

const _card = (n) => cardinal(Math.trunc(n));

function _year(y) {
	if ((y >= 1100 && y <= 1999) || (y >= 2000 && y <= 2099)) return year(y);
	return _card(y);
}

function _keepFinalDot(m, out, s) {
	// am/pm 的可选句点会吞掉句末标点：真处于句末时补回
	if (!m[0].endsWith('.')) return out;
	const rest = s.slice(m.index + m[0].length);
	if (rest.trim() === '' || (/^\s/.test(rest) && /^\s*[A-Z]/.test(rest))) return out + '.';
	return out;
}

function _dates(s) {
	s = s.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m, y, mo, d) => {
		y = +y; mo = +mo; d = +d;
		if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return m;
		return `${MONTHS[mo - 1]} ${ordinal(d)}, ${_year(y)}`;
	});
	s = s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g, (m, a, b, y) => {
		a = +a; b = +b; y = +y;
		if (!(a >= 1 && a <= 12 && b >= 1 && b <= 31)) return m;
		if (y < 100) y += y < 50 ? 2000 : 1900;
		return `${MONTHS[a - 1]} ${ordinal(b)}, ${_year(y)}`;
	});
	s = s.replace(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'),
		(m, mon, d, y) => `${mon} ${ordinal(+d)}, ${_year(+y)}`);
	return s;
}

function _times(s) {
	s = s.replace(/\b(\d{1,2}):(\d{2})(?:\s*([ap]\.?m\.?))?/gi, (m, h, mi, ampm) => {
		h = +h; mi = +mi;
		ampm = (ampm || '').toLowerCase();
		if (h > 23 || mi > 59) return m;
		let suffix = '';
		if (ampm) suffix = ampm.startsWith('a') ? ' AM' : ' PM';
		else if (h === 0) { h = 12; suffix = ' AM'; }
		let spoken;
		if (mi === 0) {
			spoken = suffix
				? `${_card(h <= 12 ? h : h - 12)}`
				: `${_card(h <= 12 || ampm ? h : h)} o'clock`;
		} else if (mi < 10) {
			spoken = suffix
				? `${_card(h <= 12 ? h - 12 || h : h)} oh ${_card(mi)}`
				: `${_card(h)} oh ${_card(mi)}`;
		} else {
			spoken = suffix
				? `${_card(h <= 12 ? h - 12 || h : h)} ${_card(mi)}`
				: `${_card(h)} ${_card(mi)}`;
		}
		return _keepFinalDot(m, spoken + suffix, s);
	});
	return s;
}

function _bareHour(s) {
	return s.replace(/\b(\d{1,2})\s*([ap])\.?m\.?(?![a-z])/gi, (m, h, ap) => {
		h = +h;
		if (!(h >= 1 && h <= 12)) return m;
		return _keepFinalDot(m, `${_card(h)} ${ap.toLowerCase() === 'a' ? 'AM' : 'PM'}`, s);
	});
}

function _phones(s) {
	return s.replace(/\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]?\d{0,4}\b/g, (m) => {
		const digits = m.replace(/\D/g, '');
		if (!(digits.length >= 7 && digits.length <= 11)) return m;
		const groups = [];
		let i = 0;
		if (digits.length === 11 && digits[0] === '1') { groups.push('one'); i = 1; }
		for (const [a, b] of [[i, i + 3], [i + 3, i + 6], [i + 6, digits.length]]) {
			if (a < digits.length) {
				groups.push([...digits.slice(a, b)].map((c) => _card(+c)).join(' '));
			}
		}
		return groups.filter(Boolean).join(', ');
	});
}

function _money(s) {
	return s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?([KkMmBbTt])\b)?/g, (m, amtRaw, suf) => {
		const amt = amtRaw.replace(/,/g, '');
		if (suf) {
			suf = suf.toLowerCase();
			const num = amt.includes('.') ? parseFloat(amt) : parseInt(amt, 10);
			const whole = Number.isInteger(num)
				? _card(num)
				: `${_card(Math.trunc(num))} point ${[...String(amt).split('.')[1]].map((d) => _card(+d)).join(' ')}`;
			return `${whole} ${MAG[suf]} dollars`;
		}
		if (amt.includes('.')) {
			const [dPart, cPart] = amt.split('.', 2);
			const c = (cPart + '00').slice(0, 2);
			const dollars = `${_card(parseInt(dPart, 10))} dollar${parseInt(dPart, 10) === 1 ? '' : 's'}`;
			return parseInt(c, 10)
				? `${dollars} and ${_card(parseInt(c, 10))} cent${parseInt(c, 10) === 1 ? '' : 's'}`
				: dollars;
		}
		const n = parseInt(amt, 10);
		return `${_card(n)} dollar${n === 1 ? '' : 's'}`;
	});
}

function _decimal(tok) {
	tok = tok.replace(/,/g, '');
	if (!/\d/.test(tok)) return tok;
	if (tok.includes('.')) {
		const [a, b] = tok.split('.', 2);
		return `${_card(parseInt(a || '0', 10))} point ${[...b].map((d) => _card(+d)).join(' ')}`;
	}
	return _card(parseInt(tok, 10));
}

function _magnitudes(s) {
	return s.replace(/\b(\d[\d,]*(?:\.\d+)?)\s*([KMBT])\b/g,
		(m, n, mag) => `${_decimal(n)} ${MAG[mag.toLowerCase()]}`);
}

function _fractions(s) {
	return s.replace(/\b(\d{1,3})\/(\d{1,3})\b/g, (m, a, b) => {
		a = +a; b = +b;
		if (FRACTIONS[`${a}/${b}`]) return FRACTIONS[`${a}/${b}`];
		if (b === 0) return m;
		return `${_card(a)} ${ordinal(b)}${a !== 1 ? 's' : ''}`;
	});
}

function _versions(s) {
	return s.replace(/\b(\d+)\.(\d+)\.(\d+)\b/g,
		(m, a, b, c) => [_card(+a), _card(+b), _card(+c)].join(' point '));
}

const UNIT_PATTERN = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');

function _units(s) {
	s = s.replace(new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${UNIT_PATTERN})\\b`, 'gi'),
		(m, n, unit) => {
			const val = _decimal(n);
			let word = UNITS[unit.toLowerCase()];
			if (n.replace(/,/g, '') === '1' || n === '1.0') {
				word = word.endsWith('s') ? word.slice(0, -1) : word;
			}
			return `${val} ${word}`;
		});
	s = s.replace(/([-−]?[\d.]+)\s?°\s?([CF])\b/g, (m, raw, unit) => {
		const neg = raw[0] === '-' || raw[0] === '−';
		const val = _decimal(neg ? raw.slice(1) : raw);
		const scale = unit.toUpperCase() === 'C' ? 'Celsius' : 'Fahrenheit';
		return `${neg ? 'minus ' : ''}${val} degrees ${scale}`;
	});
	return s;
}

function _abbrev(s) {
	s = s.replace(/\bSt\.\s+(?=[A-Z])/g, 'Saint ');
	s = s.replace(/\bSt\.(?=\s*$)/g, 'Street.');
	s = s.replace(/\bSt\.(?=\s*["')])/g, 'Street.');
	s = s.replace(/\bSt\.(?!\s+[A-Z])/g, 'Street');
	s = s.replace(/\bAve\./g, 'Avenue');
	s = s.replace(/\bRd\./g, 'Road');
	s = s.replace(/\bBlvd\./g, 'Boulevard');
	s = s.replace(/\bNo\.\s*(?=\d)/g, 'number ');
	s = s.replace(/\bNos\.\s*(?=\d)/g, 'numbers ');
	for (const [k, v] of { ...DAYS, ...MONTHS_ABBR, ...ABBREV, ...Object.fromEntries(Object.entries(ABBREV).map(([k, v]) => [k, v])) }.entries ? [] : []) {
		void k; void v;
	}
	for (const [k, v] of Object.entries({ ...DAYS, ...MONTHS_ABBR })) {
		s = s.replace(new RegExp(`\\b${k}\\.`, 'g'), v);
	}
	for (const [k, v] of Object.entries(ABBREV)) {
		s = s.replace(new RegExp(`\\b${k}\\.`, 'gi'), v);
	}
	return s;
}

function _romans(s) {
	return s.replace(new RegExp(`\\b(${ROMAN_CTX})\\s+([IVX]{1,4})\\b`, 'gi'),
		(m, ctx, roman) => {
			const lower = roman.toLowerCase();
			return lower in ROMAN ? `${ctx} ${_card(ROMAN[lower])}` : m;
		});
}

function _ordinals(s) {
	return s.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (m, n) => ordinal(+n));
}

function _ranges(s) {
	return s.replace(/\b(\d+)\s?[-–—]\s?(\d+)\b/g,
		(m, a, b) => `${_card(+a)} to ${_card(+b)}`);
}

function _numbers(s) {
	s = s.replace(/(?<![\w.])[-−](\d)/g, 'minus $1');
	return s.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (tok) => {
		if (!tok.includes(',') && /^\d{4}$/.test(tok) && +tok >= 1100 && +tok <= 2099) {
			return _year(+tok);
		}
		return _decimal(tok);
	});
}

export function normalize(text) {
	let s = String(text).normalize('NFKC');
	s = s.replace(/’/g, "'").replace(/‘/g, "'")
		.replace(/[“]/g, '"').replace(/[”]/g, '"')
		.replace(/—/g, ' - ').replace(/[–]/g, '-').replace(/…/g, '...');
	s = s.replace(/https?:\/\/\S+|www\.\S+/g, ' link ');
	s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, ' email address ');
	s = s.replace(/\be\.\s?g\./gi, 'for example,');
	s = s.replace(/\bi\.\s?e\./gi, 'that is,');
	s = s.replace(/\betc\./gi, 'etcetera');
	s = s.replace(/\bvs\.?\b/gi, 'versus');
	s = _dates(s);
	s = _times(s);
	s = _bareHour(s);
	s = _phones(s);
	s = _money(s);
	s = _versions(s);
	s = _fractions(s);
	s = _magnitudes(s);
	s = _units(s);
	s = _abbrev(s);
	s = _romans(s);
	s = _ordinals(s);
	s = _ranges(s);
	for (const [k, v] of Object.entries(SYMBOLS)) s = s.split(k).join(v);
	s = _numbers(s);
	s = s.replace(/:/g, ',');
	s = s.replace(/[_*`^|\\/[\]{}<>]/g, ' ');
	s = s.replace(/\s+([.,!?;])/g, '$1');
	s = s.replace(/([.,!?;])(?=[^\s"',.!?;])/g, '$1 ');
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}
