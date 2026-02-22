import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {GlowAnimation, AnimationState} from './animation.js';
import {generateSessionId} from './utils.js';

const MESSAGE_PANEL_WIDTH = 680;
const INPUT_BAR_WIDTH = 660;
const MESSAGE_PANEL_TOP_MARGIN = 48;
const INPUT_BAR_BOTTOM_MARGIN = 36;
const INPUT_BAR_HEIGHT = 52;
const INPUT_BAR_TOP_MARGIN = 16;

/**
 * Simple markdown → Pango markup converter.
 */
function markdownToPango(text) {
    let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<i>$1</i>');
    out = out.replace(/`([^`]+?)`/g, '<tt>$1</tt>');
    // Markdown links [text](url) → show text underlined
    out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '<u>$1</u>');
    return out;
}

/**
 * Parse markdown text into structured blocks for rendering.
 * Supports: code blocks, lists, images, and text with inline formatting
 */
function parseMarkdownBlocks(text) {
    const blocks = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Heading: # Title, ## Subtitle, ### etc
        const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
        if (headingMatch) {
            blocks.push({type: 'heading', level: headingMatch[1].length, content: headingMatch[2]});
            i++;
            continue;
        }

        // Code block
        if (line.trimStart().startsWith('```')) {
            const lang = line.trim().slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++;
            blocks.push({type: 'code', content: codeLines.join('\n'), lang});
            continue;
        }

        // Image: ![alt](url)
        const imgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
        if (imgMatch) {
            blocks.push({type: 'image', alt: imgMatch[1], url: imgMatch[2]});
            i++;
            continue;
        }

        // List
        if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
            const listItems = [];
            while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
                const itemText = lines[i].replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, '');
                listItems.push(itemText);
                i++;
            }
            blocks.push({type: 'list', content: listItems});
            continue;
        }

        // Text paragraph
        const textLines = [];
        while (i < lines.length &&
               !lines[i].trimStart().startsWith('```') &&
               !/^#{1,4}\s+/.test(lines[i]) &&
               !/^\s*[-*]\s+/.test(lines[i]) &&
               !/^\s*\d+\.\s+/.test(lines[i]) &&
               !lines[i].match(/!\[([^\]]*)\]\(([^)]+)\)/)) {
            textLines.push(lines[i]);
            i++;
        }
        const joined = textLines.join('\n').trim();
        if (joined)
            blocks.push({type: 'text', content: joined});
    }

    return blocks;
}

/**
 * Make an St.Label's text selectable but not editable.
 */
function makeSelectable(label) {
    label.reactive = true;
    const ct = label.clutter_text;
    ct.set_selectable(true);
    ct.set_editable(false);
    ct.set_cursor_visible(false);
    const [, selColor] = Clutter.Color.from_string('rgba(100, 180, 255, 0.45)');
    const [, textColor] = Clutter.Color.from_string('#ffffff');
    if (selColor) ct.set_selection_color(selColor);
    if (textColor) ct.set_selected_text_color(textColor);
}


export const AetherOverlay = GObject.registerClass(
class AetherOverlay extends St.Widget {
    _init(conversation, stt, tts, todoManager, settings, memory) {
        super._init({
            visible: false,
        });

        this._conversation = conversation;
        this._stt = stt;
        this._tts = tts;
        this._todoManager = todoManager;
        this._settings = settings;
        this._memory = memory;
        this._isOpen = false;
        this._isProcessing = false;
        this._holdToTalk = false;
        this._discardSttCallback = false;
        this._currentToolContainer = null;
        this._isDark = false;
        this._historyMode = false;
        this._stageEventId = 0;
        this._focusWindowId = 0;
        this._overviewShowId = 0;

        this._detectTheme();
        this._buildUI();
    }

    // ── Theme detection ──

    _detectTheme() {
        try {
            this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const scheme = this._ifaceSettings.get_string('color-scheme');
            this._isDark = (scheme === 'prefer-dark');

            this._ifaceSettings.connect('changed::color-scheme', () => {
                const newScheme = this._ifaceSettings.get_string('color-scheme');
                this._isDark = (newScheme === 'prefer-dark');
                this._applyTheme();
            });
        } catch {
            this._isDark = true;
        }
    }

    _applyTheme() {
        const panels = [this._messagePanel, this._inputBar];
        for (const panel of panels) {
            if (!panel) continue;
            if (this._isDark) {
                panel.remove_style_class_name('aether-panel-light');
                panel.add_style_class_name('aether-panel-dark');
            } else {
                panel.remove_style_class_name('aether-panel-dark');
                panel.add_style_class_name('aether-panel-light');
            }
        }
    }

    // Stage event handler — click-outside, Escape, hold-to-talk release
    _onStageEvent(actor, event) {
        if (!this._isOpen)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();

        // Click outside panels → close (click passes through naturally)
        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            const mp = this._messagePanel;
            const ib = this._inputBar;
            const inMsg = x >= mp.x && x <= mp.x + mp.width &&
                          y >= mp.y && y <= mp.y + mp.height;
            const inInput = x >= ib.x && x <= ib.x + ib.width &&
                            y >= ib.y && y <= ib.y + ib.height;

            if (!inMsg && !inInput) {
                this._fullClose();
                return Clutter.EVENT_PROPAGATE;
            }
        }

        // Escape → close, Ctrl+C → copy selected text
        if (type === Clutter.EventType.KEY_PRESS) {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                this._fullClose();
                return Clutter.EVENT_STOP;
            }
            const state = event.get_state();
            if ((state & Clutter.ModifierType.CONTROL_MASK) &&
                (sym === Clutter.KEY_c || sym === Clutter.KEY_C)) {
                const focused = global.stage.get_key_focus();
                if (focused instanceof Clutter.Text) {
                    const sel = focused.get_selection();
                    if (sel && sel.length > 0) {
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, sel);
                        return Clutter.EVENT_STOP;
                    }
                }
            }
        }

        // Hold-to-talk key release
        if (type === Clutter.EventType.KEY_RELEASE && this._holdToTalk) {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Control_L || sym === Clutter.KEY_Control_R ||
                sym === Clutter.KEY_space) {
                this._holdToTalkEnd();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _buildUI() {

        // ── Message panel (top of screen — slides down) ──
        this._messagePanel = new St.BoxLayout({
            style_class: 'aether-message-panel',
            vertical: true,
            reactive: true,
            can_focus: false,
            clip_to_allocation: true,
        });
        this._messagePanel.set_pivot_point(0.5, 0.0);
        this.add_child(this._messagePanel);

        // Header bar (minimal - just title, no container styling)
        // const headerTitle = new St.Label({
        // style_class: 'aether-header-title',
        // text: 'AETHER',
        // y_align: Clutter.ActorAlign.CENTER,
        // });
        // this._messagePanel.add_child(headerTitle);

        // Output scroll area (messages)
        this._outputScroll = new St.ScrollView({
            style_class: 'aether-output-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            clip_to_allocation: true,
        });
        this._outputScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._messagePanel.add_child(this._outputScroll);

        this._outputBox = new St.BoxLayout({
            style_class: 'aether-output-box',
            vertical: true,
            x_expand: true,
        });
        this._outputBox.get_layout_manager().spacing = 10;
        this._outputScroll.set_child(this._outputBox);

        // ── History panel (hidden by default) ──
        this._historyHeader = new St.BoxLayout({
            style_class: 'aether-history-header',
            x_expand: true,
            visible: false,
        });
        this._historyHeader.get_layout_manager().spacing = 8;
        this._historyHeader.set_style('padding: 6px 12px;');

        const backBtn = new St.Button({
            style_class: 'aether-new-chat-btn',
            child: new St.Icon({
                icon_name: 'go-previous-symbolic',
                icon_size: 16,
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        backBtn.connect('clicked', () => this._hideHistory());
        this._historyHeader.add_child(backBtn);

        const historyTitle = new St.Label({
            style_class: 'aether-bubble-role',
            text: 'Chat History',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._historyHeader.add_child(historyTitle);

        this._messagePanel.insert_child_at_index(this._historyHeader, 0);

        this._historyScroll = new St.ScrollView({
            style_class: 'aether-history-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            visible: false,
        });
        this._historyScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._historyBox = new St.BoxLayout({
            style_class: 'aether-history-box',
            vertical: true,
            x_expand: true,
        });
        this._historyBox.get_layout_manager().spacing = 4;
        this._historyScroll.set_child(this._historyBox);
        this._messagePanel.insert_child_above(this._historyScroll, this._historyHeader);

        // Status bar (bottom of message panel)
        this._statusBar = new St.Label({
            style_class: 'aether-status-bar',
            text: '',
            x_expand: true,
        });
        this._messagePanel.add_child(this._statusBar);

        // ── Input bar (bottom of screen — slides up) ──
        this._inputBar = new St.BoxLayout({
            style_class: 'aether-input-bar',
            vertical: false,
            reactive: true,
            can_focus: true,
        });
        this._inputBar.set_pivot_point(0.5, 1.0);
        this._inputBar.get_layout_manager().spacing = 8;
        this.add_child(this._inputBar);

        this._micButton = new St.Button({
            style_class: 'aether-mic-button',
            child: new St.Icon({
                icon_name: 'audio-input-microphone-symbolic',
                icon_size: 18,
            }),
        });
        this._micButton.connect('clicked', () => this._toggleMic());
        this._inputBar.add_child(this._micButton);

        this._newChatBtn = new St.Button({
            style_class: 'aether-new-chat-btn',
            child: new St.Icon({
                icon_name: 'list-add-symbolic',
                icon_size: 18,
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._newChatBtn.connect('clicked', () => this._onNewChat());
        this._inputBar.add_child(this._newChatBtn);

        this._historyBtn = new St.Button({
            style_class: 'aether-new-chat-btn',
            child: new St.Icon({
                icon_name: 'document-open-recent-symbolic',
                icon_size: 18,
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._historyBtn.connect('clicked', () => this._toggleHistory());
        this._inputBar.add_child(this._historyBtn);

        this._entry = new St.Entry({
            style_class: 'aether-entry',
            hint_text: 'Ask Aether anything...',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => {
            this._onSubmit().catch(e => this._addStatus(`Error: ${e.message}`, 'error'));
        });
        this._inputBar.add_child(this._entry);

        this._sendButton = new St.Button({
            style_class: 'aether-send-button',
            child: new St.Icon({
                icon_name: 'go-next-symbolic',
                icon_size: 18,
            }),
        });
        this._sendButton.connect('clicked', () => {
            if (this._isProcessing) {
                this._stopProcessing();
            } else {
                this._onSubmit().catch(e => this._addStatus(`Error: ${e.message}`, 'error'));
            }
        });
        this._inputBar.add_child(this._sendButton);

        // ── Glow animation (input bar only — message panel is transparent) ──
        this._inputAuroraAnim = new GlowAnimation(this._inputBar, 'aether-aurora', false);
    }

    // ── Status feedback ──

    _setStatus(text) {
        this._statusBar.set_text(text);
    }

    _addStatus(text, type = 'info') {
        const styleClass = type === 'error' ? 'aether-status-error'
            : type === 'tool' ? 'aether-status-tool'
            : 'aether-status-info';

        const row = new St.BoxLayout({
            style_class: `aether-status-row ${styleClass}`,
            x_expand: true,
        });
        row.get_layout_manager().spacing = 8;

        const icon = new St.Icon({
            icon_name: type === 'error' ? 'dialog-error-symbolic'
                : type === 'tool' ? 'utilities-terminal-symbolic'
                : 'dialog-information-symbolic',
            icon_size: 12,
            style_class: 'aether-status-icon',
        });
        row.add_child(icon);

        const label = new St.Label({
            text: text,
            style_class: 'aether-status-text',
            x_expand: true,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        row.add_child(label);

        this._outputBox.add_child(row);
        this._scrollToBottom();
    }

    // ── Collapsible Tool Container ──

    _createToolContainer() {
        const wrapper = new St.BoxLayout({
            style_class: 'aether-tool-container',
            vertical: true,
            x_expand: true,
            clip_to_allocation: true,
        });

        const headerBtn = new St.Button({
            style_class: 'aether-tool-header',
            x_expand: true,
        });

        const headerBox = new St.BoxLayout({x_expand: true});
        headerBox.get_layout_manager().spacing = 6;
        headerBtn.set_child(headerBox);

        const headerIcon = new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            icon_size: 12,
            style_class: 'aether-tool-header-icon',
        });
        headerBox.add_child(headerIcon);

        const headerLabel = new St.Label({
            style_class: 'aether-tool-header-text',
            text: 'Actions',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(headerLabel);

        const chevron = new St.Label({
            style_class: 'aether-tool-chevron',
            text: '▾',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(chevron);

        wrapper.add_child(headerBtn);

        const body = new St.BoxLayout({
            style_class: 'aether-tool-body',
            vertical: true,
            x_expand: true,
        });
        body.get_layout_manager().spacing = 2;
        wrapper.add_child(body);

        headerBtn.connect('clicked', () => {
            if (body.visible) {
                body.hide();
                chevron.set_text('▸');
            } else {
                body.show();
                chevron.set_text('▾');
            }
        });

        wrapper._body = body;
        wrapper._headerLabel = headerLabel;
        wrapper._chevron = chevron;
        wrapper._actionCount = 0;

        this._outputBox.add_child(wrapper);
        return wrapper;
    }

    _addToolStatus(container, text, type = 'tool') {
        if (!container || !container._body)
            return;

        const styleClass = type === 'error' ? 'aether-status-error'
            : type === 'tool' ? 'aether-status-tool'
            : 'aether-status-info';

        const row = new St.BoxLayout({
            style_class: `aether-status-row ${styleClass}`,
            x_expand: true,
        });
        row.get_layout_manager().spacing = 8;

        const icon = new St.Icon({
            icon_name: type === 'error' ? 'dialog-error-symbolic'
                : type === 'tool' ? 'utilities-terminal-symbolic'
                : 'dialog-information-symbolic',
            icon_size: 12,
            style_class: 'aether-status-icon',
        });
        row.add_child(icon);

        const label = new St.Label({
            text: text,
            style_class: 'aether-status-text',
            x_expand: true,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        row.add_child(label);

        container._body.add_child(row);

        if (text.startsWith('Running:')) {
            container._actionCount++;
            const n = container._actionCount;
            container._headerLabel.set_text(`${n} action${n > 1 ? 's' : ''}`);
        }

        this._scrollToBottom();
    }

    _collapseToolContainer(container) {
        if (!container || !container._body)
            return;
        container._body.hide();
        container._chevron.set_text('▸');
    }

    // ── Position ──

    _positionPanels() {
        const monitor = Main.layoutManager.primaryMonitor;
        const inputY = monitor.height - INPUT_BAR_BOTTOM_MARGIN - INPUT_BAR_HEIGHT;
        // Calculate full available height from top margin to above input bar
        const maxH = inputY - MESSAGE_PANEL_TOP_MARGIN - INPUT_BAR_TOP_MARGIN;

        // Message panel: centered horizontally, at top
        const msgX = Math.round((monitor.width - MESSAGE_PANEL_WIDTH) / 2);
        this._messagePanel.set_position(msgX, MESSAGE_PANEL_TOP_MARGIN);
        this._messagePanel.set_size(MESSAGE_PANEL_WIDTH, maxH);
        this._messagePanel.set_style(`max-height: ${maxH}px;`);

        // Input bar: centered horizontally, at bottom
        const inputX = Math.round((monitor.width - INPUT_BAR_WIDTH) / 2);
        this._inputBar.set_position(inputX, inputY);

        // Store positions for animations
        this._msgRestY = MESSAGE_PANEL_TOP_MARGIN;
        this._msgOffY = -maxH - 60; // off-screen above
        this._inputRestY = inputY;
        this._inputOffY = monitor.height + 20; // off-screen below
    }

    _scrollToBottom() {
        const adj = this._outputScroll.vadjustment;
        if (adj) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                adj.value = adj.upper - adj.page_size;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // ── Open / Close / Toggle ──

    toggle() {
        if (this._isOpen)
            this._fullClose();
        else
            this.open();
    }

    open() {
        if (this._isOpen)
            return;

        this._isOpen = true;
        this._positionPanels();
        this._applyTheme();
        this._setStatus('');
        this.show();

        // Start panels off-screen
        this._messagePanel.set_position(this._messagePanel.x, this._msgOffY);
        this._messagePanel.opacity = 0;
        this._inputBar.set_position(this._inputBar.x, this._inputOffY);
        this._inputBar.opacity = 0;

        // Message panel slide down from top
        this._messagePanel.ease({
            y: this._msgRestY,
            opacity: 255,
            duration: 450,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        // Input bar slide up from bottom (slight delay)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            if (!this._isOpen) return GLib.SOURCE_REMOVE;
            this._inputBar.ease({
                y: this._inputRestY,
                opacity: 255,
                duration: 400,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            return GLib.SOURCE_REMOVE;
        });

        // Focus the text entry (no modal needed)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        // Connect close-on-outside signals
        this._stageEventId = global.stage.connect(
            'captured-event', this._onStageEvent.bind(this));
        this._focusWindowId = global.display.connect(
            'notify::focus-window', () => {
                if (this._isOpen && global.display.focus_window)
                    this._fullClose();
            });
        this._overviewShowId = Main.overview.connect('showing', () => {
            if (this._isOpen)
                this._fullClose();
        });

        // Start aurora glow on input bar
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._isOpen) {
                this._inputAuroraAnim.setState(AnimationState.IDLE);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _fullClose() {
        if (this._isProcessing) {
            this._conversation.cancel();
            this._isProcessing = false;
            this._sendButton.child.icon_name = 'go-next-symbolic';
            this._sendButton.remove_style_class_name('aether-stop-button');
        }

        this._holdToTalk = false;
        this._discardSttCallback = true;
        this._micButton.child.icon_name = 'audio-input-microphone-symbolic';
        this._micButton.remove_style_class_name('aether-mic-recording');

        this.close();
    }

    close() {
        if (!this._isOpen)
            return;

        this._isOpen = false;
        this._holdToTalk = false;
        this._discardSttCallback = true;
        this._inputAuroraAnim.setState(AnimationState.OFF);

        // Disconnect close-on-outside signals
        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._overviewShowId) {
            Main.overview.disconnect(this._overviewShowId);
            this._overviewShowId = 0;
        }

        // Force-kill recording without triggering transcription
        if (this._stt.isRecording) {
            if (this._stt._recordProc) {
                this._stt._recordProc.force_exit();
                this._stt._recordProc = null;
            }
            this._stt._isRecording = false;
            if (this._stt._silenceTimeoutId) {
                GLib.source_remove(this._stt._silenceTimeoutId);
                this._stt._silenceTimeoutId = null;
            }
        }

        // Message panel slide up (out)
        this._messagePanel.ease({
            y: this._msgOffY,
            opacity: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
        });

        // Input bar slide down (out)
        this._inputBar.ease({
            y: this._inputOffY,
            opacity: 0,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this.hide();
            },
        });
    }

    // ── Glow state helper ──

    _setGlowState(state) {
        this._inputAuroraAnim.setState(state);
    }

    // ── Hold-to-Talk ──

    holdToTalkStart() {
        if (this._holdToTalk)
            return;

        if (this._isOpen && !this._isProcessing) {
            this._fullClose();
            return;
        }

        if (this._isProcessing) {
            this._stopProcessing();
            return;
        }

        if (!this._isOpen)
            this.open();

        if (!this._isOpen)
            return;

        this._holdToTalk = true;
        this._discardSttCallback = false;
        this._setGlowState(AnimationState.LISTENING);
        this._micButton.child.icon_name = 'media-record-symbolic';
        this._micButton.add_style_class_name('aether-mic-recording');
        this._setStatus('Listening... (release to send)');

        this._stt.startRecording((transcription) => {
            if (this._discardSttCallback || !this._isOpen) {
                this._holdToTalk = false;
                return;
            }

            this._micButton.remove_style_class_name('aether-mic-recording');
            this._micButton.child.icon_name = 'audio-input-microphone-symbolic';
            this._holdToTalk = false;

            if (transcription && !transcription.startsWith('(')) {
                this._setGlowState(AnimationState.THINKING);
                this._setStatus('Transcribed, sending...');
                this._entry.set_text(transcription);
                this._onSubmit().catch(e =>
                    this._addStatus(`Error: ${e.message}`, 'error'));
            } else {
                this._setGlowState(AnimationState.IDLE);
                this._setStatus('');
            }
        }, true);
    }

    _holdToTalkEnd() {
        if (!this._holdToTalk)
            return;

        this._holdToTalk = false;
        this._setStatus('Transcribing...');
        this._setGlowState(AnimationState.THINKING);
        this._micButton.child.icon_name = 'audio-input-microphone-symbolic';
        this._micButton.remove_style_class_name('aether-mic-recording');

        this._stt.stopRecording();
    }

    // ── New Chat ──

    _onNewChat() {
        const newSessionId = generateSessionId();
        this._conversation.reset(newSessionId);

        this._outputBox.destroy_all_children();
        this._currentToolContainer = null;
        this._setStatus('');
        this._entry.set_text('');

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── History panel ──

    _toggleHistory() {
        if (this._historyMode)
            this._hideHistory();
        else
            this._showHistory();
    }

    async _showHistory() {
        this._historyMode = true;
        this._outputScroll.hide();
        this._statusBar.hide();
        this._historyHeader.show();
        this._historyScroll.show();
        this._historyBox.destroy_all_children();

        try {
            const sessions = await this._memory.getSessionList(30);

            if (sessions.length === 0) {
                const emptyLabel = new St.Label({
                    style_class: 'aether-bubble-content',
                    text: 'No conversation history yet.',
                    x_expand: true,
                });
                emptyLabel.set_style('padding: 16px; opacity: 150;');
                this._historyBox.add_child(emptyLabel);
                return;
            }

            for (const session of sessions) {
                const isActive = session.session_id === this._conversation.sessionId;

                const row = new St.Button({
                    style_class: `aether-history-row${isActive ? ' aether-history-row-active' : ''}`,
                    x_expand: true,
                    can_focus: true,
                });

                const rowBox = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                });
                rowBox.get_layout_manager().spacing = 3;

                const headerBox = new St.BoxLayout({x_expand: true});
                headerBox.get_layout_manager().spacing = 8;

                const dateLabel = new St.Label({
                    style_class: 'aether-bubble-role',
                    text: this._formatSessionDate(session.started_at),
                    x_expand: true,
                });
                headerBox.add_child(dateLabel);

                const countLabel = new St.Label({
                    style_class: 'aether-status-text',
                    text: `${session.message_count} msgs`,
                });
                countLabel.set_style('opacity: 150; font-size: 11px;');
                headerBox.add_child(countLabel);

                if (isActive) {
                    const badge = new St.Label({
                        text: 'CURRENT',
                    });
                    badge.set_style('font-size: 10px; font-weight: bold; color: #88aaff;');
                    headerBox.add_child(badge);
                }

                rowBox.add_child(headerBox);

                if (session.first_message) {
                    const preview = session.first_message.length > 120
                        ? session.first_message.slice(0, 120) + '...'
                        : session.first_message;
                    const previewLabel = new St.Label({
                        style_class: 'aether-bubble-content',
                        text: preview,
                        x_expand: true,
                    });
                    previewLabel.set_style('font-size: 12px; opacity: 200;');
                    previewLabel.clutter_text.set_line_wrap(true);
                    previewLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                    previewLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                    rowBox.add_child(previewLabel);
                }

                row.set_child(rowBox);

                row.connect('clicked', () => {
                    if (isActive) {
                        this._hideHistory();
                    } else {
                        this._loadSession(session.session_id).catch(e =>
                            console.error(`[Aether] Load session error: ${e.message}`));
                    }
                });

                this._historyBox.add_child(row);
            }
        } catch (e) {
            const errLabel = new St.Label({
                style_class: 'aether-bubble-content',
                text: `Failed to load history: ${e.message}`,
                x_expand: true,
            });
            this._historyBox.add_child(errLabel);
            console.error(`[Aether] History load error: ${e.message}`);
        }
    }

    _hideHistory() {
        this._historyMode = false;
        this._historyHeader.hide();
        this._historyScroll.hide();
        this._outputScroll.show();
        this._statusBar.show();
    }

    async _loadSession(sessionId) {
        this._hideHistory();

        // Restore conversation context from DB
        await this._conversation.restoreSession(sessionId);

        // Save as last session
        try {
            this._settings.set_string('last-session-id', sessionId);
        } catch {
            // Non-fatal
        }

        // Render messages in the output box
        this.loadSessionMessages(this._conversation.messages);
    }

    /**
     * Render an array of messages into the output box.
     * Used for session restoration (after screen lock or history load).
     */
    loadSessionMessages(messages) {
        this._outputBox.destroy_all_children();
        this._currentToolContainer = null;

        for (const msg of messages) {
            if (msg.role === 'user') {
                this._addBubble('user', msg.content);
            } else if (msg.role === 'assistant' && msg.content) {
                this._addBubble('assistant', msg.content);
            }
            // Skip tool and system messages for display
        }
    }

    _formatSessionDate(isoStr) {
        if (!isoStr) return 'Unknown';
        try {
            // SQLite datetime format: "2026-02-22 14:30:00"
            const parts = isoStr.split(' ');
            const datePart = parts[0];
            const timePart = parts[1] ? parts[1].slice(0, 5) : '';

            const now = new Date();
            const today = now.toISOString().split('T')[0];
            const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];

            if (datePart === today)
                return `Today, ${timePart}`;
            else if (datePart === yesterday)
                return `Yesterday, ${timePart}`;
            else
                return `${datePart} ${timePart}`;
        } catch {
            return isoStr;
        }
    }

    // ── Stop / Cancel ──

    _stopProcessing() {
        if (!this._isProcessing)
            return;

        this._conversation.cancel();

        if (this._stt.isRecording)
            this._stt.stopRecording();

        this._isProcessing = false;
        this._holdToTalk = false;
        this._setGlowState(AnimationState.IDLE);
        this._setStatus('Stopped');
        this._sendButton.child.icon_name = 'go-next-symbolic';
        this._sendButton.remove_style_class_name('aether-stop-button');
    }

    // ── Submit message ──

    async _onSubmit() {
        const text = this._entry.get_text().trim();
        if (!text || this._isProcessing)
            return;

        this._entry.set_text('');
        this._isProcessing = true;
        this._setGlowState(AnimationState.THINKING);

        this._sendButton.child.icon_name = 'process-stop-symbolic';
        this._sendButton.add_style_class_name('aether-stop-button');

        this._addBubble('user', text);
        this._setStatus('Thinking...');

        const toolContainer = this._createToolContainer();
        toolContainer.hide();

        const responseBubble = this._createEmptyBubble('assistant');

        const origExecute = this._conversation._toolRegistry.execute.bind(
            this._conversation._toolRegistry
        );

        try {
            let streamedText = '';

            this._conversation._toolRegistry.execute = async (name, args) => {
                if (!toolContainer.visible)
                    toolContainer.show();

                let argsDisplay = '';
                try {
                    argsDisplay = JSON.stringify(args, null, 0);
                    if (argsDisplay.length > 120)
                        argsDisplay = argsDisplay.slice(0, 120) + '...';
                } catch { argsDisplay = '...'; }

                this._addToolStatus(toolContainer, `Running: ${name}(${argsDisplay})`, 'tool');
                this._setStatus(`Executing: ${name}...`);

                const result = await origExecute(name, args);

                const preview = typeof result === 'string' ? result : JSON.stringify(result);
                const shortResult = preview.length > 200
                    ? preview.slice(0, 200) + '...'
                    : preview;
                this._addToolStatus(toolContainer, `Result: ${shortResult}`, 'tool');
                this._setStatus('Thinking...');

                return result;
            };

            const response = await this._conversation.send(text, (chunk) => {
                streamedText += chunk;
                this._setStreamingText(responseBubble, streamedText);
                this._scrollToBottom();
            });

            this._conversation._toolRegistry.execute = origExecute;

            if (toolContainer.visible)
                this._collapseToolContainer(toolContainer);

            const finalText = streamedText || response;
            this._renderMarkdownBubble(responseBubble, finalText);

            this._setStatus('');

            if (this._tts.enabled)
                this._tts.speak(finalText);

        } catch (e) {
            this._conversation._toolRegistry.execute = origExecute;

            const msg = e.message || '';
            const isCancelled = msg.includes('ancelled') || msg.includes('IOErrorEnum');
            if (isCancelled) {
                this._setStreamingText(responseBubble, '(Stopped)');
                this._setStatus('Stopped');
            } else {
                this._setStreamingText(responseBubble, `Error: ${msg}`);
                responseBubble.add_style_class_name('aether-error-text');
                this._setStatus(`Error: ${msg}`);
                console.error(`[Aether] Submit error: ${msg}\n${e.stack}`);
            }

            if (toolContainer.visible)
                this._collapseToolContainer(toolContainer);
        }

        if (!toolContainer.visible) {
            try { this._outputBox.remove_child(toolContainer); } catch {}
        }

        this._isProcessing = false;
        this._sendButton.child.icon_name = 'go-next-symbolic';
        this._sendButton.remove_style_class_name('aether-stop-button');
        this._setGlowState(AnimationState.IDLE);
        this._scrollToBottom();
    }

    // ── Chat bubbles ──

    _addBubble(role, text) {
        const isUser = role === 'user';
        const bubble = new St.BoxLayout({
            style_class: `aether-bubble aether-bubble-${role}`,
            vertical: true,
            x_expand: !isUser,
            x_align: isUser ? Clutter.ActorAlign.END : Clutter.ActorAlign.FILL,
            clip_to_allocation: true,
        });
        bubble.get_layout_manager().spacing = 3;

        const roleLabel = new St.Label({
            style_class: 'aether-bubble-role',
            text: isUser ? 'You' : 'Aether',
        });
        bubble.add_child(roleLabel);

        if (role === 'assistant') {
            this._renderMarkdownContent(bubble, text);
        } else {
            const contentLabel = new St.Label({
                style_class: 'aether-bubble-content',
                text: text,
                x_expand: true,
            });
            contentLabel.clutter_text.set_line_wrap(true);
            contentLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            contentLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            makeSelectable(contentLabel);
            bubble.add_child(contentLabel);
        }

        this._outputBox.add_child(bubble);
        this._scrollToBottom();
        return bubble;
    }

    _createEmptyBubble(role) {
        const bubble = new St.BoxLayout({
            style_class: `aether-bubble aether-bubble-${role}`,
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            clip_to_allocation: true,
        });
        bubble.get_layout_manager().spacing = 3;

        const roleLabel = new St.Label({
            style_class: 'aether-bubble-role',
            text: 'Aether',
        });
        bubble.add_child(roleLabel);

        const contentLabel = new St.Label({
            style_class: 'aether-bubble-content',
            text: '',
            x_expand: true,
        });
        contentLabel.clutter_text.set_line_wrap(true);
        contentLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        contentLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        makeSelectable(contentLabel);
        bubble.add_child(contentLabel);
        bubble._streamLabel = contentLabel;

        this._outputBox.add_child(bubble);
        this._scrollToBottom();
        return bubble;
    }

    _setStreamingText(bubble, text) {
        if (bubble._streamLabel)
            bubble._streamLabel.set_text(text);
    }

    _renderMarkdownBubble(bubble, text) {
        if (bubble._streamLabel) {
            bubble.remove_child(bubble._streamLabel);
            bubble._streamLabel = null;
        }
        this._renderMarkdownContent(bubble, text);
    }

    _renderMarkdownContent(container, text) {
        if (!text) return;

        const blocks = parseMarkdownBlocks(text);

        for (const block of blocks) {
            if (block.type === 'heading') {
                const label = new St.Label({
                    style_class: `aether-heading aether-heading-${block.level}`,
                    x_expand: true,
                });
                label.clutter_text.set_line_wrap(true);
                label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                label.clutter_text.set_markup(markdownToPango(block.content));
                makeSelectable(label);
                container.add_child(label);

            } else if (block.type === 'code') {
                const codeBox = new St.BoxLayout({
                    style_class: 'aether-code-block',
                    vertical: true,
                    x_expand: true,
                    clip_to_allocation: true,
                });

                if (block.lang) {
                    const langLabel = new St.Label({
                        style_class: 'aether-code-block-header',
                        text: block.lang,
                    });
                    codeBox.add_child(langLabel);
                }

                const codeLabel = new St.Label({
                    style_class: 'aether-code-block-text',
                    text: block.content,
                    x_expand: true,
                });
                codeLabel.clutter_text.set_line_wrap(true);
                codeLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                codeLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                makeSelectable(codeLabel);
                codeBox.add_child(codeLabel);

                container.add_child(codeBox);

            } else if (block.type === 'list') {
                for (const item of block.content) {
                    const row = new St.BoxLayout({
                        style_class: 'aether-list-item',
                        x_expand: true,
                    });
                    row.get_layout_manager().spacing = 6;

                    const bullet = new St.Label({
                        style_class: 'aether-list-bullet',
                        text: '•',
                        y_align: Clutter.ActorAlign.START,
                    });
                    row.add_child(bullet);

                    const itemLabel = new St.Label({
                        style_class: 'aether-list-text',
                        x_expand: true,
                    });
                    itemLabel.clutter_text.set_line_wrap(true);
                    itemLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                    itemLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                    itemLabel.clutter_text.set_markup(markdownToPango(item));
                    makeSelectable(itemLabel);
                    row.add_child(itemLabel);

                    container.add_child(row);
                }

            } else if (block.type === 'table') {
                // Table rendering
                const tableBox = new St.BoxLayout({
                    style_class: 'aether-table-container',
                    vertical: true,
                    x_expand: true,
                    clip_to_allocation: true,
                });

                // Header row
                if (block.headers && block.headers.length > 0) {
                    const headerBox = new St.BoxLayout({
                        style_class: 'aether-table-row aether-table-header',
                        x_expand: true,
                    });

                    for (const header of block.headers) {
                        const cellBox = new St.BoxLayout({
                            style_class: 'aether-table-cell aether-table-cell-header',
                            vertical: false,
                            x_expand: true,
                        });
                        const cellLabel = new St.Label({
                            style_class: 'aether-table-cell-text',
                            x_expand: true,
                        });
                        cellLabel.clutter_text.set_markup(markdownToPango(header));
                        cellLabel.clutter_text.set_line_wrap(true);
                        cellLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                        cellLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                        makeSelectable(cellLabel);
                        cellBox.add_child(cellLabel);
                        headerBox.add_child(cellBox);
                    }
                    tableBox.add_child(headerBox);
                }

                // Data rows
                if (block.rows && block.rows.length > 0) {
                    for (const row of block.rows) {
                        const rowBox = new St.BoxLayout({
                            style_class: 'aether-table-row',
                            x_expand: true,
                        });

                        for (const cell of row) {
                            const cellBox = new St.BoxLayout({
                                style_class: 'aether-table-cell',
                                vertical: false,
                                x_expand: true,
                            });
                            const cellLabel = new St.Label({
                                style_class: 'aether-table-cell-text',
                                x_expand: true,
                            });
                            cellLabel.clutter_text.set_markup(markdownToPango(cell));
                            cellLabel.clutter_text.set_line_wrap(true);
                            cellLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                            cellLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                            makeSelectable(cellLabel);
                            cellBox.add_child(cellLabel);
                            rowBox.add_child(cellBox);
                        }
                        tableBox.add_child(rowBox);
                    }
                }

                container.add_child(tableBox);

            } else if (block.type === 'image') {
                // Image support - load async and display
                const imageBox = new St.BoxLayout({
                    style_class: 'aether-image-container',
                    vertical: true,
                    x_expand: true,
                });
                
                const placeholderLabel = new St.Label({
                    style_class: 'aether-image-placeholder',
                    text: `📷 Loading image...`,
                });
                imageBox.add_child(placeholderLabel);
                container.add_child(imageBox);

                // Async image loading
                this._loadImage(block.url, imageBox, placeholderLabel, block.alt);

            } else {
                const label = new St.Label({
                    style_class: 'aether-bubble-content',
                    x_expand: true,
                });
                label.clutter_text.set_line_wrap(true);
                label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                label.clutter_text.set_markup(markdownToPango(block.content));
                makeSelectable(label);
                container.add_child(label);
            }
        }
    }

    // Load image from URI and display in container via St.TextureCache
    _loadImage(url, container, placeholder, altText) {
        try {
            const file = Gio.File.new_for_uri(url);
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const actor = St.TextureCache.get_default().load_file_async(
                file, 500, -1, scaleFactor, scaleFactor
            );
            container.remove_child(placeholder);
            container.add_child(actor);
        } catch (e) {
            placeholder.set_text(`[Image: ${altText || url}]`);
        }
    }

    // ── Mic toggle (button click) ──

    _toggleMic() {
        if (this._stt.isRecording) {
            this._stt.stopRecording();
            this._setGlowState(AnimationState.THINKING);
            this._micButton.child.icon_name = 'audio-input-microphone-symbolic';
            this._setStatus('Transcribing...');
        } else {
            this._setGlowState(AnimationState.LISTENING);
            this._micButton.child.icon_name = 'media-record-symbolic';
            this._micButton.add_style_class_name('aether-mic-recording');
            this._setStatus('Listening...');

            this._stt.startRecording((transcription) => {
                this._micButton.remove_style_class_name('aether-mic-recording');
                this._micButton.child.icon_name = 'audio-input-microphone-symbolic';
                this._setGlowState(AnimationState.IDLE);
                this._setStatus('');

                if (transcription && !transcription.startsWith('(')) {
                    this._entry.set_text(transcription);
                    this._onSubmit().catch(e =>
                        this._addStatus(`Error: ${e.message}`, 'error'));
                }
            });
        }
    }

    async sendMessage(text) {
        try {
            return await this._conversation.send(text);
        } catch (e) {
            return `Error: ${e.message}`;
        }
    }

    clearOutput() {
        this._outputBox.destroy_all_children();
        this._currentToolContainer = null;
    }

    destroy() {
        this._fullClose();

        // Safety: disconnect signals if still connected
        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._overviewShowId) {
            Main.overview.disconnect(this._overviewShowId);
            this._overviewShowId = 0;
        }

        if (this._inputAuroraAnim)
            this._inputAuroraAnim.destroy();
        this._ifaceSettings = null;
        super.destroy();
    }
});
