(() => {
    'use strict';

    const MODULE = 'Chat Find & Replace';
    const SETTINGS_KEY = 'chat_find_replace';
    const ROOT_ID = 'cfr-root';
    const DEFAULTS = {
        savedRules: [],
        lastUsed: {
            find: '',
            replace: '',
            regexMode: false,
            flags: 'gi',
            caseSensitive: false,
            targetUser: true,
            targetAssistant: true,
            targetSystem: false,
            includeAlternateSwipes: false,
        },
    };

    let context;
    let root;
    let panel;
    let previewTimer;
    let nextSearchAfter = -1;
    let lastValidPlan = null;
    let initialized = false;
    let launcherElement = null;
    let initializationAttempts = 0;
    let highlightFrame = 0;
    let highlightChatElement = null;
    let highlightChatObserver = null;
    let highlightDiscoveryObserver = null;

    // The launcher is deliberately moved out of #cfr-root into SillyTavern's
    // composer. Query the extension root first, then fall back to the document
    // for that one external control (and any future composer-mounted controls).
    const $ = (selector, parent) => {
        const scope = parent ?? root;
        return scope?.querySelector(selector) ?? document.querySelector(selector) ?? null;
    };

    function log(...args) {
        console.debug(`[${MODULE}]`, ...args);
    }

    function getSettings() {
        if (!context.extensionSettings[SETTINGS_KEY]) {
            context.extensionSettings[SETTINGS_KEY] = typeof structuredClone === 'function'
                ? structuredClone(DEFAULTS)
                : JSON.parse(JSON.stringify(DEFAULTS));
        }
        const stored = context.extensionSettings[SETTINGS_KEY];
        stored.savedRules = Array.isArray(stored.savedRules) ? stored.savedRules : [];
        stored.lastUsed = { ...DEFAULTS.lastUsed, ...(stored.lastUsed || {}) };
        return stored;
    }

    function saveSettings() {
        context.saveSettingsDebounced?.();
    }

    function notify(kind, message, title = '') {
        const toast = globalThis.toastr;
        if (toast && typeof toast[kind] === 'function') {
            toast[kind](message, title || MODULE);
        } else {
            console[kind === 'error' ? 'error' : 'log'](`[${MODULE}] ${message}`);
        }
    }

    function buildUI() {
        if (document.getElementById(ROOT_ID)) {
            root = document.getElementById(ROOT_ID);
            panel = $('#cfr-panel', root);
            launcherElement = document.getElementById('cfr-launcher') || $('#cfr-launcher', root);
            if (!launcherElement) {
                launcherElement = createLauncherElement();
                root.prepend(launcherElement);
            }
            ensureComposerLauncher();
            return;
        }

        root = document.createElement('div');
        root.id = ROOT_ID;
        root.innerHTML = `
            <button type="button" id="cfr-launcher" class="cfr-launcher" aria-label="Open Find and Replace" aria-expanded="false" aria-controls="cfr-panel" title="Find and Replace (Ctrl+Shift+F)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 5 5"></path></svg>
                <span>Find &amp; Replace</span>
            </button>
            <section id="cfr-panel" class="cfr-panel" role="region" aria-label="Find and replace chat messages" aria-hidden="true" hidden>
                <header class="cfr-header">
                    <div class="cfr-heading">
                        <span class="cfr-heading-icon" aria-hidden="true">⌕</span>
                        <div><strong>Find &amp; Replace</strong><small>Search and edit this chat</small></div>
                    </div>
                    <div class="cfr-header-actions">
                        <button type="button" class="cfr-icon-button" data-cfr-action="minimize" title="Minimize panel" aria-label="Minimize panel">−</button>
                        <button type="button" class="cfr-icon-button" data-cfr-action="close" title="Close panel" aria-label="Close panel">×</button>
                    </div>
                </header>
                <div class="cfr-content">
                    <label class="cfr-field"><span>Find</span><input id="cfr-find" type="text" autocomplete="off" spellcheck="false" placeholder="Text or regular expression"></label>
                    <label class="cfr-field"><span>Replace with</span><input id="cfr-replace" type="text" autocomplete="off" spellcheck="false" placeholder="Replacement text"></label>

                    <div class="cfr-inline-options">
                        <label class="cfr-toggle"><input id="cfr-regex" type="checkbox"><span class="cfr-switch" aria-hidden="true"></span><span>Regex mode</span><span class="cfr-tag">Advanced</span></label>
                        <span class="cfr-subtle">Literal search by default</span>
                    </div>
                    <div id="cfr-regex-options" class="cfr-regex-options" hidden>
                        <label class="cfr-flags-field"><span>Flags</span><input id="cfr-flags" type="text" value="gi" maxlength="8" spellcheck="false" autocomplete="off" aria-describedby="cfr-flags-help"></label>
                        <small id="cfr-flags-help">Global replacement is always enabled. Common flags: i, m, s, u.</small>
                    </div>

                    <div class="cfr-role-heading"><span>Apply to</span><span class="cfr-subtle">Choose message roles</span></div>
                    <div class="cfr-role-options">
                        <label class="cfr-role-chip"><input id="cfr-target-user" type="checkbox" checked><span class="cfr-role-dot cfr-user-dot"></span><span>User</span></label>
                        <label class="cfr-role-chip"><input id="cfr-target-assistant" type="checkbox" checked><span class="cfr-role-dot cfr-assistant-dot"></span><span>AI</span></label>
                    </div>

                    <details class="cfr-advanced">
                        <summary>More options &amp; saved rules</summary>
                        <div class="cfr-advanced-content">
                            <label class="cfr-check-row"><input id="cfr-case-sensitive" type="checkbox"><span>Case-sensitive literal search</span></label>
                            <label class="cfr-check-row"><input id="cfr-target-system" type="checkbox"><span>Include system and note messages</span></label>
                            <label class="cfr-check-row"><input id="cfr-alt-swipes" type="checkbox"><span>Include alternate AI swipes</span></label>
                            <p class="cfr-help">Alternate swipes are optional. When off, only the currently active message text is changed.</p>
                            <div class="cfr-saved-heading">Saved rules</div>
                            <div class="cfr-save-rule-row">
                                <input id="cfr-rule-name" type="text" maxlength="64" placeholder="Name this rule" aria-label="Saved rule name">
                                <button type="button" class="cfr-button cfr-button-secondary" data-cfr-action="save-rule">Save rule</button>
                            </div>
                            <div class="cfr-load-rule-row">
                                <select id="cfr-saved-rules" aria-label="Saved rules"><option value="">Choose a saved rule…</option></select>
                                <button type="button" class="cfr-button cfr-button-secondary" data-cfr-action="load-rule">Load</button>
                                <button type="button" class="cfr-button cfr-button-danger-quiet" data-cfr-action="delete-rule" title="Delete selected saved rule" aria-label="Delete selected saved rule">×</button>
                            </div>
                        </div>
                    </details>

                    <div id="cfr-status" class="cfr-status" role="status" aria-live="polite">Enter a search term to preview matches.</div>
                    <div class="cfr-actions">
                        <button type="button" class="cfr-button cfr-button-secondary" data-cfr-action="find-next" title="Jump to the next matching message">Find next</button>
                        <button type="button" class="cfr-button cfr-button-primary" data-cfr-action="replace-all">Replace in chat</button>
                    </div>
                    <p class="cfr-footnote">Your message text is updated in chat history. SillyTavern reapplies its normal formatting and Regex rules.</p>
                </div>
            </section>`;
        document.body.append(root);
        launcherElement = $('#cfr-launcher', root);
        panel = $('#cfr-panel', root);
        ensureComposerLauncher();
        restoreLastUsed();
        populateSavedRules();
        bindUI();
        updateModeUI();
        refreshPreview();
        scheduleHighlightRefresh();
    }

    let composerObserver;
    let composerPlacementScheduled = false;

    function createLauncherElement() {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'cfr-launcher';
        button.className = 'cfr-launcher';
        button.setAttribute('aria-label', 'Open Find and Replace');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', 'cfr-panel');
        button.title = 'Find and Replace (Ctrl+Shift+F)';
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 5 5"></path></svg><span>Find &amp; Replace</span>';
        return button;
    }

    function placeComposerLauncher() {
        if (!launcherElement) {
            launcherElement = document.getElementById('cfr-launcher') || root?.querySelector('#cfr-launcher') || null;
        }
        if (!launcherElement) {
            launcherElement = createLauncherElement();
        }
        // Keep a durable reference while the SillyTavern composer is rebuilt.
        // If the old #leftSendForm is removed, the launcher can otherwise be
        // detached with it and document.getElementById() can no longer find it.
        if (!launcherElement.isConnected && root?.isConnected) {
            root.prepend(launcherElement);
        }
        const target = document.getElementById('leftSendForm');
        if (target) {
            if (launcherElement.parentElement !== target) target.append(launcherElement);
            target.classList.add('cfr-has-launcher');
            return true;
        }
        return false;
    }

    function scheduleComposerPlacement() {
        if (composerPlacementScheduled) return;
        composerPlacementScheduled = true;
        requestAnimationFrame(() => {
            composerPlacementScheduled = false;
            placeComposerLauncher();
        });
    }

    function ensureComposerLauncher() {
        placeComposerLauncher();
        // Observe document.body rather than #form_sheld. SillyTavern can replace
        // the composer shell itself, which would disconnect an observer attached
        // to the previous shell and could make the launcher disappear permanently.
        if (composerObserver || !document.body) return;
        composerObserver = new MutationObserver(records => {
            // The body observer is intentionally broad so it survives composer-shell
            // replacement, but ignore unrelated chat streaming/formatting mutations.
            const relevant = records.some(record => {
                if (record.target instanceof Element && record.target.closest('#leftSendForm')) return true;
                const changedNodes = [...record.addedNodes, ...record.removedNodes];
                return changedNodes.some(node => {
                    if (node === launcherElement) return true;
                    if (node.nodeType !== Node.ELEMENT_NODE) return false;
                    return node.id === 'leftSendForm'
                        || node.contains?.(launcherElement)
                        || !!node.querySelector?.('#leftSendForm')
                        || !!node.querySelector?.('#cfr-launcher');
                });
            });
            if (!relevant) return;
            const target = document.getElementById('leftSendForm');
            const needsRepair = !launcherElement?.isConnected || (target && launcherElement?.parentElement !== target);
            if (needsRepair) scheduleComposerPlacement();
        });
        composerObserver.observe(document.body, { childList: true, subtree: true });
    }
    function positionPanel() {
        if (!panel || panel.hidden) return;
        const launcher = launcherElement?.isConnected ? launcherElement : document.getElementById('cfr-launcher');
        if (!launcher?.isConnected) return;

        const rect = launcher.getBoundingClientRect();
        const visual = window.visualViewport;
        // On mobile, the visual viewport can be much shorter than the layout
        // viewport while the software keyboard is open. Position against the
        // actually visible area so the panel doesn't open behind the keyboard.
        const viewportWidth = Math.max(1, visual?.width || document.documentElement.clientWidth || window.innerWidth);
        const viewportHeight = Math.max(1, visual?.height || window.innerHeight || document.documentElement.clientHeight);
        const offsetLeft = visual?.offsetLeft || 0;
        const offsetTop = visual?.offsetTop || 0;
        const layoutHeight = window.innerHeight || document.documentElement.clientHeight || viewportHeight;
        const visibleRight = offsetLeft + viewportWidth;
        const visibleBottom = offsetTop + viewportHeight;
        const narrow = viewportWidth <= 560;
        const panelWidth = Math.max(0, Math.min(320, viewportWidth - 16));
        const minLeft = offsetLeft + 8;
        const maxLeft = Math.max(minLeft, visibleRight - panelWidth - 8);
        const left = narrow ? minLeft : Math.max(minLeft, Math.min(rect.left, maxLeft));

        panel.style.left = `${left}px`;
        panel.style.right = 'auto';
        panel.style.width = `min(320px, ${Math.max(0, viewportWidth - 16)}px)`;
        // `bottom` is measured from the layout viewport; clamp the anchor to
        // the visible viewport bottom when a keyboard or browser UI covers it.
        const anchorTop = Math.min(rect.top, visibleBottom - 8);
        panel.style.bottom = `${Math.max(8, layoutHeight - anchorTop + 8)}px`;
        if (narrow) {
            panel.style.maxHeight = `${Math.max(120, Math.min(400, viewportHeight - 24))}px`;
        } else {
            panel.style.maxHeight = '';
        }
    }

    function openPanel() {
        if (!panel) return;
        panel.hidden = false;
        panel.setAttribute('aria-hidden', 'false');
        (launcherElement || $('#cfr-launcher'))?.setAttribute('aria-expanded', 'true');
        root.classList.add('cfr-open');
        positionPanel();
        requestAnimationFrame(positionPanel);
        const find = $('#cfr-find');
        // Avoid forcing the virtual keyboard open on touch devices just to show the panel.
        if (!find.value && !window.matchMedia('(pointer: coarse)').matches) find.focus({ preventScroll: true });
        scheduleHighlightRefresh();
    }

    function closePanel() {
        if (!panel) return;
        panel.hidden = true;
        panel.setAttribute('aria-hidden', 'true');
        (launcherElement || $('#cfr-launcher'))?.setAttribute('aria-expanded', 'false');
        root.classList.remove('cfr-open');
        clearHighlights();
    }

    function togglePanel() {
        if (!panel) return;
        if (panel.hidden) openPanel();
        else closePanel();
    }

    function bindUI() {
        // The launcher lives outside #cfr-root in SillyTavern's composer, which
        // is rebuilt by some mobile layouts. Use delegated events and support
        // touch pointers explicitly because some mobile WebViews don't reliably
        // synthesize a click for a button reparented into the composer.
        const getLauncherTarget = event => {
            const target = event?.target;
            if (target instanceof Element) return target.closest('#cfr-launcher');
            return target?.parentElement?.closest?.('#cfr-launcher') || null;
        };
        let activePointer = null;
        let suppressClickTarget = null;
        let suppressClickUntil = 0;

        const activateLauncher = (event, target, fromTouchPointer = false) => {
            if (!target) return;
            event.preventDefault();
            event.stopPropagation();
            if (fromTouchPointer) {
                suppressClickTarget = target;
                suppressClickUntil = performance.now() + 900;
            }
            togglePanel();
        };

        if ('PointerEvent' in window) {
            document.addEventListener('pointerdown', event => {
                if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
                const target = getLauncherTarget(event);
                activePointer = target ? {
                    target,
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                } : null;
            }, true);

            document.addEventListener('pointerup', event => {
                if (!activePointer || activePointer.pointerId !== event.pointerId) return;
                const start = activePointer;
                activePointer = null;
                // Ignore finger drags, scrolling gestures, and taps that began elsewhere.
                if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
                const target = getLauncherTarget(event);
                if (!start.target.isConnected || (target && target !== start.target)) return;
                activateLauncher(event, start.target, true);
            }, true);

            document.addEventListener('pointercancel', event => {
                if (activePointer?.pointerId === event.pointerId) activePointer = null;
            }, true);
        } else {
            // Legacy mobile WebView fallback for browsers without Pointer Events.
            let touchStart = null;
            document.addEventListener('touchstart', event => {
                const target = getLauncherTarget(event);
                const touch = event.changedTouches?.[0];
                touchStart = target && touch ? { target, x: touch.clientX, y: touch.clientY } : null;
            }, { capture: true, passive: true });
            document.addEventListener('touchend', event => {
                if (!touchStart) return;
                const start = touchStart;
                touchStart = null;
                const touch = event.changedTouches?.[0];
                if (!touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 12) return;
                if (!start.target.isConnected) return;
                activateLauncher(event, start.target, true);
            }, { capture: true, passive: false });
            document.addEventListener('touchcancel', () => { touchStart = null; }, true);
        }

        // Keep click for mouse, keyboard, assistive technology and as a fallback.
        // Consume the synthetic click after a touch pointer so one tap never toggles twice.
        document.addEventListener('click', event => {
            const target = getLauncherTarget(event);
            if (!target) return;
            if (event.detail > 0 && target === suppressClickTarget && performance.now() < suppressClickUntil) {
                suppressClickTarget = null;
                suppressClickUntil = 0;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            activateLauncher(event, target, false);
        }, true);

        const reposition = () => positionPanel();
        window.addEventListener('resize', reposition, { passive: true });
        window.addEventListener('orientationchange', reposition, { passive: true });
        window.visualViewport?.addEventListener('resize', reposition, { passive: true });
        window.visualViewport?.addEventListener('scroll', reposition, { passive: true });
        window.addEventListener('scroll', reposition, { passive: true, capture: true });
        panel.addEventListener('click', event => {
            const button = event.target.closest('[data-cfr-action]');
            if (!button) return;
            const action = button.dataset.cfrAction;
            switch (action) {
                case 'close':
                case 'minimize':
                    closePanel();
                    break;
                case 'find-next':
                    findNext();
                    break;
                case 'replace-all':
                    void replaceAll();
                    break;
                case 'save-rule':
                    saveCurrentRule();
                    break;
                case 'load-rule':
                    loadSelectedRule();
                    break;
                case 'delete-rule':
                    deleteSelectedRule();
                    break;
            }
        });

        const immediatePreview = ['cfr-find', 'cfr-replace', 'cfr-flags'];
        for (const id of immediatePreview) {
            $(`#${id}`).addEventListener('input', () => {
                nextSearchAfter = -1;
                persistLastUsed();
                schedulePreview();
                scheduleHighlightRefresh();
            });
        }
        for (const id of ['cfr-regex', 'cfr-case-sensitive', 'cfr-target-user', 'cfr-target-assistant', 'cfr-target-system', 'cfr-alt-swipes']) {
            $(`#${id}`).addEventListener('change', () => {
                nextSearchAfter = -1;
                updateModeUI();
                persistLastUsed();
                schedulePreview();
                scheduleHighlightRefresh();
            });
        }

        $('#cfr-rule-name').addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveCurrentRule();
            }
        });
        $('#cfr-find').addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                $('#cfr-replace').focus();
            }
        });
        $('#cfr-replace').addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                findNext();
            }
        });

        document.addEventListener('keydown', event => {
            if (event.altKey || event.metaKey && !event.shiftKey) return;
            if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'f') return;
            const target = event.target;
            if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], #cfr-panel')) return;
            event.preventDefault();
            togglePanel();
        });
    }

    function restoreLastUsed() {
        const state = getSettings().lastUsed;
        $('#cfr-find').value = state.find ?? '';
        $('#cfr-replace').value = state.replace ?? '';
        $('#cfr-regex').checked = !!state.regexMode;
        $('#cfr-flags').value = state.flags ?? 'gi';
        $('#cfr-case-sensitive').checked = !!state.caseSensitive;
        $('#cfr-target-user').checked = state.targetUser !== false;
        $('#cfr-target-assistant').checked = state.targetAssistant !== false;
        $('#cfr-target-system').checked = !!state.targetSystem;
        $('#cfr-alt-swipes').checked = !!state.includeAlternateSwipes;
    }

    function readForm() {
        return {
            find: $('#cfr-find').value,
            replace: $('#cfr-replace').value,
            regexMode: $('#cfr-regex').checked,
            flags: $('#cfr-flags').value.trim(),
            caseSensitive: $('#cfr-case-sensitive').checked,
            targetUser: $('#cfr-target-user').checked,
            targetAssistant: $('#cfr-target-assistant').checked,
            targetSystem: $('#cfr-target-system').checked,
            includeAlternateSwipes: $('#cfr-alt-swipes').checked,
        };
    }

    function persistLastUsed() {
        if (!root || !$('#cfr-find')) return;
        getSettings().lastUsed = readForm();
        saveSettings();
    }

    function updateModeUI() {
        const regexMode = $('#cfr-regex').checked;
        $('#cfr-regex-options').hidden = !regexMode;
        $('#cfr-case-sensitive').disabled = regexMode;
        $('#cfr-case-sensitive').closest('.cfr-check-row')?.classList.toggle('cfr-option-disabled', regexMode);
    }

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function compileSearch(form) {
        if (!form.find.length) throw new Error('Enter a search term first.');
        let source;
        let flags;
        if (form.regexMode) {
            source = form.find;
            flags = form.flags.replace(/y/g, '');
            if (!flags.includes('g')) flags += 'g';
        } else {
            source = escapeRegExp(form.find);
            flags = form.caseSensitive ? 'g' : 'gi';
        }
        let regex;
        try {
            regex = new RegExp(source, flags);
        } catch (error) {
            throw new Error(`Invalid regex or flags: ${error.message}`);
        }
        return { source, flags: regex.flags, regex };
    }

    function isSystemOrNote(message) {
        return !!(message?.is_system || message?.extra?.isSmallSys);
    }

    function isTargetRole(message, form) {
        if (!message || typeof message.mes !== 'string') return false;
        if (message.is_user) return form.targetUser;
        if (isSystemOrNote(message)) return form.targetSystem;
        return form.targetAssistant;
    }

    function countMatches(text, matcher) {
        if (typeof text !== 'string' || !text.length) return 0;
        const regex = new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : `${matcher.flags}g`);
        let count = 0;
        for (const _match of text.matchAll(regex)) count++;
        return count;
    }

    function replaceText(text, form, matcher) {
        if (typeof text !== 'string' || !text.length) return { text, count: 0 };
        const count = countMatches(text, matcher);
        if (!count) return { text, count: 0 };
        const regex = new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : `${matcher.flags}g`);
        return { text: text.replace(regex, form.replace), count };
    }

    function makeMessagePlan(message, index, form, matcher) {
        const original = String(message.mes ?? '');
        if (form.includeAlternateSwipes && !message.is_user && !isSystemOrNote(message) && Array.isArray(message.swipes) && message.swipes.length) {
            const swipes = message.swipes.slice();
            const activeId = Number.isInteger(message.swipe_id) && message.swipe_id >= 0 && message.swipe_id < swipes.length
                ? message.swipe_id
                : 0;
            // If a legacy message has swipe data but no usable active index, treat its current text as swipe 0.
            swipes[activeId] = original;
            let occurrenceCount = 0;
            const changedSwipeIds = [];
            const updatedSwipes = swipes.map((text, swipeIndex) => {
                const input = typeof text === 'string' ? text : '';
                const result = replaceText(input, form, matcher);
                occurrenceCount += result.count;
                if (result.count) changedSwipeIds.push(swipeIndex);
                return result.text;
            });
            const nextMessage = updatedSwipes[activeId];
            if (!occurrenceCount) return null;
            return {
                index,
                message,
                original,
                nextMessage,
                nextSwipes: updatedSwipes,
                activeId,
                count: occurrenceCount,
                changedSwipeIds,
            };
        }

        const result = replaceText(original, form, matcher);
        if (!result.count) return null;
        return {
            index,
            message,
            original,
            nextMessage: result.text,
            nextSwipes: null,
            activeId: Number.isInteger(message.swipe_id) ? message.swipe_id : -1,
            count: result.count,
            changedSwipeIds: [],
        };
    }

    function buildPlan(form) {
        if (!form.targetUser && !form.targetAssistant && !form.targetSystem) {
            throw new Error('Choose at least one message role: User, AI, or System / notes.');
        }
        const matcher = compileSearch(form);
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) throw new Error('There are no messages in the current chat.');
        const entries = [];
        let totalMatches = 0;
        let swipeVariants = 0;
        for (let index = 0; index < chat.length; index++) {
            const message = chat[index];
            if (!isTargetRole(message, form)) continue;
            const item = makeMessagePlan(message, index, form, matcher);
            if (!item) continue;
            entries.push(item);
            totalMatches += item.count;
            swipeVariants += item.changedSwipeIds?.length || 0;
        }
        return { form, matcher, entries, totalMatches, messageCount: entries.length, swipeVariants };
    }

    function setStatus(message, kind = 'normal') {
        const status = $('#cfr-status');
        status.textContent = message;
        status.dataset.kind = kind;
    }

    function schedulePreview() {
        clearTimeout(previewTimer);
        setStatus('Updating preview…', 'normal');
        previewTimer = setTimeout(refreshPreview, 100);
    }

    function refreshPreview() {
        try {
            const form = readForm();
            if (!form.find.length) {
                lastValidPlan = null;
                setStatus('Enter a search term to preview matches.');
                return;
            }
            const plan = buildPlan(form);
            lastValidPlan = plan;
            const matchesLabel = `${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'}`;
            const messagesLabel = `${plan.messageCount} message${plan.messageCount === 1 ? '' : 's'}`;
            let suffix = '';
            if (form.includeAlternateSwipes && plan.swipeVariants) {
                suffix = ` · ${plan.swipeVariants} swipe variant${plan.swipeVariants === 1 ? '' : 's'} affected`;
            }
            setStatus(plan.totalMatches ? `${matchesLabel} across ${messagesLabel}${suffix}.` : `No matches in the selected message roles.`, plan.totalMatches ? 'success' : 'normal');
        } catch (error) {
            lastValidPlan = null;
            setStatus(error.message || 'Could not preview this search.', 'error');
        }
    }

    function captureScrollAnchor() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return null;
        const viewport = chatEl.getBoundingClientRect();
        const messages = Array.from(chatEl.querySelectorAll('.mes[mesid]'));
        const firstVisible = messages.find(message => message.getBoundingClientRect().bottom > viewport.top + 2);
        if (!firstVisible) return { chatEl, scrollTop: chatEl.scrollTop, anchorId: null, offset: 0 };
        return {
            chatEl,
            scrollTop: chatEl.scrollTop,
            anchorId: firstVisible.getAttribute('mesid'),
            offset: firstVisible.getBoundingClientRect().top - viewport.top,
        };
    }

    function restoreScrollAnchor(anchor) {
        if (!anchor?.chatEl) return;
        if (anchor.anchorId !== null) {
            const message = anchor.chatEl.querySelector(`.mes[mesid="${CSS.escape(anchor.anchorId)}"]`);
            if (message) {
                const viewport = anchor.chatEl.getBoundingClientRect();
                const newOffset = message.getBoundingClientRect().top - viewport.top;
                anchor.chatEl.scrollTop += newOffset - anchor.offset;
                return;
            }
        }
        anchor.chatEl.scrollTop = anchor.scrollTop;
    }

    function hasOpenMessageEditor() {
        return !!document.querySelector('#chat .mes.sme-editing, #chat .mes .edit_textarea, #chat .mes .sme-wysiwyg-view[contenteditable="true"]');
    }

    function isGenerating() {
        return document.body.dataset.generating === 'true';
    }

    async function replaceAll() {
        persistLastUsed();
        let plan;
        try {
            plan = buildPlan(readForm());
        } catch (error) {
            setStatus(error.message || 'Could not run replacement.', 'error');
            notify('warning', error.message || 'Could not run replacement.');
            return;
        }
        lastValidPlan = plan;
        if (!plan.totalMatches) {
            setStatus('No matches to replace.', 'normal');
            notify('info', 'No matches found in the selected messages.');
            return;
        }
        if (isGenerating()) {
            notify('warning', 'Wait for generation to finish before replacing chat text.');
            return;
        }
        if (hasOpenMessageEditor()) {
            notify('warning', 'Save or cancel the open message editor before using bulk replacement.');
            return;
        }
        if (typeof context.updateMessageBlock !== 'function' || typeof context.saveChat !== 'function') {
            const message = 'This SillyTavern version does not expose the message update/save APIs required by Find & Replace.';
            setStatus(message, 'error');
            notify('error', message);
            return;
        }

        const summary = `Replace ${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'} across ${plan.messageCount} message${plan.messageCount === 1 ? '' : 's'} in the current chat?\n\nThis changes the saved message text${plan.form.includeAlternateSwipes ? ' and matching alternate swipes' : ''}.`;
        if (!window.confirm(summary)) return;

        const anchor = captureScrollAnchor();
        const snapshots = plan.entries.map(item => ({
            item,
            mes: item.message.mes,
            swipesRef: item.message.swipes,
            swipesCopy: Array.isArray(item.message.swipes) ? item.message.swipes.slice() : null,
        }));
        let successfulMessages = 0;
        try {
            // Apply the planned changes in memory first, then update rendered blocks.
            // Snapshots allow rollback if a render, event, or disk save fails partway through.
            for (const item of plan.entries) {
                const message = item.message;
                message.mes = item.nextMessage;
                if (Array.isArray(item.nextSwipes)) {
                    message.swipes = item.nextSwipes.slice();
                    if (item.activeId >= 0 && item.activeId < message.swipes.length) {
                        message.mes = message.swipes[item.activeId];
                    }
                } else if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipe_id >= 0 && message.swipe_id < message.swipes.length) {
                    message.swipes = message.swipes.slice();
                    message.swipes[message.swipe_id] = message.mes;
                }
            }
            for (const item of plan.entries) {
                context.updateMessageBlock(item.index, item.message);
                successfulMessages++;
            }

            const events = context.eventTypes || context.event_types || {};
            for (const item of plan.entries) {
                if (events.MESSAGE_EDITED) await context.eventSource?.emit(events.MESSAGE_EDITED, item.index);
                if (events.MESSAGE_UPDATED) await context.eventSource?.emit(events.MESSAGE_UPDATED, item.index);
            }
            await context.saveChat();
            restoreScrollAnchor(anchor);
            setStatus(`Replaced ${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'} across ${successfulMessages} message${successfulMessages === 1 ? '' : 's'}.`, 'success');
            notify('success', `Replaced ${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'} across ${successfulMessages} messages.`);
            refreshPreview();
            scheduleHighlightRefresh();
        } catch (error) {
            console.error(`[${MODULE}] Replacement failed, restoring original message values:`, error);
            for (const snapshot of snapshots) {
                snapshot.item.message.mes = snapshot.mes;
                if (Array.isArray(snapshot.swipesCopy)) {
                    snapshot.item.message.swipes = snapshot.swipesRef;
                    snapshot.swipesRef.splice(0, snapshot.swipesRef.length, ...snapshot.swipesCopy);
                } else {
                    snapshot.item.message.swipes = snapshot.swipesRef;
                }
            }
            // Best-effort re-render/save the restored values if the original failure
            // happened after one or more message blocks had already been replaced.
            try {
                for (const snapshot of snapshots) context.updateMessageBlock(snapshot.item.index, snapshot.item.message);
                await context.saveChat();
                restoreScrollAnchor(anchor);
            } catch (rollbackError) {
                console.error(`[${MODULE}] Rollback render/save also failed:`, rollbackError);
            }
            notify('error', 'Replacement failed. Original in-memory message text has been restored where possible. Check the chat and console before retrying.');
            setStatus('Replacement failed; original message values were restored where possible.', 'error');
            scheduleHighlightRefresh();
        }
    }

    function findNext() {
        let plan;
        try {
            plan = buildPlan(readForm());
        } catch (error) {
            setStatus(error.message || 'Could not search.', 'error');
            return;
        }
        if (!plan.entries.length) {
            setStatus('No matching messages found.', 'normal');
            return;
        }

        const candidates = plan.entries.filter(entry => entry.index > nextSearchAfter);
        const target = candidates[0] || plan.entries[0];
        nextSearchAfter = target.index;
        const messageElement = document.querySelector(`#chat .mes[mesid="${target.index}"]`);
        if (messageElement) {
            messageElement.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
            messageElement.classList.remove('cfr-found-flash');
            // Force a layout pass so repeated searches replay the short highlight animation.
            void messageElement.offsetWidth;
            messageElement.classList.add('cfr-found-flash');
            setTimeout(() => messageElement.classList.remove('cfr-found-flash'), 1200);
            setStatus(`Showing a match in message ${target.index + 1} of ${context.chat.length}.`, 'success');
        } else {
            setStatus(`Found a match at message ${target.index + 1}, but it is not currently rendered in the chat window.`, 'normal');
        }
    }

    function populateSavedRules(selectedId = '') {
        const select = $('#cfr-saved-rules');
        if (!select) return;
        select.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a saved rule…';
        select.append(placeholder);
        const rules = getSettings().savedRules;
        for (const rule of rules) {
            const option = document.createElement('option');
            option.value = rule.id;
            option.textContent = rule.name;
            select.append(option);
        }
        select.value = selectedId;
    }

    function saveCurrentRule() {
        const nameInput = $('#cfr-rule-name');
        const name = nameInput.value.trim();
        if (!name) {
            setStatus('Give this rule a name before saving it.', 'error');
            nameInput.focus();
            return;
        }
        const form = readForm();
        try {
            compileSearch(form);
        } catch (error) {
            setStatus(error.message || 'Fix the search pattern before saving.', 'error');
            return;
        }
        const settings = getSettings();
        const existing = settings.savedRules.find(rule => rule.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        const id = existing?.id || (globalThis.crypto?.randomUUID?.() || `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const rule = { id, name, ...form };
        if (existing) {
            settings.savedRules = settings.savedRules.map(item => item.id === id ? rule : item);
        } else {
            settings.savedRules.push(rule);
        }
        saveSettings();
        populateSavedRules(id);
        setStatus(`Saved rule “${name}”.`, 'success');
        notify('success', `Saved rule “${name}”.`);
    }

    function loadSelectedRule() {
        const id = $('#cfr-saved-rules').value;
        const rule = getSettings().savedRules.find(item => item.id === id);
        if (!rule) {
            setStatus('Choose a saved rule to load.', 'error');
            return;
        }
        $('#cfr-rule-name').value = rule.name;
        $('#cfr-find').value = rule.find ?? '';
        $('#cfr-replace').value = rule.replace ?? '';
        $('#cfr-regex').checked = !!rule.regexMode;
        $('#cfr-flags').value = rule.flags ?? 'gi';
        $('#cfr-case-sensitive').checked = !!rule.caseSensitive;
        $('#cfr-target-user').checked = rule.targetUser !== false;
        $('#cfr-target-assistant').checked = rule.targetAssistant !== false;
        $('#cfr-target-system').checked = !!rule.targetSystem;
        $('#cfr-alt-swipes').checked = !!rule.includeAlternateSwipes;
        updateModeUI();
        persistLastUsed();
        refreshPreview();
        scheduleHighlightRefresh();
        setStatus(`Loaded rule “${rule.name}”.`, 'success');
    }

    function deleteSelectedRule() {
        const id = $('#cfr-saved-rules').value;
        const settings = getSettings();
        const rule = settings.savedRules.find(item => item.id === id);
        if (!rule) {
            setStatus('Choose a saved rule to delete.', 'error');
            return;
        }
        if (!window.confirm(`Delete the saved rule “${rule.name}”?`)) return;
        settings.savedRules = settings.savedRules.filter(item => item.id !== id);
        saveSettings();
        populateSavedRules();
        setStatus(`Deleted rule “${rule.name}”.`, 'success');
    }

    // Rendered-text match highlighting. The native CSS Highlight API does not
    // alter message HTML, so it remains compatible with SillyTavern's formatter.
    const HIGHLIGHT_NAME = 'chat-find-replace-hits';
    const FALLBACK_MARK_CLASS = 'cfr-fr-hit';

    function clearHighlights() {
        try {
            globalThis.CSS?.highlights?.delete(HIGHLIGHT_NAME);
        } catch (_error) {
            // DOM-marker fallback below is still cleared on browsers without CSS Highlights.
        }
        const marks = document.querySelectorAll(`#chat mark.${FALLBACK_MARK_CLASS}`);
        const parents = new Set();
        for (const mark of marks) {
            if (!mark.parentNode) continue;
            parents.add(mark.parentNode);
            mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
        }
        for (const parent of parents) parent.normalize?.();
    }

    function isExcludedHighlightNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return true;
        return !!parent.closest([
            'script', 'style', 'textarea', 'input', 'button', 'select',
            '[contenteditable="true"]', `mark.${FALLBACK_MARK_CLASS}`,
            '.mes_reasoning', '.mes_reasoning_details', 'details > summary',
        ].join(','));
    }

    function collectHighlightRanges(container, regex) {
        const ranges = [];
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isExcludedHighlightNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        let node;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue ?? '';
            const matcher = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
            let match;
            while ((match = matcher.exec(text)) !== null) {
                if (!match[0].length) {
                    if (matcher.lastIndex <= match.index) matcher.lastIndex = match.index + 1;
                    continue;
                }
                try {
                    const range = document.createRange();
                    range.setStart(node, match.index);
                    range.setEnd(node, match.index + match[0].length);
                    ranges.push(range);
                } catch (_error) {
                    // Message rerender detached a node during collection; skip that range.
                }
            }
        }
        return ranges;
    }

    function fallbackHighlightNode(node, regex) {
        const text = node.nodeValue ?? '';
        const matcher = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let changed = false;
        let match;
        while ((match = matcher.exec(text)) !== null) {
            if (!match[0].length) {
                if (matcher.lastIndex <= match.index) matcher.lastIndex = match.index + 1;
                continue;
            }
            changed = true;
            if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
            const mark = document.createElement('mark');
            mark.className = FALLBACK_MARK_CLASS;
            mark.textContent = match[0];
            fragment.append(mark);
            cursor = match.index + match[0].length;
        }
        if (!changed) return;
        if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
        node.replaceWith(fragment);
    }

    function fallbackHighlight(container, regex) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isExcludedHighlightNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);
        for (const textNode of nodes) fallbackHighlightNode(textNode, regex);
    }

    function shouldHighlightMessage(messageElement, form) {
        const messageId = Number.parseInt(messageElement.getAttribute('mesid') ?? '', 10);
        const message = Number.isInteger(messageId) ? context?.chat?.[messageId] : null;
        if (message) {
            if (message.is_user) return form.targetUser;
            if (isSystemOrNote(message)) return form.targetSystem;
            return form.targetAssistant;
        }
        if (messageElement.getAttribute('is_user') === 'true' || messageElement.classList.contains('user_mes')) return form.targetUser;
        if (messageElement.getAttribute('is_system') === 'true' || messageElement.classList.contains('system_mes')) return form.targetSystem;
        return form.targetAssistant;
    }

    function refreshHighlights() {
        highlightFrame = 0;
        if (!panel || panel.hidden || panel.getAttribute('aria-hidden') === 'true') {
            clearHighlights();
            return;
        }
        const form = readForm();
        if (!form.find) {
            clearHighlights();
            return;
        }
        let matcher;
        try {
            matcher = compileSearch(form).regex;
        } catch (_error) {
            clearHighlights();
            return;
        }
        const containers = [];
        for (const message of document.querySelectorAll('#chat .mes[mesid]')) {
            if (!shouldHighlightMessage(message, form)) continue;
            const textContainer = message.querySelector('.mes_text');
            if (!textContainer || message.matches('.sme-editing') || textContainer.querySelector('[contenteditable="true"]')) continue;
            containers.push(textContainer);
        }
        clearHighlights();
        if (!containers.length) return;
        if (globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function') {
            const ranges = [];
            for (const container of containers) ranges.push(...collectHighlightRanges(container, matcher));
            if (ranges.length) {
                try {
                    globalThis.CSS.highlights.set(HIGHLIGHT_NAME, new globalThis.Highlight(...ranges));
                    return;
                } catch (_error) {
                    globalThis.CSS.highlights.delete(HIGHLIGHT_NAME);
                }
            }
        }
        // Fallback uses <mark> only on browsers without a functioning CSS Highlight API.
        for (const container of containers) fallbackHighlight(container, matcher);
    }

    function scheduleHighlightRefresh() {
        if (highlightFrame) return;
        highlightFrame = requestAnimationFrame(refreshHighlights);
    }

    function isOwnHighlightFallbackMutation(record) {
        if (record.type !== 'childList') return false;
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (!changed.length) return false;
        return changed.every(node => node.nodeType === Node.TEXT_NODE ||
            (node.nodeType === Node.ELEMENT_NODE && node.matches?.(`mark.${FALLBACK_MARK_CLASS}`)));
    }

    function bindHighlightChat() {
        const chatElement = document.getElementById('chat');
        if (!chatElement || chatElement === highlightChatElement) return;
        highlightChatObserver?.disconnect();
        highlightChatElement = chatElement;
        highlightChatObserver = new MutationObserver(records => {
            if (records.some(record => !isOwnHighlightFallbackMutation(record))) scheduleHighlightRefresh();
        });
        highlightChatObserver.observe(chatElement, { childList: true, subtree: true });
        scheduleHighlightRefresh();
    }

    function setupHighlightObservers() {
        bindHighlightChat();
        if (highlightDiscoveryObserver || !document.documentElement) return;
        highlightDiscoveryObserver = new MutationObserver(() => {
            bindHighlightChat();
        });
        highlightDiscoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function subscribeToChatEvents() {
        const events = context.eventTypes || context.event_types || {};
        const rerun = () => {
            nextSearchAfter = -1;
            if (panel && !panel.hidden) {
                schedulePreview();
                scheduleHighlightRefresh();
            }
        };
        for (const eventName of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
            if (events[eventName]) context.eventSource?.on(events[eventName], rerun);
        }
    }

    function initialize() {
        if (initialized) return;
        if (!globalThis.SillyTavern?.getContext) {
            // Some launch modes load extension scripts before the global context is ready.
            // Retry briefly rather than silently leaving the launcher absent for the session.
            if (initializationAttempts++ < 80) setTimeout(initialize, 250);
            else console.warn(`[${MODULE}] SillyTavern context did not become available; extension UI was not initialized.`);
            return;
        }
        context = globalThis.SillyTavern.getContext();
        if (!context?.chat || !context?.extensionSettings) {
            if (initializationAttempts++ < 80) setTimeout(initialize, 250);
            else console.warn(`[${MODULE}] Required SillyTavern context APIs are not available.`);
            return;
        }
        initialized = true;
        getSettings();
        buildUI();
        subscribeToChatEvents();
        setupHighlightObservers();
        log('Extension loaded.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
