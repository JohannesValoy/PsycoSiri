import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEFAULT_SYSTEM_PROMPT = 'You are Aether, an AI assistant embedded in the GNOME desktop on Fedora. You have access to tools to execute commands, manage files, search the web, and more. Always be concise.';

export default class AetherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ── Providers Page ──
        const providersPage = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'network-server-symbolic',
        });
        window.add(providersPage);

        // Provider list group — will hold dynamic rows
        this._providerListGroup = new Adw.PreferencesGroup({
            title: 'AI Providers',
            description: 'Configure API endpoints for AI models',
        });
        providersPage.add(this._providerListGroup);

        this._settings = settings;
        this._window = window;
        this._providerRows = [];
        this._buildProviderList();

        // "Add provider" button row
        const addProviderRow = new Adw.ActionRow({
            title: 'Add Provider',
            subtitle: 'OpenRouter, OpenAI, Cerebras, etc.',
            activatable: true,
        });
        addProviderRow.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        addProviderRow.connect('activated', () => {
            this._showAddProviderDialog();
        });
        this._providerListGroup.add(addProviderRow);
        this._addProviderRow = addProviderRow;

        // Active model selection
        const modelGroup = new Adw.PreferencesGroup({
            title: 'Active Model',
            description: 'Set the active provider ID and model to use',
        });
        providersPage.add(modelGroup);

        const activeProviderRow = new Adw.EntryRow({title: 'Active Provider ID'});
        activeProviderRow.set_text(settings.get_string('active-provider'));
        activeProviderRow.connect('changed', () => {
            settings.set_string('active-provider', activeProviderRow.get_text());
        });
        modelGroup.add(activeProviderRow);

        const activeModelRow = new Adw.EntryRow({title: 'Active Model'});
        activeModelRow.set_text(settings.get_string('active-model'));
        activeModelRow.connect('changed', () => {
            settings.set_string('active-model', activeModelRow.get_text());
        });
        modelGroup.add(activeModelRow);

        const contextTokensRow = new Adw.SpinRow({
            title: 'Max Context Tokens',
            subtitle: 'Maximum context window size for the model',
            adjustment: new Gtk.Adjustment({
                lower: 1000, upper: 2000000,
                step_increment: 1000,
                value: settings.get_int('max-context-tokens'),
            }),
        });
        contextTokensRow.connect('changed', () => {
            settings.set_int('max-context-tokens', contextTokensRow.get_value());
        });
        modelGroup.add(contextTokensRow);

        // ── Agents Page ──
        const agentsPage = new Adw.PreferencesPage({
            title: 'Agents',
            icon_name: 'system-run-symbolic',
        });
        window.add(agentsPage);

        this._agentListGroup = new Adw.PreferencesGroup({
            title: 'Agent Configurations',
            description: 'Configure background AI agents that can be spawned by the main AI',
        });
        agentsPage.add(this._agentListGroup);

        this._agentRows = [];
        this._buildAgentList();

        // "Add agent" button row
        const addAgentRow = new Adw.ActionRow({
            title: 'Add Agent',
            subtitle: 'Configure a new background agent',
            activatable: true,
        });
        addAgentRow.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        addAgentRow.connect('activated', () => {
            this._showAddAgentDialog();
        });
        this._agentListGroup.add(addAgentRow);

        // ── Voice Page ──
        const voicePage = new Adw.PreferencesPage({
            title: 'Voice',
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(voicePage);

        const sttGroup = new Adw.PreferencesGroup({
            title: 'Speech-to-Text',
            description: 'Local transcription using whisper.cpp',
        });
        voicePage.add(sttGroup);

        const sttPathRow = new Adw.EntryRow({title: 'Whisper Model Path'});
        sttPathRow.set_text(settings.get_string('stt-model-path'));
        sttPathRow.connect('changed', () => {
            settings.set_string('stt-model-path', sttPathRow.get_text());
        });
        sttGroup.add(sttPathRow);

        const ttsGroup = new Adw.PreferencesGroup({title: 'Text-to-Speech'});
        voicePage.add(ttsGroup);

        const ttsToggle = new Adw.SwitchRow({
            title: 'Enable TTS',
            subtitle: 'Read AI responses aloud',
        });
        settings.bind('tts-enabled', ttsToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        ttsGroup.add(ttsToggle);

        const ttsVoiceRow = new Adw.EntryRow({title: 'TTS Voice'});
        ttsVoiceRow.set_text(settings.get_string('tts-voice'));
        ttsVoiceRow.connect('changed', () => {
            settings.set_string('tts-voice', ttsVoiceRow.get_text());
        });
        ttsGroup.add(ttsVoiceRow);

        // ── General Page ──
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const uiGroup = new Adw.PreferencesGroup({title: 'Interface'});
        generalPage.add(uiGroup);

        const stealthRow = new Adw.SwitchRow({
            title: 'Stealth Mode',
            subtitle: 'Hide all visible indicators; only accessible via Ctrl+Space',
        });
        settings.bind('stealth-mode', stealthRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(stealthRow);

        const contextGroup = new Adw.PreferencesGroup({title: 'Context Management'});
        generalPage.add(contextGroup);

        const autoSummarizeRow = new Adw.SwitchRow({
            title: 'Auto-Summarize',
            subtitle: 'Automatically compress old context when approaching token limits',
        });
        settings.bind('auto-summarize', autoSummarizeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        contextGroup.add(autoSummarizeRow);

        const thresholdRow = new Adw.SpinRow({
            title: 'Summarization Threshold',
            subtitle: 'Fraction of context window to trigger summarization (0.0-1.0)',
            adjustment: new Gtk.Adjustment({
                lower: 0.3, upper: 0.95,
                step_increment: 0.05,
                value: settings.get_double('summarize-threshold'),
            }),
            digits: 2,
        });
        thresholdRow.connect('changed', () => {
            settings.set_double('summarize-threshold', thresholdRow.get_value());
        });
        contextGroup.add(thresholdRow);

        // Search (Serper)
        const searchGroup = new Adw.PreferencesGroup({
            title: 'Web Search',
            description: 'Configure Serper.dev for Google search results',
        });
        generalPage.add(searchGroup);

        const serperKeyRow = new Adw.PasswordEntryRow({title: 'Serper API Key'});
        serperKeyRow.set_text(settings.get_string('serper-api-key'));
        serperKeyRow.connect('changed', () => {
            settings.set_string('serper-api-key', serperKeyRow.get_text());
        });
        searchGroup.add(serperKeyRow);

        const searchMaxRow = new Adw.SpinRow({
            title: 'Max Search Results',
            subtitle: 'Number of results returned per search (1-20)',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 20,
                step_increment: 1,
                value: settings.get_int('search-max-results'),
            }),
        });
        searchMaxRow.connect('changed', () => {
            settings.set_int('search-max-results', searchMaxRow.get_value());
        });
        searchGroup.add(searchMaxRow);

        // Enhanced Main Prompt Section
        const promptGroup = new Adw.PreferencesGroup({
            title: 'Main Prompt',
            description: 'Customize Aether\'s behavior and personality',
        });
        generalPage.add(promptGroup);

        // Custom main prompt with multi-line text view
        const customPromptRow = new Adw.ActionRow({
            title: 'Custom Main Prompt',
            subtitle: 'Define Aether\'s behavior and personality',
        });
        promptGroup.add(customPromptRow);

        // Create expand button for custom prompt
        const expandButton = new Gtk.Button({
            icon_name: 'go-next-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: 'Edit custom main prompt',
        });
        expandButton.connect('clicked', () => {
            this._showCustomPromptDialog();
        });
        customPromptRow.add_suffix(expandButton);

        // Show current custom prompt status
        const customPrompt = settings.get_string('custom-main-prompt');
        const statusLabel = new Gtk.Label({
            label: customPrompt ? '(Custom)' : '(Default)',
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
            margin_start: 8,
        });
        customPromptRow.add_suffix(statusLabel);

        // Checkbox to include agents in prompt
        const includeAgentsRow = new Adw.SwitchRow({
            title: 'Include Available Agents in Prompt',
            subtitle: 'Automatically inject list of agent names into the main prompt',
        });
        settings.bind('include-agents-in-prompt', includeAgentsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        promptGroup.add(includeAgentsRow);

        // Reset to default prompt button
        const resetPromptRow = new Adw.ActionRow({
            title: 'Reset Main Prompt',
            subtitle: 'Revert to the default system prompt',
            activatable: true,
        });
        const resetBtn = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
            tooltip_text: 'Reset to default prompt',
        });
        resetBtn.connect('clicked', () => {
            this._resetCustomPrompt();
        });
        resetPromptRow.add_suffix(resetBtn);
        resetPromptRow.connect('activated', () => {
            this._resetCustomPrompt();
        });
        promptGroup.add(resetPromptRow);

        // ── Memory Page ──
        const memoryPage = new Adw.PreferencesPage({
            title: 'Memory',
            icon_name: 'drive-harddisk-symbolic',
        });
        window.add(memoryPage);

        const dbGroup = new Adw.PreferencesGroup({title: 'Database'});
        memoryPage.add(dbGroup);

        const dbPathRow = new Adw.EntryRow({title: 'Database Path'});
        dbPathRow.set_text(settings.get_string('db-path') || '~/.config/aether/aether.db (default)');
        dbPathRow.connect('changed', () => {
            settings.set_string('db-path', dbPathRow.get_text());
        });
        dbGroup.add(dbPathRow);
    }

    // ── Custom Prompt Dialog ──

    _showCustomPromptDialog() {
        const settings = this._settings;
        const currentPrompt = settings.get_string('custom-main-prompt') || DEFAULT_SYSTEM_PROMPT;

        const dialog = new Adw.AlertDialog({
            heading: 'Custom Main Prompt',
            body: 'Define Aether\'s behavior and personality. This prompt will be used instead of the default.',
            width_request: 600,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });

        const infoLabel = new Gtk.Label({
            label: 'Leave empty to use the default prompt.',
            halign: Gtk.Align.START,
            css_classes: ['dim-label'],
        });

        const promptView = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 8,
        });
        promptView.buffer.set_text(currentPrompt, -1);
        const promptScroll = new Gtk.ScrolledWindow({
            child: promptView,
            min_content_height: 150,
            max_content_height: 300,
        });

        box.append(infoLabel);
        box.append(promptScroll);

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_default_response('save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (_dlg, response) => {
            if (response === 'save') {
                const startIter = promptView.buffer.get_start_iter();
                const endIter = promptView.buffer.get_end_iter();
                const promptText = promptView.buffer.get_text(startIter, endIter, false).trim();

                // If empty, clear custom prompt (reverts to default)
                if (promptText === '' || promptText === DEFAULT_SYSTEM_PROMPT) {
                    settings.set_string('custom-main-prompt', '');
                } else {
                    settings.set_string('custom-main-prompt', promptText);
                }

                // Refresh the settings dialog to update status label
                this._updateCustomPromptStatus();
            }
        });

        dialog.present(this._window);
    }

    _resetCustomPrompt() {
        const dialog = new Adw.MessageDialog({
            heading: 'Reset Main Prompt',
            body: 'Are you sure you want to reset to the default system prompt? Your custom prompt will be cleared.',
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);

        dialog.connect('response', (_dlg, response) => {
            if (response === 'reset') {
                this._settings.set_string('custom-main-prompt', '');
                this._updateCustomPromptStatus();
            }
        });

        dialog.present(this._window);
    }

    _updateCustomPromptStatus() {
        // Rebuild the preferences window to refresh status labels
        // This is a simple approach - could be optimized with proper widget references
        this.fillPreferencesWindow(this._window);
    }

    // ── Provider List Management ──

    _getProviders() {
        try {
            return JSON.parse(this._settings.get_string('providers') || '{}');
        } catch {
            return {};
        }
    }

    _saveProviders(configs) {
        this._settings.set_string('providers', JSON.stringify(configs));
    }

    _buildProviderList() {
        // Remove existing dynamic rows
        for (const row of this._providerRows)
            this._providerListGroup.remove(row);
        this._providerRows = [];

        const configs = this._getProviders();

        for (const [id, cfg] of Object.entries(configs)) {
            const maskedKey = cfg.apiKey
                ? `${cfg.apiKey.slice(0, 6)}..${cfg.apiKey.slice(-4)}`
                : '(no key)';

            const row = new Adw.ActionRow({
                title: `${cfg.name || id}`,
                subtitle: `${cfg.baseUrl}  |  Key: ${maskedKey}`,
            });

            // Delete button
            const deleteBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
                tooltip_text: `Remove ${id}`,
            });
            deleteBtn.connect('clicked', () => {
                const providers = this._getProviders();
                delete providers[id];
                this._saveProviders(providers);
                this._buildProviderList();
            });
            row.add_suffix(deleteBtn);

            // "Set active" button
            const activeBtn = new Gtk.Button({
                icon_name: 'emblem-ok-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
                tooltip_text: `Set ${id} as active`,
            });
            activeBtn.connect('clicked', () => {
                this._settings.set_string('active-provider', id);
                this._buildProviderList();
            });
            row.add_suffix(activeBtn);

            // Indicate if this is the active provider
            const activeId = this._settings.get_string('active-provider');
            if (id === activeId) {
                const badge = new Gtk.Label({
                    label: 'ACTIVE',
                    css_classes: ['success'],
                    valign: Gtk.Align.CENTER,
                    margin_end: 8,
                });
                row.add_suffix(badge);
            }

            this._providerListGroup.add(row);
            this._providerRows.push(row);
        }

        if (Object.keys(configs).length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No providers configured',
                subtitle: 'Click "Add Provider" below to get started',
            });
            this._providerListGroup.add(emptyRow);
            this._providerRows.push(emptyRow);
        }
    }

    _showAddProviderDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'Add AI Provider',
            body: 'Enter the base URL (e.g. https://openrouter.ai/api/v1)',
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });

        const idEntry = new Gtk.Entry({placeholder_text: 'Provider ID (e.g., openrouter)'});
        const nameEntry = new Gtk.Entry({placeholder_text: 'Display name (e.g., OpenRouter)'});
        const urlEntry = new Gtk.Entry({placeholder_text: 'Base URL (e.g., https://openrouter.ai/api/v1)'});
        const keyEntry = new Gtk.PasswordEntry({placeholder_text: 'API Key', show_peek_icon: true});

        box.append(idEntry);
        box.append(nameEntry);
        box.append(urlEntry);
        box.append(keyEntry);

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('add', 'Add');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (dlg, response) => {
            if (response === 'add') {
                const id = idEntry.get_text().trim();
                const name = nameEntry.get_text().trim();
                const url = urlEntry.get_text().trim();
                const key = keyEntry.get_text().trim();

                if (id && url && key) {
                    const configs = this._getProviders();
                    configs[id] = {name: name || id, apiKey: key, baseUrl: url};
                    this._saveProviders(configs);
                    this._buildProviderList();
                }
            }
        });

        dialog.present(this._window);
    }

    // ── Agent List Management ──

    _getAgentConfigs() {
        try {
            return JSON.parse(this._settings.get_string('agent-configs') || '{}');
        } catch {
            return {};
        }
    }

    _saveAgentConfigs(configs) {
        this._settings.set_string('agent-configs', JSON.stringify(configs));
    }

    _buildAgentList() {
        for (const row of this._agentRows)
            this._agentListGroup.remove(row);
        this._agentRows = [];

        const configs = this._getAgentConfigs();

        for (const [id, cfg] of Object.entries(configs)) {
            const row = new Adw.ActionRow({
                title: cfg.name || id,
                subtitle: `Provider: ${cfg.providerId}  |  Model: ${cfg.modelId}`,
            });

            // Edit button
            const editBtn = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
                tooltip_text: `Edit ${id}`,
            });
            editBtn.connect('clicked', () => {
                this._showEditAgentDialog(id, cfg);
            });
            row.add_suffix(editBtn);

            // Delete button
            const deleteBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
                tooltip_text: `Remove ${id}`,
            });
            deleteBtn.connect('clicked', () => {
                const agents = this._getAgentConfigs();
                delete agents[id];
                this._saveAgentConfigs(agents);
                this._buildAgentList();
            });
            row.add_suffix(deleteBtn);

            this._agentListGroup.add(row);
            this._agentRows.push(row);
        }

        if (Object.keys(configs).length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No agents configured',
                subtitle: 'Click "Add Agent" below to create one',
            });
            this._agentListGroup.add(emptyRow);
            this._agentRows.push(emptyRow);
        }
    }

    _showAddAgentDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'Add Agent Configuration',
            body: 'Configure a background AI agent with its own provider and model',
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });

        const idEntry = new Gtk.Entry({placeholder_text: 'Agent ID (e.g., researcher)'});
        const nameEntry = new Gtk.Entry({placeholder_text: 'Display name (e.g., Researcher)'});
        const providerEntry = new Gtk.Entry({placeholder_text: 'Provider ID (must match an existing provider)'});
        const modelEntry = new Gtk.Entry({placeholder_text: 'Model ID (e.g., anthropic/claude-sonnet-4)'});

        const promptLabel = new Gtk.Label({
            label: 'System Prompt:',
            halign: Gtk.Align.START,
        });
        const promptView = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
        });
        promptView.buffer.set_text(
            'You are a background AI agent. Complete the assigned task thoroughly using the available tools.',
            -1
        );
        const promptScroll = new Gtk.ScrolledWindow({
            child: promptView,
            min_content_height: 80,
            max_content_height: 200,
        });

        box.append(idEntry);
        box.append(nameEntry);
        box.append(providerEntry);
        box.append(modelEntry);
        box.append(promptLabel);
        box.append(promptScroll);

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('add', 'Add');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (_dlg, response) => {
            if (response === 'add') {
                const id = idEntry.get_text().trim();
                const name = nameEntry.get_text().trim();
                const providerId = providerEntry.get_text().trim();
                const modelId = modelEntry.get_text().trim();
                const startIter = promptView.buffer.get_start_iter();
                const endIter = promptView.buffer.get_end_iter();
                const systemPrompt = promptView.buffer.get_text(startIter, endIter, false);

                if (id && providerId && modelId) {
                    const configs = this._getAgentConfigs();
                    configs[id] = {name: name || id, providerId, modelId, systemPrompt};
                    this._saveAgentConfigs(configs);
                    this._buildAgentList();
                }
            }
        });

        dialog.present(this._window);
    }

    _showEditAgentDialog(id, cfg) {
        const dialog = new Adw.AlertDialog({
            heading: `Edit Agent: ${cfg.name || id}`,
            body: `Editing agent configuration "${id}"`,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });

        const nameEntry = new Gtk.Entry({
            placeholder_text: 'Display name',
            text: cfg.name || id,
        });
        const providerEntry = new Gtk.Entry({
            placeholder_text: 'Provider ID',
            text: cfg.providerId || '',
        });
        const modelEntry = new Gtk.Entry({
            placeholder_text: 'Model ID',
            text: cfg.modelId || '',
        });

        const promptLabel = new Gtk.Label({
            label: 'System Prompt:',
            halign: Gtk.Align.START,
        });
        const promptView = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
        });
        promptView.buffer.set_text(cfg.systemPrompt || '', -1);
        const promptScroll = new Gtk.ScrolledWindow({
            child: promptView,
            min_content_height: 80,
            max_content_height: 200,
        });

        box.append(nameEntry);
        box.append(providerEntry);
        box.append(modelEntry);
        box.append(promptLabel);
        box.append(promptScroll);

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (_dlg, response) => {
            if (response === 'save') {
                const name = nameEntry.get_text().trim();
                const providerId = providerEntry.get_text().trim();
                const modelId = modelEntry.get_text().trim();
                const startIter = promptView.buffer.get_start_iter();
                const endIter = promptView.buffer.get_end_iter();
                const systemPrompt = promptView.buffer.get_text(startIter, endIter, false);

                if (providerId && modelId) {
                    const configs = this._getAgentConfigs();
                    configs[id] = {name: name || id, providerId, modelId, systemPrompt};
                    this._saveAgentConfigs(configs);
                    this._buildAgentList();
                }
            }
        });

        dialog.present(this._window);
    }
}
