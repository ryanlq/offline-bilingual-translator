/**
 * Minimal English number-to-words (cardinal / ordinal / year).
 * 输出语义对齐 Python num2words 在本管线用到的三个形态。
 */

const ONES = [
	'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
	'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
	'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALE = ['', ' thousand', ' million', ' billion', ' trillion'];

const ORDINAL_LAST = {
	one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth',
	six: 'sixth', seven: 'seventh', eight: 'eighth', nine: 'ninth', ten: 'tenth',
	eleven: 'eleventh', twelve: 'twelfth', thirteen: 'thirteenth', fourteen: 'fourteenth',
	fifteen: 'fifteenth', sixteen: 'sixteenth', seventeen: 'seventeenth',
	eighteen: 'eighteenth', nineteen: 'nineteenth', twenty: 'twentieth',
	thirty: 'thirtieth', forty: 'fortieth', fifty: 'fiftieth', sixty: 'sixtieth',
	seventy: 'seventieth', eighty: 'eightieth', ninety: 'ninetieth',
	hundred: 'hundredth', thousand: 'thousandth', million: 'millionth',
	billion: 'billionth', trillion: 'trillionth',
};

function under100(n) {
	if (n < 20) return ONES[n];
	const t = TENS[Math.floor(n / 10)];
	const r = n % 10;
	return r ? `${t}-${ONES[r]}` : t;
}

function under1000(n) {
	const h = Math.floor(n / 100);
	const r = n % 100;
	if (!h) return under100(r);
	return r ? `${ONES[h]} hundred ${under100(r)}` : `${ONES[h]} hundred`;
}

export function cardinal(n) {
	n = Math.abs(Math.trunc(n));
	if (n < 1000) return under1000(n);
	const groups = [];
	let rest = n;
	while (rest > 0) {
		groups.push(rest % 1000);
		rest = Math.floor(rest / 1000);
	}
	const parts = [];
	for (let i = groups.length - 1; i >= 0; i--) {
		if (groups[i]) parts.push(`${under1000(groups[i])}${SCALE[i]}`);
	}
	return parts.join(' ');
}

/** 最后一个词转序数："twenty-five" → "twenty-fifth"，"four hundred" → "four hundredth" */
function toOrdinalWords(words) {
	const m = words.match(/^(.*?[\s-])?([A-Za-z]+)$/);
	const last = m ? m[2] : words;
	const prefix = m?.[1] ?? '';
	if (ORDINAL_LAST[last]) return prefix + ORDINAL_LAST[last];
	return words + 'th';
}

export function ordinal(n) {
	return toOrdinalWords(cardinal(n));
}

/**
 * 年份读法：1999 → "nineteen ninety-nine"；2026 → "twenty twenty-six"；
 * 1905 → "nineteen oh five"；1100 → "eleven hundred"；2000 → "two thousand"。
 */
export function year(n) {
	if (n % 100 === 0) {
		return n % 1000 === 0 ? cardinal(n) : `${under100(Math.floor(n / 100))} hundred`;
	}
	const hi = Math.floor(n / 100);
	const lo = n % 100;
	const loWords = lo < 10 ? `oh ${ONES[lo]}` : under100(lo);
	return `${cardinal(hi)} ${loWords}`;
}
