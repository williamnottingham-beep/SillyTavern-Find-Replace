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
            context.extensionSettings[SETTINGS_KEY] = structuredClone(DEFAULTS);
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
            panel = $('#cfr-panel');
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
        panel = $('#cfr-panel');
        ensureComposerLauncher();
        restoreLastUsed();
        populateSavedRules();
        bindUI();
        updateModeUI();
        refreshPreview();
    }

    let composerObserver;

    function ensureComposerLauncher() {
        const place = () => {
            const launcher = document.getElementById('cfr-launcher');
            const target = document.getElementById('leftSendForm');
            if (!launcher || !target) return false;
            if (launcher.parentElement !== target) target.append(launcher);
            target.classList.add('cfr-has-launcher');
            return true;
        };

        place();
        if (composerObserver || !document.body) return;
        composerObserver = new MutationObserver(() => {
            const launcher = document.getElementById('cfr-launcher');
            const target = document.getElementById('leftSendForm');
            if (launcher && target && launcher.parentElement !== target) {
                target.append(launcher);
                target.classList.add('cfr-has-launcher');
            }
        });
        composerObserver.observe(document.getElementById('form_sheld') || document.body, {
            childList: true,
            subtree: true,
        });
    }

    function positionPanel() {
        if (!panel || panel.hidden) return;
        const launcher = document.getElementById('cfr-launcher');
        if (!launcher?.isConnected) return;
        const rect = launcher.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const narrow = viewportWidth <= 560;
        const panelWidth = Math.min(390, viewportWidth - 16);
        if (narrow) {
            // CSS env() keeps the panel clear of notches and rounded-screen safe areas.
            panel.style.left = 'max(8px, env(safe-area-inset-left))';
            panel.style.right = 'max(8px, env(safe-area-inset-right))';
            panel.style.width = 'auto';
        } else {
            const left = Math.max(8, Math.min(rect.left, viewportWidth - panelWidth - 8));
            panel.style.left = `${left}px`;
            panel.style.right = 'auto';
            panel.style.width = 'min(390px, calc(100vw - 16px))';
        }
        panel.style.bottom = `${Math.max(8, viewportHeight - rect.top + 8)}px`;
    }

    function openPanel() {
        if (!panel) return;
        panel.hidden = false;
        panel.setAttribute('aria-hidden', 'false');
        $('#cfr-launcher').setAttribute('aria-expanded', 'true');
        root.classList.add('cfr-open');
        positionPanel();
        requestAnimationFrame(positionPanel);
        const find = $('#cfr-find');
        // Avoid forcing the virtual keyboard open on touch devices just to show the panel.
        if (!find.value && !window.matchMedia('(pointer: coarse)').matches) find.focus({ preventScroll: true });
    }

    function closePanel() {
        if (!panel) return;
        panel.hidden = true;
        panel.setAttribute('aria-hidden', 'true');
        $('#cfr-launcher').setAttribute('aria-expanded', 'false');
        root.classList.remove('cfr-open');
    }

    function togglePanel() {
        if (panel.hidden) openPanel();
        else closePanel();
    }

    function bindUI() {
        // Use a delegated capture listener because the launcher lives inside the
        // SillyTavern composer, outside #cfr-root, and the composer can be rebuilt.
        // This keeps the button functional even if SillyTavern replaces/reparents UI.
        document.addEventListener('click', event => {
            const target = event.target instanceof Element ? event.target.closest('#cfr-launcher') : null;
            if (!target) return;
            event.preventDefault();
            event.stopPropagation();
            togglePanel();
        }, true);
        const reposition = () => positionPanel();
        window.addEventListener('resize', reposition, { passive: true });
        window.addEventListener('orientationchange', reposition, { passive: true });
        window.visualViewport?.addEventListener('resize', reposition, { passive: true });
        window.visualViewport?.addEventListener('scroll', reposition, { passive: true });
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
            });
        }
        for (const id of ['cfr-regex', 'cfr-case-sensitive', 'cfr-target-user', 'cfr-target-assistant', 'cfr-target-system', 'cfr-alt-swipes']) {
            $(`#${id}`).addEventListener('change', () => {
                nextSearchAfter = -1;
                updateModeUI();
                persistLastUsed();
                schedulePreview();
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
            if (target instanceof HTMLElement && target.closest(`#${ROOT_ID} input, #${ROOT_ID} textarea, #${ROOT_ID} select`)) return;
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

        const summary = `Replace ${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'} across ${plan.messageCount} message${plan.messageCount === 1 ? '' : 's'} in the current chat?\n\nThis changes the saved message text${plan.form.includeAlternateSwipes ? ' and matching alternate swipes' : ''}.`;
        if (!window.confirm(summary)) return;

        const anchor = captureScrollAnchor();
        let successfulMessages = 0;
        try {
            for (const item of plan.entries) {
                const message = item.message;
                message.mes = item.nextMessage;
                if (Array.isArray(item.nextSwipes)) {
                    message.swipes = item.nextSwipes;
                    if (item.activeId >= 0 && item.activeId < message.swipes.length) {
                        message.mes = message.swipes[item.activeId];
                    }
                } else if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipe_id >= 0 && message.swipe_id < message.swipes.length) {
                    // Keep the active swipe and displayed `mes` synchronized, just as native editing does.
                    message.swipes[message.swipe_id] = message.mes;
                }
                context.updateMessageBlock?.(item.index, message);
                successfulMessages++;
            }

            const events = context.eventTypes || context.event_types || {};
            for (const item of plan.entries) {
                if (events.MESSAGE_EDITED) await context.eventSource?.emit(events.MESSAGE_EDITED, item.index);
                if (events.MESSAGE_UPDATED) await context.eventSource?.emit(events.MESSAGE_UPDATED, item.index);
            }
            await context.saveChat?.();
            restoreScrollAnchor(anchor);
            setStatus(`Replaced ${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'} across ${successfulMessages} message${successfulMessages === 1 ? '' : 's'}.`, 'success');
            notify('success', `Replaced ${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'} across ${successfulMessages} messages.`);
            refreshPreview();
        } catch (error) {
            console.error(`[${MODULE}] Replacement failed:`, error);
            notify('error', 'Replacement could not finish. Check the console for details.');
            setStatus('Replacement failed. Some in-memory text may have been updated; check the chat before retrying.', 'error');
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

    function subscribeToChatEvents() {
        const events = context.eventTypes || context.event_types || {};
        const rerun = () => {
            nextSearchAfter = -1;
            if (panel && !panel.hidden) schedulePreview();
        };
        for (const eventName of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
            if (events[eventName]) context.eventSource?.on(events[eventName], rerun);
        }
    }

    function initialize() {
        if (initialized || !globalThis.SillyTavern?.getContext) return;
        initialized = true;
        context = SillyTavern.getContext();
        if (!context?.chat || !context?.extensionSettings) {
            initialized = false;
            console.warn(`[${MODULE}] Required SillyTavern context APIs are not available yet.`);
            return;
        }
        getSettings();
        buildUI();
        subscribeToChatEvents();
        log('Extension loaded.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
