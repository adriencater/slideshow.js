/*!
 * slideshow.js — a tiny, dependency-free lightbox.
 *
 * Mark up images with data-slideshow="group-name" on the <a>, the <img>, or any
 * parent element. Items sharing a name form one slideshow, in document order.
 *
 *   <a data-slideshow="trip" href="big.jpg"><img src="small.jpg" alt="…"></a>
 *   <img data-slideshow="trip" src="photo.jpg" alt="…">
 *   <div data-slideshow="trip"><img src="a.jpg"> <img src="b.jpg"></div>
 *
 * Per-item attributes (on the <a> or <img>):
 *   data-caption="…"          caption text (falls back to the data-slideshow element's
 *                             data-caption — handy on a parent — then the link title, then the img alt)
 *   data-slideshow-src="…"    full-size image URL (falls back to the link href, then the img src)
 *
 * Settings: Slideshow.configure({ … }) — see `options` below.
 * API:      Slideshow.open(nameOrElement, index), .close(), .next(), .prev()
 */
(() => {
	'use strict';

	const options = {
		loop: true,                  // wrap around from last to first image and back
		keyboard: true,              // ← → to navigate, Home / End to jump (Esc always closes)
		swipe: true,                 // swipe left / right on touch screens
		closeOnBackdropClick: true,  // click outside the image to close
		imageAreaClick: true,        // click the left / right third of the image for previous / next
		cursorIcons: true,           // zoom-in cursor on thumbnails, arrow cursors on the image thirds
		showUI: true,                // buttons and counter (Esc, keys, swipe and clicks still work without)
		showCaption: true,
		showCounter: true,
		counterFormat: '{current} / {total}',
		preload: 1,                  // neighbouring images to fetch ahead, in each direction
		labels: {
			dialog: 'Image viewer',
			close: 'Close',
			prev: 'Previous image',
			next: 'Next image',
			error: 'This image could not be loaded.',
		},
		onOpen: null,                // (item, index) => {}
		onChange: null,              // (item, index) => {}
		onClose: null,               // () => {}
	};

	const ATTR = 'data-slideshow';
	const SELECTOR = `[${ATTR}]`;
	const ICONS = {
		close: '<path d="M6 6l12 12M18 6L6 18"/>',
		prev: '<path d="M15 5l-7 7 7 7"/>',
		next: '<path d="M9 5l7 7-7 7"/>',
	};

	let dialog, figure, caption, counter, buttons;
	let items = [];
	let index = 0;
	let loadToken = 0;

	// ---- Collecting items -------------------------------------------------

	function itemFrom(el, root) {
		const link = el.closest('a[href]');
		const img = el.tagName === 'IMG' ? el : el.querySelector('img');
		const data = (key) => el.dataset[key] ?? link?.dataset[key] ?? img?.dataset[key];
		return {
			el: link ?? el,
			src: data('slideshowSrc') ?? link?.href ?? img?.currentSrc ?? img?.src,
			caption: data('caption') ?? root.dataset.caption ?? (link?.title || img?.alt || ''),
			alt: img?.alt ?? '',
		};
	}

	function collect(root) {
		const name = root.getAttribute(ATTR);
		const roots = name ? document.querySelectorAll(`[${ATTR}="${CSS.escape(name)}"]`) : [root];
		const seen = new Set();
		const list = [];
		for (const r of roots) {
			for (const el of r.matches('a, img') ? [r] : r.querySelectorAll('img')) {
				const item = itemFrom(el, r);
				if (item.src && !seen.has(item.el)) {
					seen.add(item.el);
					list.push(item);
				}
			}
		}
		return list;
	}

	// ---- Building the viewer ----------------------------------------------

	function build() {
		dialog = document.createElement('dialog');
		dialog.className = 'slideshow';
		dialog.autofocus = true;
		dialog.innerHTML = `
			<figure class="slideshow-figure">
				<img class="slideshow-image" alt="">
				<figcaption class="slideshow-caption"></figcaption>
			</figure>
			<div class="slideshow-counter" aria-live="polite"></div>
			${Object.entries(ICONS).map(([name, path]) => `
				<button type="button" class="slideshow-${name}" data-action="${name}">
					<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>
				</button>`).join('')}`;

		figure = dialog.querySelector('.slideshow-figure');
		caption = dialog.querySelector('.slideshow-caption');
		counter = dialog.querySelector('.slideshow-counter');
		buttons = Object.fromEntries([...dialog.querySelectorAll('[data-action]')].map((b) => [b.dataset.action, b]));

		let swipeX = null;
		let swiped = false;

		dialog.addEventListener('click', (e) => {
			const action = e.target.closest('[data-action]')?.dataset.action;
			if (action) return api[action]();
			if (swiped) return;
			const dir = areaDirection(e);
			if (dir) return go(index + dir);
			if (options.closeOnBackdropClick && (e.target === dialog || e.target === figure)) close();
		});

		dialog.addEventListener('keydown', (e) => {
			if (!options.keyboard || e.altKey || e.ctrlKey || e.metaKey) return;
			const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: items.length - 1 }[e.key];
			if (target === undefined) return;
			e.preventDefault();
			go(target);
		});

		dialog.addEventListener('pointerdown', (e) => {
			swiped = false;
			swipeX = options.swipe && e.pointerType !== 'mouse' ? e.clientX : null;
		});
		dialog.addEventListener('pointerup', (e) => {
			if (swipeX === null) return;
			const dx = e.clientX - swipeX;
			swipeX = null;
			if (Math.abs(dx) > 50) {
				swiped = true;
				go(index + (dx < 0 ? 1 : -1));
			}
		});
		dialog.addEventListener('pointercancel', () => (swipeX = null));
		dialog.addEventListener('pointermove', (e) => {
			const dir = options.cursorIcons && e.pointerType === 'mouse' ? areaDirection(e) : 0;
			dialog.dataset.area = { '-1': 'prev', 1: 'next' }[dir] ?? '';
		});

		dialog.addEventListener('close', () => {
			loadToken++;
			items = [];
			options.onClose?.();
		});

		document.body.append(dialog);
	}

	function applyLabels() {
		const { labels } = options;
		dialog.setAttribute('aria-label', labels.dialog);
		figure.dataset.error = labels.error;
		for (const [name, button] of Object.entries(buttons)) button.setAttribute('aria-label', labels[name]);
	}

	// -1 / 1 when a click at this spot should go to the previous / next image, 0 otherwise.
	function areaDirection(e) {
		if (!options.imageAreaClick || !e.target.matches('.slideshow-image')) return 0;
		const { left, width } = e.target.getBoundingClientRect();
		const x = (e.clientX - left) / width;
		const dir = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0;
		return dir && wrap(index + dir) !== index ? dir : 0;
	}

	// ---- Showing images ---------------------------------------------------

	function wrap(i) {
		const n = items.length;
		return options.loop ? (i % n + n) % n : Math.min(Math.max(i, 0), n - 1);
	}

	async function go(i) {
		if (!items.length) return;
		i = wrap(i);
		if (i === index) return;
		index = i;
		const item = items[i];
		const token = ++loadToken;
		const n = items.length;

		counter.textContent = options.counterFormat.replace('{current}', i + 1).replace('{total}', n);
		counter.hidden = !options.showCounter || n < 2;
		buttons.prev.hidden = buttons.next.hidden = n < 2;
		buttons.prev.disabled = !options.loop && i === 0;
		buttons.next.disabled = !options.loop && i === n - 1;
		dialog.classList.add('is-loading');
		options.onChange?.(item, i);

		const img = new Image();
		img.className = 'slideshow-image';
		img.alt = item.alt;
		img.src = item.src;
		let failed = false;
		try {
			await img.decode();
		} catch {
			failed = true;
		}
		if (token !== loadToken) return; // the user moved on in the meantime

		figure.querySelector('img').replaceWith(img);
		caption.textContent = item.caption;
		caption.hidden = !options.showCaption || !item.caption;
		dialog.classList.remove('is-loading');
		dialog.classList.toggle('is-error', failed);

		for (let d = 1; d <= options.preload; d++) {
			for (const j of [i + d, i - d]) {
				const near = items[wrap(j)];
				if (near) new Image().src = near.src;
			}
		}
	}

	function show(list, i = 0) {
		if (!list.length) return;
		if (!dialog) build();
		applyLabels();
		dialog.classList.toggle('hide-ui', !options.showUI);
		items = list;
		index = -1;
		if (!dialog.open) {
			figure.querySelector('img').removeAttribute('src');
			dialog.showModal();
			options.onOpen?.(list[wrap(i)], wrap(i));
		}
		go(i);
	}

	function close() {
		dialog?.close();
	}

	// ---- Wiring up the page -----------------------------------------------

	document.addEventListener('click', (e) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const root = e.target.closest?.(SELECTOR);
		if (!root || root.closest('dialog.slideshow')) return;
		const list = collect(root);
		const i = list.findIndex((item) => item.el.contains(e.target));
		if (i < 0) return;
		e.preventDefault();
		show(list, i);
	});

	// Images without a link are not focusable by default: make them keyboard-friendly.
	function enhance() {
		for (const img of document.querySelectorAll(`img${SELECTOR}, ${SELECTOR}:not(a, img) img`)) {
			if (img.closest('a[href]') || img.hasAttribute('tabindex')) continue;
			img.tabIndex = 0;
			img.setAttribute('role', 'button');
		}
	}
	document.addEventListener('keydown', (e) => {
		if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('img[role="button"]') && e.target.closest(SELECTOR)) {
			e.preventDefault();
			e.target.click();
		}
	});
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhance);
	else enhance();

	// ---- Public API -------------------------------------------------------

	const api = {
		options,
		configure(settings = {}) {
			Object.assign(options, settings, { labels: { ...options.labels, ...settings.labels } });
			document.documentElement.classList.toggle('slideshow-no-cursors', !options.cursorIcons);
			return api;
		},
		open(target, i = 0) {
			const root = typeof target === 'string' ? document.querySelector(`[${ATTR}="${CSS.escape(target)}"]`) : target;
			if (root) show(collect(root), i);
		},
		close,
		next: () => go(index + 1),
		prev: () => go(index - 1),
		refresh: enhance,
	};

	window.Slideshow = api;
})();
