(() => {
    'use strict';

    const ROOT_SELECTOR = '#cfr-root';
    const PANEL_SELECTOR = '#cfr-panel';
    const HIGHLIGHT_NAME = 'chat-find-replace-polish-hits';
    const FALLBACK_MARK_CLASS = 'cfr-fr-polish-hit';

    let boundRoot = null;
    let observedChat = null;
    let chatObserver = null;
    let discoveryObserver = null;
    let scheduled = false;

    const $ = (selector, parent = document) => parent.querySelector(selector);

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function readForm(root) {
        const find = $('#cfr-find', root)?.value ?? '';
        if (!find) return null;

        const regexMode = !!$('#cfr-regex', root)?.checked;
        const flagsInput = $('#cfr-flags', root)?.value?.trim() ?? 'gi';
        const caseSensitive = !!$('#cfr-case-sensitive', root)?.checked;
        let source;
        let flags;

        if (regexMode) {
            source = find;
            flags = flagsInput.replace(/y/g, '');
            if (!flags.includes('g')) flags += 'g';
        } else {
            source = escapeRegExp(find);
            flags = caseSensitive ? 'g' : 'gi';
        }

        try {
            return {
                find,
                regex: new RegExp(source, flags),
                targetUser: $('#cfr-target-user', root)?.checked !== false,
                targetAssistant: $('#cfr-target-assistant', root)?.checked !== false,
                targetSystem: !!$('#cfr-target-system', root)?.checked,
            };
        } catch (_error) {
            return null;
        }
    }

    function currentContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() ?? null;
        } catch (_error) {
            return null;
        }
    }

    function shouldHighlightMessage(messageElement, form) {
        const messageId = Number.parseInt(messageElement.getAttribute('mesid') ?? '', 10);
        const context = currentContext();
        const message = Number.isInteger(messageId) ? context?.chat?.[messageId] : null;

        if (message) {
            if (message.is_user) return form.targetUser;
            if (message.is_system || message.extra?.isSmallSys) return form.targetSystem;
            return form.targetAssistant;
        }

        // DOM fallback for unusual SillyTavern builds without message context.
        if (messageElement.getAttribute('is_user') === 'true' || messageElement.classList.contains('user_mes')) {
            return form.targetUser;
        }
        if (messageElement.getAttribute('is_system') === 'true' || messageElement.classList.contains('system_mes')) {
            return form.targetSystem;
        }
        return form.targetAssistant;
    }

    function clearHighlights() {
        try {
            globalThis.CSS?.highlights?.delete(HIGHLIGHT_NAME);
        } catch (_error) {
            // The fallback markers below still get cleared on browsers without CSS Highlights.
        }

        const marks = document.querySelectorAll(`#chat mark.${FALLBACK_MARK_CLASS}`);
        const touchedParents = new Set();
        for (const mark of marks) {
            const parent = mark.parentNode;
            if (!parent) continue;
            touchedParents.add(parent);
            mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
        }
        for (const parent of touchedParents) parent.normalize?.();
    }

    function isExcludedTextNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return true;
        return !!parent.closest([
            'script', 'style', 'textarea', 'input', 'button', 'select',
            '[contenteditable="true"]',
            `mark.${FALLBACK_MARK_CLASS}`,
            '.mes_reasoning', '.mes_reasoning_details', 'details > summary',
        ].join(','));
    }

    function collectRanges(container, regex) {
        const ranges = [];
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isExcludedTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });

        let node;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue ?? '';
            const localRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
            let match;
            while ((match = localRegex.exec(text)) !== null) {
                if (match[0].length === 0) {
                    // Empty-width regex matches count for replacement, but have no visible text to highlight.
                    if (localRegex.lastIndex <= match.index) localRegex.lastIndex = match.index + 1;
                    continue;
                }
                try {
                    const range = document.createRange();
                    range.setStart(node, match.index);
                    range.setEnd(node, match.index + match[0].length);
                    ranges.push(range);
                } catch (_error) {
                    // A live re-render can detach a node during the scan. Ignore that individual range.
                }
            }
        }
        return ranges;
    }

    function fallbackHighlightTextNode(node, regex) {
        const text = node.nodeValue ?? '';
        const matcher = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let hasMatch = false;
        let match;

        while ((match = matcher.exec(text)) !== null) {
            if (!match[0].length) {
                if (matcher.lastIndex <= match.index) matcher.lastIndex = match.index + 1;
                continue;
            }
            hasMatch = true;
            if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
            const mark = document.createElement('mark');
            mark.className = FALLBACK_MARK_CLASS;
            mark.textContent = match[0];
            fragment.append(mark);
            cursor = match.index + match[0].length;
        }

        if (!hasMatch) return false;
        if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
        node.replaceWith(fragment);
        return true;
    }

    function fallbackHighlight(container, regex) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isExcludedTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);
        for (const textNode of textNodes) fallbackHighlightTextNode(textNode, regex);
    }

    function panelIsOpen(root) {
        const panel = $(PANEL_SELECTOR, root);
        return !!panel && !panel.hidden && panel.getAttribute('aria-hidden') !== 'true';
    }

    function refreshHighlights() {
        scheduled = false;
        const root = document.querySelector(ROOT_SELECTOR);
        if (!root || !panelIsOpen(root)) {
            clearHighlights();
            return;
        }

        const form = readForm(root);
        if (!form) {
            clearHighlights();
            return;
        }

        const messages = document.querySelectorAll('#chat .mes[mesid]');
        const containers = [];
        for (const message of messages) {
            if (!shouldHighlightMessage(message, form)) continue;
            const textContainer = $('.mes_text', message);
            if (!textContainer) continue;
            // Keep the editor surface and its source mode free of decoration.
            if (message.matches('.sme-editing') || textContainer.querySelector('[contenteditable="true"]')) continue;
            containers.push(textContainer);
        }

        clearHighlights();
        if (!containers.length) return;

        if (globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function') {
            const ranges = [];
            for (const container of containers) ranges.push(...collectRanges(container, form.regex));
            if (ranges.length) {
                try {
                    globalThis.CSS.highlights.set(HIGHLIGHT_NAME, new globalThis.Highlight(...ranges));
                } catch (_error) {
                    // Use DOM markers as a compatibility fallback if the CSS Highlight API rejects a range.
                    globalThis.CSS.highlights.delete(HIGHLIGHT_NAME);
                    for (const container of containers) fallbackHighlight(container, form.regex);
                }
            }
        } else {
            for (const container of containers) fallbackHighlight(container, form.regex);
        }
    }

    function scheduleRefresh() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(refreshHighlights);
    }

    function bindRoot(root) {
        if (boundRoot === root) return;
        boundRoot = root;
        root.addEventListener('input', event => {
            if (event.target?.matches?.('#cfr-find, #cfr-flags')) scheduleRefresh();
        });
        root.addEventListener('change', event => {
            if (event.target?.matches?.('#cfr-regex, #cfr-case-sensitive, #cfr-target-user, #cfr-target-assistant, #cfr-target-system')) {
                scheduleRefresh();
            }
        });

        const panelObserver = new MutationObserver(records => {
            if (records.some(record => record.attributeName === 'hidden' || record.attributeName === 'aria-hidden')) {
                scheduleRefresh();
            }
        });
        panelObserver.observe(root, { attributes: true, subtree: true, attributeFilter: ['hidden', 'aria-hidden'] });
        scheduleRefresh();
    }

    function isOwnFallbackMutation(record) {
        if (record.type !== 'childList') return false;
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (!changed.length) return false;
        return changed.every(node => {
            if (node.nodeType === Node.TEXT_NODE) return true;
            return node.nodeType === Node.ELEMENT_NODE && node.matches?.(`mark.${FALLBACK_MARK_CLASS}`);
        });
    }

    function bindChat(chatElement) {
        if (observedChat === chatElement) return;
        chatObserver?.disconnect();
        observedChat = chatElement;
        chatObserver = new MutationObserver(records => {
            if (records.some(record => !isOwnFallbackMutation(record))) scheduleRefresh();
        });
        chatObserver.observe(chatElement, { childList: true, subtree: true });
        scheduleRefresh();
    }

    function discover() {
        const root = document.querySelector(ROOT_SELECTOR);
        if (root) bindRoot(root);
        const chat = document.getElementById('chat');
        if (chat) bindChat(chat);
    }

    function initialize() {
        discover();
        if (discoveryObserver || !document.documentElement) return;
        discoveryObserver = new MutationObserver(discover);
        discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
