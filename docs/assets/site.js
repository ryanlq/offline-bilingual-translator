/* Lightweight bilingual switcher.
   Chinese is the authored default; English strings live next to each element
   in data-en / data-en-html / data-en-content. No framework, no network. */
(function () {
	'use strict';

	var nodes = Array.prototype.slice.call(
		document.querySelectorAll('[data-en], [data-en-html], [data-en-content]'),
	);

	var entries = nodes.map(function (node) {
		var mode = node.hasAttribute('data-en-html')
			? 'html'
			: node.hasAttribute('data-en-content')
				? 'content'
				: 'text';
		return {
			node: node,
			mode: mode,
			zh:
				mode === 'html'
					? node.innerHTML
					: mode === 'content'
						? node.getAttribute('content')
						: node.textContent,
		};
	});

	var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-lang]'));

	function apply(lang) {
		entries.forEach(function (entry) {
			var english =
				entry.mode === 'html'
					? entry.node.getAttribute('data-en-html')
					: entry.mode === 'content'
						? entry.node.getAttribute('data-en-content')
						: entry.node.getAttribute('data-en');
			var value = lang === 'en' && english !== null ? english : entry.zh;

			if (entry.mode === 'html') entry.node.innerHTML = value;
			else if (entry.mode === 'content') entry.node.setAttribute('content', value);
			else entry.node.textContent = value;
		});

		document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
		buttons.forEach(function (button) {
			var active = button.getAttribute('data-lang') === lang;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', active ? 'true' : 'false');
		});

		try {
			localStorage.setItem('obt-site-lang', lang);
		} catch (error) {
			/* private mode: language simply is not persisted */
		}
	}

	buttons.forEach(function (button) {
		button.addEventListener('click', function () {
			apply(button.getAttribute('data-lang') === 'en' ? 'en' : 'zh');
		});
	});

	var saved = null;
	try {
		saved = localStorage.getItem('obt-site-lang');
	} catch (error) {
		/* ignore */
	}

	var browserLang = navigator.language || '';
	apply(saved === 'en' || saved === 'zh' ? saved : /^zh/i.test(browserLang) ? 'zh' : 'en');
})();
