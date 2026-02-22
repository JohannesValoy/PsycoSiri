import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

function makeSelectable(label) {
    label.reactive = true;
    const ct = label.clutter_text;
    ct.set_selectable(true);
    ct.set_editable(false);
    ct.set_cursor_visible(false);
}

export const AgentIndicator = GObject.registerClass(
class AgentIndicator extends PanelMenu.Button {
    _init(agentManager, settings) {
        super._init(0.5, 'Aether Agents', false);

        this._agentManager = agentManager;
        this._settings = settings;
        this._spinnerTimeoutId = null;
        this._checkmarkTimeoutId = null;
        this._rebuildDebounceId = null;
        this._expandedTools = new Set(); // track which agent tool logs are expanded

        this._buildIcon();
        this._buildMenu();

        this._stealthId = this._settings.connect('changed::stealth-mode', () => {
            this._updateVisibility();
        });
        this._updateVisibility();

        this._agentManager.setOnStateChange((runId, run) => {
            this._onAgentStateChange(runId, run);
        });
    }

    _buildIcon() {
        this._iconBox = new St.BoxLayout({
            style_class: 'aether-agent-icon-box',
        });
        this._iconBox.get_layout_manager().spacing = 4;

        this._icon = new St.Icon({
            icon_name: 'system-run-symbolic',
            style_class: 'system-status-icon aether-agent-icon',
        });
        this._iconBox.add_child(this._icon);

        this._badge = new St.Label({
            style_class: 'aether-agent-badge',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._badge.hide();
        this._iconBox.add_child(this._badge);

        this.add_child(this._iconBox);
    }

    _buildMenu() {
        // Custom popup content using St widgets instead of PopupMenuItems
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._container = new St.BoxLayout({
            style_class: 'aether-agent-popup',
            vertical: true,
            x_expand: true,
        });
        this._container.get_layout_manager().spacing = 6;
        menuItem.add_child(this._container);

        // Header
        const header = new St.BoxLayout({
            style_class: 'aether-agent-popup-header',
            x_expand: true,
        });
        header.get_layout_manager().spacing = 8;

        const headerIcon = new St.Icon({
            icon_name: 'system-run-symbolic',
            icon_size: 14,
            style_class: 'aether-agent-popup-header-icon',
        });
        header.add_child(headerIcon);

        const headerLabel = new St.Label({
            style_class: 'aether-agent-popup-header-text',
            text: 'AETHER AGENTS',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(headerLabel);

        this._container.add_child(header);

        // Scroll area for agent list
        this._scroll = new St.ScrollView({
            style_class: 'aether-agent-popup-scroll',
            x_expand: true,
            overlay_scrollbars: true,
        });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._agentList = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        this._agentList.get_layout_manager().spacing = 4;
        this._scroll.set_child(this._agentList);
        this._container.add_child(this._scroll);

        this.menu.addMenuItem(menuItem);

        // Ctrl+C → copy selected text from agent popup
        this.menu.actor.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const sym = event.get_key_symbol();
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
            return Clutter.EVENT_PROPAGATE;
        });

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuildAgentList();
        });
    }

    _rebuildAgentList() {
        this._agentList.destroy_all_children();

        const agents = this._agentManager.listAgents();

        if (agents.length === 0) {
            const empty = new St.Label({
                style_class: 'aether-agent-empty',
                text: 'No agents have been run yet',
                x_expand: true,
            });
            this._agentList.add_child(empty);
            return;
        }

        const sorted = [...agents].reverse();

        for (const agent of sorted) {
            const card = this._buildAgentCard(agent);
            this._agentList.add_child(card);
        }
    }

    _buildAgentCard(agent) {
        const card = new St.BoxLayout({
            style_class: `aether-agent-card aether-agent-card-${agent.state}`,
            vertical: true,
            x_expand: true,
        });
        card.get_layout_manager().spacing = 4;

        // ── Card header (status + name + stop button) ──
        const headerRow = new St.BoxLayout({
            style_class: 'aether-agent-card-header',
            x_expand: true,
        });
        headerRow.get_layout_manager().spacing = 8;

        // Status icon
        const statusIconName = agent.state === 'running' ? 'process-working-symbolic'
            : agent.state === 'completed' ? 'emblem-ok-symbolic'
            : 'dialog-warning-symbolic';
        const statusIcon = new St.Icon({
            icon_name: statusIconName,
            icon_size: 14,
            style_class: `aether-agent-status-icon aether-agent-status-${agent.state}`,
        });
        headerRow.add_child(statusIcon);

        // Agent name + tool call count
        const callCountText = agent.toolCallCount > 0
            ? ` (${agent.toolCallCount} call${agent.toolCallCount !== 1 ? 's' : ''})`
            : '';
        const nameLabel = new St.Label({
            style_class: 'aether-agent-card-name',
            text: `${agent.agentName}${callCountText}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(nameLabel);

        // Stop button (only for running agents)
        if (agent.state === 'running') {
            const stopBtn = new St.Button({
                style_class: 'aether-agent-stop-btn',
                child: new St.Icon({
                    icon_name: 'process-stop-symbolic',
                    icon_size: 14,
                }),
            });
            stopBtn.connect('clicked', () => {
                this._agentManager.cancelAgent(agent.id);
                this._rebuildAgentList();
            });
            headerRow.add_child(stopBtn);
        }

        card.add_child(headerRow);

        // ── Task description ──
        const taskLabel = new St.Label({
            style_class: 'aether-agent-card-task',
            text: agent.task,
            x_expand: true,
        });
        taskLabel.clutter_text.set_line_wrap(true);
        taskLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        taskLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        makeSelectable(taskLabel);
        card.add_child(taskLabel);

        // ── Todo / plan checklist ──
        if (agent.todos && agent.todos.length > 0) {
            const todoBox = new St.BoxLayout({
                style_class: 'aether-agent-todo-box',
                vertical: true,
                x_expand: true,
            });
            todoBox.get_layout_manager().spacing = 2;

            for (const todo of agent.todos) {
                const row = new St.BoxLayout({x_expand: true});
                row.get_layout_manager().spacing = 6;

                const check = new St.Label({
                    style_class: todo.done
                        ? 'aether-agent-todo-check-done'
                        : 'aether-agent-todo-check',
                    text: todo.done ? '✓' : '○',
                });
                row.add_child(check);

                const label = new St.Label({
                    style_class: todo.done
                        ? 'aether-agent-todo-text-done'
                        : 'aether-agent-todo-text',
                    text: todo.text,
                    x_expand: true,
                });
                label.clutter_text.set_line_wrap(true);
                label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                makeSelectable(label);
                row.add_child(label);

                todoBox.add_child(row);
            }

            card.add_child(todoBox);
        }

        // ── Collapsible tool log (mirrors overlay's _createToolContainer) ──
        const log = this._agentManager.getRunLog(agent.id);
        const toolCalls = log.filter(l => l.type === 'tool_call');
        const responses = log.filter(l => l.type === 'response');
        const errors = log.filter(l => l.type === 'error');

        if (toolCalls.length > 0 || errors.length > 0) {
            const isExpanded = this._expandedTools.has(agent.id);

            const toolContainer = new St.BoxLayout({
                style_class: 'aether-tool-container',
                vertical: true,
                x_expand: true,
            });

            // Tool header button (clickable to expand/collapse)
            const toolHeaderBtn = new St.Button({
                style_class: 'aether-tool-header',
                x_expand: true,
            });
            const toolHeaderBox = new St.BoxLayout({x_expand: true});
            toolHeaderBox.get_layout_manager().spacing = 6;
            toolHeaderBtn.set_child(toolHeaderBox);

            const toolHeaderIcon = new St.Icon({
                icon_name: 'utilities-terminal-symbolic',
                icon_size: 12,
                style_class: 'aether-tool-header-icon',
            });
            toolHeaderBox.add_child(toolHeaderIcon);

            const actionCount = toolCalls.length;
            const toolHeaderLabel = new St.Label({
                style_class: 'aether-tool-header-text',
                text: `${actionCount} action${actionCount !== 1 ? 's' : ''}${errors.length > 0 ? ` · ${errors.length} error${errors.length !== 1 ? 's' : ''}` : ''}`,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            toolHeaderBox.add_child(toolHeaderLabel);

            const chevron = new St.Label({
                style_class: 'aether-tool-chevron',
                text: isExpanded ? '▾' : '▸',
                y_align: Clutter.ActorAlign.CENTER,
            });
            toolHeaderBox.add_child(chevron);

            toolContainer.add_child(toolHeaderBtn);

            // Tool body (restore expanded state from previous rebuild)
            const toolBody = new St.BoxLayout({
                style_class: 'aether-tool-body',
                vertical: true,
                x_expand: true,
                visible: isExpanded,
            });
            toolBody.get_layout_manager().spacing = 2;

            // Populate log entries (tool calls + results only)
            // Track screenshot index for matching with stored screenshots
            const screenshots = this._agentManager.getRunScreenshots(agent.id);
            let screenshotIdx = 0;

            for (const entry of log) {
                if (entry.type === 'system')
                    continue;

                const isError = entry.type === 'error';
                const isToolCall = entry.type === 'tool_call';
                const isResult = entry.type === 'tool_result';
                const isResponse = entry.type === 'response';

                // Detect screenshot-related entries
                const isScreenshotEntry = isResult && (
                    entry.content.includes('screenshot_captured')
                    || entry.content.includes('auto-screenshot after')
                    || entry.content.includes('initial screenshot')
                );

                const styleClass = isError ? 'aether-status-error'
                    : isToolCall ? 'aether-status-tool'
                    : isResult ? 'aether-status-tool'
                    : 'aether-status-info';

                if (isScreenshotEntry && screenshotIdx < screenshots.length) {
                    // Clickable screenshot row
                    const ssData = screenshots[screenshotIdx];
                    screenshotIdx++;

                    const ssContainer = new St.BoxLayout({
                        style_class: 'aether-screenshot-container',
                        vertical: true,
                        x_expand: true,
                    });

                    const ssBtn = new St.Button({
                        style_class: `aether-status-row aether-screenshot-row ${styleClass}`,
                        x_expand: true,
                    });
                    const ssBtnBox = new St.BoxLayout({x_expand: true});
                    ssBtnBox.get_layout_manager().spacing = 8;
                    ssBtn.set_child(ssBtnBox);

                    const ssIcon = new St.Icon({
                        icon_name: 'camera-photo-symbolic',
                        icon_size: 12,
                        style_class: 'aether-status-icon',
                    });
                    ssBtnBox.add_child(ssIcon);

                    const coordsText = ssData.actionCoords
                        ? ` — click at (${ssData.actionCoords.x}, ${ssData.actionCoords.y})`
                        : '';
                    const ssLabel = new St.Label({
                        text: `Screenshot (${ssData.context})${coordsText}`,
                        style_class: 'aether-status-text',
                        x_expand: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    ssBtnBox.add_child(ssLabel);

                    const ssChevron = new St.Label({
                        text: '▸',
                        style_class: 'aether-tool-chevron',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    ssBtnBox.add_child(ssChevron);

                    ssContainer.add_child(ssBtn);

                    // Preview placeholder (lazy-loaded on click)
                    const previewBox = new St.BoxLayout({
                        style_class: 'aether-screenshot-preview-box',
                        vertical: true,
                        x_expand: true,
                        visible: false,
                    });
                    ssContainer.add_child(previewBox);

                    ssBtn.connect('clicked', () => {
                        if (previewBox.visible) {
                            previewBox.hide();
                            ssChevron.set_text('▸');
                        } else {
                            // Lazy-load image on first expand
                            if (previewBox.get_n_children() === 0)
                                this._loadScreenshotPreview(previewBox, ssData);
                            previewBox.show();
                            ssChevron.set_text('▾');
                        }
                    });

                    toolBody.add_child(ssContainer);
                } else {
                    // Normal log row
                    const row = new St.BoxLayout({
                        style_class: `aether-status-row ${styleClass}`,
                        x_expand: true,
                    });
                    row.get_layout_manager().spacing = 8;

                    const icon = new St.Icon({
                        icon_name: isError ? 'dialog-error-symbolic'
                            : isToolCall ? 'utilities-terminal-symbolic'
                            : isResult ? 'go-next-symbolic'
                            : 'dialog-information-symbolic',
                        icon_size: 12,
                        style_class: 'aether-status-icon',
                    });
                    row.add_child(icon);

                    const prefix = isToolCall ? 'Running: '
                        : isResult ? 'Result: '
                        : isResponse ? ''
                        : '';
                    const text = entry.content.length > 200
                        ? entry.content.slice(0, 200) + '...'
                        : entry.content;

                    const label = new St.Label({
                        text: `${prefix}${text}`,
                        style_class: 'aether-status-text',
                        x_expand: true,
                    });
                    label.clutter_text.set_line_wrap(true);
                    label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                    makeSelectable(label);
                    row.add_child(label);

                    toolBody.add_child(row);
                }
            }

            toolContainer.add_child(toolBody);

            toolHeaderBtn.connect('clicked', () => {
                if (toolBody.visible) {
                    toolBody.hide();
                    chevron.set_text('▸');
                    this._expandedTools.delete(agent.id);
                } else {
                    toolBody.show();
                    chevron.set_text('▾');
                    this._expandedTools.add(agent.id);
                }
            });

            card.add_child(toolContainer);
        }

        // ── Final response (if completed with content) ──
        if (agent.state === 'completed' && agent.result) {
            const resultLabel = new St.Label({
                style_class: 'aether-agent-card-result',
                text: agent.result,
                x_expand: true,
            });
            resultLabel.clutter_text.set_line_wrap(true);
            resultLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            resultLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            makeSelectable(resultLabel);
            card.add_child(resultLabel);
        }

        // ── Error message ──
        if (agent.state === 'error') {
            const run = this._agentManager.getRunLog(agent.id);
            const lastError = run.filter(l => l.type === 'error').pop();
            if (lastError) {
                const errLabel = new St.Label({
                    style_class: 'aether-agent-error-text',
                    text: lastError.content,
                    x_expand: true,
                });
                errLabel.clutter_text.set_line_wrap(true);
                errLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                errLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                makeSelectable(errLabel);
                card.add_child(errLabel);
            }
        }

        return card;
    }

    _loadScreenshotPreview(previewBox, ssData) {
        try {
            // Get the image to display — annotated if there are click coords
            let b64 = ssData.base64;
            if (ssData.actionCoords) {
                b64 = this._agentManager._annotateScreenshot(
                    b64, ssData.actionCoords.x, ssData.actionCoords.y
                );
            }

            // Write decoded PNG to temp file
            const rawBytes = GLib.base64_decode(b64);
            const tmpPath = `/tmp/.aether-ss-preview-${Date.now()}.png`;
            const texFile = Gio.File.new_for_path(tmpPath);
            texFile.replace_contents(rawBytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            // Use St.TextureCache.load_file_async for correct aspect ratio
            // (St.Icon forces square; TextureCache preserves aspect)
            // NOTE: load_file_async returns Clutter.Actor, NOT St.Widget —
            // so wrap in St.Bin for CSS styling (border-radius, border, etc.)
            const maxWidth = 360;
            const cache = St.TextureCache.get_default();
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const image = cache.load_file_async(texFile, maxWidth, -1, scaleFactor, 1.0);
            const imageWrapper = new St.Bin({
                style_class: 'aether-screenshot-preview',
                child: image,
                x_align: Clutter.ActorAlign.CENTER,
            });
            previewBox.add_child(imageWrapper);

            // Info label
            if (ssData.actionCoords) {
                const infoLabel = new St.Label({
                    text: `Clicked at (${ssData.actionCoords.x}, ${ssData.actionCoords.y})`,
                    style_class: 'aether-screenshot-info',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                previewBox.add_child(infoLabel);
            }

            // Clean up temp file after a delay
            GLib.timeout_add(GLib.PRIORITY_LOW, 10000, () => {
                try { texFile.delete(null); } catch {}
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            const errLabel = new St.Label({
                text: `Failed to load screenshot: ${e.message}`,
                style_class: 'aether-status-text',
            });
            previewBox.add_child(errLabel);
        }
    }

    _onAgentStateChange(_runId, run) {
        this._updateBadge(run);

        // Rebuild popup live — terminal states immediately, running debounced
        if (this.menu.isOpen) {
            if (run.state === 'completed' || run.state === 'error') {
                if (this._rebuildDebounceId) {
                    GLib.source_remove(this._rebuildDebounceId);
                    this._rebuildDebounceId = null;
                }
                this._rebuildAgentList();
            } else if (!this._rebuildDebounceId) {
                this._rebuildDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._rebuildDebounceId = null;
                    if (this.menu.isOpen)
                        this._rebuildAgentList();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _updateBadge(run) {
        const agents = this._agentManager.listAgents();
        const runningAgents = agents.filter(a => a.state === 'running');
        const runningCount = runningAgents.length;
        const totalCalls = runningAgents.reduce((sum, a) => sum + (a.toolCallCount || 0), 0);

        if (runningCount > 0) {
            const badgeText = totalCalls > 0
                ? `${runningCount} · ${totalCalls}`
                : `${runningCount}`;
            this._badge.set_text(badgeText);
            this._badge.show();
            this._startSpinner();
        } else {
            this._badge.hide();
            this._stopSpinner();

            if (this._checkmarkTimeoutId) {
                GLib.source_remove(this._checkmarkTimeoutId);
                this._checkmarkTimeoutId = null;
            }

            if (run && run.state === 'completed') {
                this._icon.icon_name = 'emblem-ok-symbolic';
                this._checkmarkTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    this._icon.icon_name = 'system-run-symbolic';
                    this._checkmarkTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            } else if (run && run.state === 'error') {
                this._icon.icon_name = 'dialog-warning-symbolic';
                this._checkmarkTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                    this._icon.icon_name = 'system-run-symbolic';
                    this._checkmarkTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _startSpinner() {
        if (this._spinnerTimeoutId)
            return;
        this._icon.icon_name = 'process-working-symbolic';
        this._spinnerPhase = 0;
        this._spinnerTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._spinnerPhase = (this._spinnerPhase + 1) % 2;
            this._icon.opacity = this._spinnerPhase === 0 ? 255 : 180;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSpinner() {
        if (this._spinnerTimeoutId) {
            GLib.source_remove(this._spinnerTimeoutId);
            this._spinnerTimeoutId = null;
        }
        this._icon.opacity = 255;
    }

    _updateVisibility() {
        const stealth = this._settings.get_boolean('stealth-mode');
        if (stealth)
            this.hide();
        else
            this.show();
    }

    destroy() {
        this._stopSpinner();
        if (this._checkmarkTimeoutId) {
            GLib.source_remove(this._checkmarkTimeoutId);
            this._checkmarkTimeoutId = null;
        }
        if (this._rebuildDebounceId) {
            GLib.source_remove(this._rebuildDebounceId);
            this._rebuildDebounceId = null;
        }
        if (this._stealthId) {
            this._settings.disconnect(this._stealthId);
            this._stealthId = 0;
        }
        super.destroy();
    }
});
