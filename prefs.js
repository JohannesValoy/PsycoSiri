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

        // Load models registry for all dropdowns
        const models = this._getModels();
        const modelSlugs = Object.keys(models);

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
            description: 'Select a registered model or configure manually',
        });
        providersPage.add(modelGroup);

        // Model dropdown from registry
        const activeChoices = ['(Manual)', ...modelSlugs];
        const activeModelList = new Gtk.StringList();
        for (const c of activeChoices)
            activeModelList.append(c);
        const activeModelDropdown = new Adw.ComboRow({
            title: 'Model',
            subtitle: 'Select from registry or "(Manual)" to enter provider/model below',
            model: activeModelList,
        });
        const currentActiveSlug = settings.get_string('active-model-slug');
        const activeIdx = activeChoices.indexOf(currentActiveSlug);
        activeModelDropdown.set_selected(activeIdx >= 0 ? activeIdx : 0);
        modelGroup.add(activeModelDropdown);

        const activeProviderRow = new Adw.EntryRow({title: 'Provider ID'});
        activeProviderRow.set_text(settings.get_string('active-provider'));
        activeProviderRow.connect('changed', () => {
            settings.set_string('active-provider', activeProviderRow.get_text());
        });
        modelGroup.add(activeProviderRow);

        const activeModelRow = new Adw.EntryRow({title: 'Model ID'});
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

        // Wire up active model dropdown
        activeModelDropdown.connect('notify::selected', () => {
            const sel = activeModelDropdown.get_selected();
            if (sel === 0) {
                settings.set_string('active-model-slug', '');
            } else {
                const slug = activeChoices[sel];
                const mc = models[slug];
                if (mc) {
                    settings.set_string('active-model-slug', slug);
                    settings.set_string('active-provider', mc.providerId);
                    settings.set_string('active-model', mc.modelId);
                    settings.set_int('max-context-tokens', mc.maxContext || 128000);
                    activeProviderRow.set_text(mc.providerId);
                    activeModelRow.set_text(mc.modelId);
                    contextTokensRow.get_adjustment().set_value(mc.maxContext || 128000);
                }
            }
        });

        // Backup model selection
        const backupGroup = new Adw.PreferencesGroup({
            title: 'Backup Model',
            description: 'Fallback when the active model fails. Select "(None)" to disable.',
        });
        providersPage.add(backupGroup);

        // Backup model dropdown
        const backupChoices = ['(None)', '(Manual)', ...modelSlugs];
        const backupModelList = new Gtk.StringList();
        for (const c of backupChoices)
            backupModelList.append(c);
        const backupModelDropdown = new Adw.ComboRow({
            title: 'Model',
            subtitle: 'Select from registry, "(Manual)" to enter manually, or "(None)" to disable',
            model: backupModelList,
        });
        const currentBackupSlug = settings.get_string('backup-model-slug');
        const currentBackupProvider = settings.get_string('backup-provider');
        let backupIdx = 0; // "(None)"
        if (currentBackupSlug && backupChoices.indexOf(currentBackupSlug) >= 0)
            backupIdx = backupChoices.indexOf(currentBackupSlug);
        else if (currentBackupProvider)
            backupIdx = 1; // "(Manual)"
        backupModelDropdown.set_selected(backupIdx);
        backupGroup.add(backupModelDropdown);

        const backupProviderRow = new Adw.EntryRow({title: 'Backup Provider ID'});
        backupProviderRow.set_text(settings.get_string('backup-provider'));
        backupProviderRow.connect('changed', () => {
            settings.set_string('backup-provider', backupProviderRow.get_text());
        });
        backupGroup.add(backupProviderRow);

        const backupModelRow = new Adw.EntryRow({title: 'Backup Model ID'});
        backupModelRow.set_text(settings.get_string('backup-model'));
        backupModelRow.connect('changed', () => {
            settings.set_string('backup-model', backupModelRow.get_text());
        });
        backupGroup.add(backupModelRow);

        // Wire up backup dropdown
        backupModelDropdown.connect('notify::selected', () => {
            const sel = backupModelDropdown.get_selected();
            if (sel === 0) { // "(None)"
                settings.set_string('backup-model-slug', '');
                settings.set_string('backup-provider', '');
                settings.set_string('backup-model', '');
                backupProviderRow.set_text('');
                backupModelRow.set_text('');
            } else if (sel === 1) { // "(Manual)"
                settings.set_string('backup-model-slug', '');
            } else {
                const slug = backupChoices[sel];
                const mc = models[slug];
                if (mc) {
                    settings.set_string('backup-model-slug', slug);
                    settings.set_string('backup-provider', mc.providerId);
                    settings.set_string('backup-model', mc.modelId);
                    backupProviderRow.set_text(mc.providerId);
                    backupModelRow.set_text(mc.modelId);
                }
            }
        });

        // ── Models Page ──
        const modelsPage = new Adw.PreferencesPage({
            title: 'Models',
            icon_name: 'applications-science-symbolic',
        });
        window.add(modelsPage);

        this._modelListGroup = new Adw.PreferencesGroup({
            title: 'Registered Models',
            description: 'Define models once, then select them everywhere by name',
        });
        modelsPage.add(this._modelListGroup);

        this._modelRows = [];
        this._buildModelList();

        const addModelRow = new Adw.ActionRow({
            title: 'Add Model',
            subtitle: 'Register a new model with provider, API ID, and context limit',
            activatable: true,
        });
        addModelRow.add_suffix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        addModelRow.connect('activated', () => this._showAddModelDialog());
        this._modelListGroup.add(addModelRow);
        this._addModelRow = addModelRow;

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

        // ── Computer Use Page ──
        const computerUsePage = new Adw.PreferencesPage({
            title: 'Computer Use',
            icon_name: 'input-mouse-symbolic',
        });
        window.add(computerUsePage);

        // ── Computer Use Agent Setup ──
        const cuAgentGroup = new Adw.PreferencesGroup({
            title: 'Computer Use Agent',
            description: 'Configure the agent that controls the desktop. Requires a vision-capable model (e.g. claude-sonnet-4, gpt-4o, gemini-2.0-flash).',
        });
        computerUsePage.add(cuAgentGroup);

        // Load existing computer-use agent config if it exists
        const cuAgentConfigs = this._getAgentConfigs();
        const cuExisting = cuAgentConfigs['computer-use'] || {};

        // Track selected model slugs
        let cuModelSlug = cuExisting.modelSlug || '';
        let cuBackupModelSlug = cuExisting.backupModelSlug || '';

        // Main model dropdown
        const cuModelChoices = ['(Manual)', ...modelSlugs];
        const cuModelListData = new Gtk.StringList();
        for (const c of cuModelChoices)
            cuModelListData.append(c);
        const cuModelDropdown = new Adw.ComboRow({
            title: 'Model',
            subtitle: 'Select from registry or configure manually below',
            model: cuModelListData,
        });
        const cuModelIdx = cuModelSlug ? cuModelChoices.indexOf(cuModelSlug) : 0;
        cuModelDropdown.set_selected(cuModelIdx >= 0 ? cuModelIdx : 0);
        cuAgentGroup.add(cuModelDropdown);

        const cuProviderEntry = new Adw.EntryRow({
            title: 'Provider ID',
        });
        cuProviderEntry.set_text(cuExisting.providerId || '');
        cuAgentGroup.add(cuProviderEntry);

        const cuModelEntry = new Adw.EntryRow({
            title: 'Model ID',
        });
        cuModelEntry.set_text(cuExisting.modelId || '');
        cuAgentGroup.add(cuModelEntry);

        cuModelDropdown.connect('notify::selected', () => {
            const sel = cuModelDropdown.get_selected();
            if (sel === 0) {
                cuModelSlug = '';
            } else {
                const slug = cuModelChoices[sel];
                const mc = models[slug];
                if (mc) {
                    cuModelSlug = slug;
                    cuProviderEntry.set_text(mc.providerId);
                    cuModelEntry.set_text(mc.modelId);
                }
            }
        });

        // Backup model dropdown
        const cuBackupChoices = ['(None)', '(Manual)', ...modelSlugs];
        const cuBackupListData = new Gtk.StringList();
        for (const c of cuBackupChoices)
            cuBackupListData.append(c);
        const cuBackupDropdown = new Adw.ComboRow({
            title: 'Backup Model',
            subtitle: 'Fallback when the main model fails',
            model: cuBackupListData,
        });
        let cuBackupIdx = 0;
        if (cuBackupModelSlug && cuBackupChoices.indexOf(cuBackupModelSlug) >= 0)
            cuBackupIdx = cuBackupChoices.indexOf(cuBackupModelSlug);
        else if (cuExisting.backupProviderId)
            cuBackupIdx = 1;
        cuBackupDropdown.set_selected(cuBackupIdx);
        cuAgentGroup.add(cuBackupDropdown);

        const cuBackupProviderEntry = new Adw.EntryRow({
            title: 'Backup Provider ID',
        });
        cuBackupProviderEntry.set_text(cuExisting.backupProviderId || '');
        cuAgentGroup.add(cuBackupProviderEntry);

        const cuBackupModelEntry = new Adw.EntryRow({
            title: 'Backup Model ID',
        });
        cuBackupModelEntry.set_text(cuExisting.backupModelId || '');
        cuAgentGroup.add(cuBackupModelEntry);

        cuBackupDropdown.connect('notify::selected', () => {
            const sel = cuBackupDropdown.get_selected();
            if (sel === 0) {
                cuBackupModelSlug = '';
                cuBackupProviderEntry.set_text('');
                cuBackupModelEntry.set_text('');
            } else if (sel === 1) {
                cuBackupModelSlug = '';
            } else {
                const slug = cuBackupChoices[sel];
                const mc = models[slug];
                if (mc) {
                    cuBackupModelSlug = slug;
                    cuBackupProviderEntry.set_text(mc.providerId);
                    cuBackupModelEntry.set_text(mc.modelId);
                }
            }
        });

        // Save button
        const cuSaveRow = new Adw.ActionRow({
            title: cuExisting.providerId ? 'Update Agent' : 'Create Agent',
            subtitle: cuExisting.providerId
                ? `Currently: ${cuExisting.providerId} / ${cuExisting.modelId}`
                : 'Save provider and model to create the computer-use agent',
            activatable: true,
        });
        const cuSaveBtn = new Gtk.Button({
            icon_name: cuExisting.providerId ? 'document-save-symbolic' : 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular', 'suggested-action'],
            tooltip_text: 'Save computer-use agent config',
        });
        const cuSaveHandler = () => {
            const providerId = cuProviderEntry.get_text().trim();
            const modelId = cuModelEntry.get_text().trim();
            if (!providerId || !modelId)
                return;
            const configs = this._getAgentConfigs();
            const backupProv = cuBackupProviderEntry.get_text().trim();
            const backupMod = cuBackupModelEntry.get_text().trim();
            configs['computer-use'] = {
                name: 'Computer Use',
                providerId,
                modelId,
                systemPrompt: '',
                ...(cuModelSlug ? {modelSlug: cuModelSlug} : {}),
                ...(backupProv && backupMod ? {backupProviderId: backupProv, backupModelId: backupMod} : {}),
                ...(cuBackupModelSlug ? {backupModelSlug: cuBackupModelSlug} : {}),
            };
            this._saveAgentConfigs(configs);
            // Update the subtitle to confirm save
            cuSaveRow.set_subtitle(`Saved: ${providerId} / ${modelId}`);
            cuSaveRow.set_title('Update Agent');
            cuSaveBtn.set_icon_name('document-save-symbolic');
            // Also refresh agent list if it's been built
            if (this._agentRows)
                this._buildAgentList();
        };
        cuSaveBtn.connect('clicked', cuSaveHandler);
        cuSaveRow.connect('activated', cuSaveHandler);
        cuSaveRow.add_suffix(cuSaveBtn);
        cuAgentGroup.add(cuSaveRow);

        // ── General Settings ──
        const cuGeneralGroup = new Adw.PreferencesGroup({
            title: 'Tools',
        });
        computerUsePage.add(cuGeneralGroup);

        const cuEnabledRow = new Adw.SwitchRow({
            title: 'Enable Computer Use',
            subtitle: 'Register screenshot, mouse, keyboard, and scroll tools for agents',
        });
        settings.bind('computer-use-enabled', cuEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        cuGeneralGroup.add(cuEnabledRow);

        const cuHideOverlayRow = new Adw.SwitchRow({
            title: 'Hide Overlay During Screenshots',
            subtitle: 'Temporarily hide Aether\'s overlay so the agent sees the actual desktop',
        });
        settings.bind('computer-use-hide-overlay', cuHideOverlayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        cuGeneralGroup.add(cuHideOverlayRow);

        const cuScreenshotGroup = new Adw.PreferencesGroup({
            title: 'Screenshot Settings',
        });
        computerUsePage.add(cuScreenshotGroup);

        const cuGridOverlayRow = new Adw.SwitchRow({
            title: 'Grid Overlay',
            subtitle: 'Draw a labeled coordinate grid on screenshots to help the AI estimate pixel positions',
        });
        settings.bind('computer-use-grid-overlay', cuGridOverlayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        cuScreenshotGroup.add(cuGridOverlayRow);

        const cuGridSpacingRow = new Adw.SpinRow({
            title: 'Grid Spacing (px)',
            subtitle: 'Distance between grid lines. Labels: A1=(100,100), B2=(200,200), etc.',
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 200,
                step_increment: 10,
                value: settings.get_int('computer-use-grid-spacing'),
            }),
        });
        cuGridSpacingRow.connect('changed', () => {
            settings.set_int('computer-use-grid-spacing', cuGridSpacingRow.get_value());
        });
        cuScreenshotGroup.add(cuGridSpacingRow);

        // Screenshot detail level dropdown
        const detailModel = new Gtk.StringList();
        detailModel.append('low');
        detailModel.append('high');
        const cuDetailRow = new Adw.ComboRow({
            title: 'Screenshot Detail Level',
            subtitle: '"low" = ~85 tokens (fast), "high" = ~765 tokens (can read small text)',
            model: detailModel,
        });
        // Set initial selection from settings
        const currentDetail = settings.get_string('computer-use-screenshot-detail');
        cuDetailRow.set_selected(currentDetail === 'high' ? 1 : 0);
        cuDetailRow.connect('notify::selected', () => {
            const val = cuDetailRow.get_selected() === 1 ? 'high' : 'low';
            settings.set_string('computer-use-screenshot-detail', val);
        });
        cuScreenshotGroup.add(cuDetailRow);

        const cuMaxImagesRow = new Adw.SpinRow({
            title: 'Max Screenshots in Context',
            subtitle: 'Older screenshots are removed to prevent context overflow',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 10,
                step_increment: 1,
                value: settings.get_int('computer-use-max-images'),
            }),
        });
        cuMaxImagesRow.connect('changed', () => {
            settings.set_int('computer-use-max-images', cuMaxImagesRow.get_value());
        });
        cuScreenshotGroup.add(cuMaxImagesRow);

        const cuInputGroup = new Adw.PreferencesGroup({
            title: 'Input Settings',
        });
        computerUsePage.add(cuInputGroup);

        const cuDelayRow = new Adw.SpinRow({
            title: 'Action Delay (ms)',
            subtitle: 'Delay between input sub-actions (move → click). Higher = more reliable on slower systems.',
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 500,
                step_increment: 10,
                value: settings.get_int('computer-use-action-delay'),
            }),
        });
        cuDelayRow.connect('changed', () => {
            settings.set_int('computer-use-action-delay', cuDelayRow.get_value());
        });
        cuInputGroup.add(cuDelayRow);

        // ── Auto-Repair Page ──
        const repairPage = new Adw.PreferencesPage({
            title: 'Auto-Repair',
            icon_name: 'applications-engineering-symbolic',
        });
        window.add(repairPage);

        const repairAgentGroup = new Adw.PreferencesGroup({
            title: 'Repair Agent',
            description: 'Configure the AI model used to diagnose and fix agent failures. Use a strong model (e.g. claude-sonnet-4, gpt-4o) for best results.',
        });
        repairPage.add(repairAgentGroup);

        // Load existing auto-repair agent config
        const repairConfigs = this._getAgentConfigs();
        const repairExisting = repairConfigs['auto-repair'] || {};

        // Track selected model slugs
        let repairModelSlug = repairExisting.modelSlug || '';
        let repairBackupModelSlug = repairExisting.backupModelSlug || '';

        // Main model dropdown
        const repairModelChoices = ['(Manual)', ...modelSlugs];
        const repairModelListData = new Gtk.StringList();
        for (const c of repairModelChoices)
            repairModelListData.append(c);
        const repairModelDropdown = new Adw.ComboRow({
            title: 'Model',
            subtitle: 'Select from registry or configure manually below',
            model: repairModelListData,
        });
        const repairModelIdx = repairModelSlug ? repairModelChoices.indexOf(repairModelSlug) : 0;
        repairModelDropdown.set_selected(repairModelIdx >= 0 ? repairModelIdx : 0);
        repairAgentGroup.add(repairModelDropdown);

        const repairProviderEntry = new Adw.EntryRow({
            title: 'Provider ID',
        });
        repairProviderEntry.set_text(repairExisting.providerId || '');
        repairAgentGroup.add(repairProviderEntry);

        const repairModelEntry = new Adw.EntryRow({
            title: 'Model ID',
        });
        repairModelEntry.set_text(repairExisting.modelId || '');
        repairAgentGroup.add(repairModelEntry);

        repairModelDropdown.connect('notify::selected', () => {
            const sel = repairModelDropdown.get_selected();
            if (sel === 0) {
                repairModelSlug = '';
            } else {
                const slug = repairModelChoices[sel];
                const mc = models[slug];
                if (mc) {
                    repairModelSlug = slug;
                    repairProviderEntry.set_text(mc.providerId);
                    repairModelEntry.set_text(mc.modelId);
                }
            }
        });

        // Backup model dropdown
        const repairBackupChoices = ['(None)', '(Manual)', ...modelSlugs];
        const repairBackupListData = new Gtk.StringList();
        for (const c of repairBackupChoices)
            repairBackupListData.append(c);
        const repairBackupDropdown = new Adw.ComboRow({
            title: 'Backup Model',
            subtitle: 'Fallback when the main model fails',
            model: repairBackupListData,
        });
        let repairBackupIdx = 0;
        if (repairBackupModelSlug && repairBackupChoices.indexOf(repairBackupModelSlug) >= 0)
            repairBackupIdx = repairBackupChoices.indexOf(repairBackupModelSlug);
        else if (repairExisting.backupProviderId)
            repairBackupIdx = 1;
        repairBackupDropdown.set_selected(repairBackupIdx);
        repairAgentGroup.add(repairBackupDropdown);

        const repairBackupProviderEntry = new Adw.EntryRow({
            title: 'Backup Provider ID',
        });
        repairBackupProviderEntry.set_text(repairExisting.backupProviderId || '');
        repairAgentGroup.add(repairBackupProviderEntry);

        const repairBackupModelEntry = new Adw.EntryRow({
            title: 'Backup Model ID',
        });
        repairBackupModelEntry.set_text(repairExisting.backupModelId || '');
        repairAgentGroup.add(repairBackupModelEntry);

        repairBackupDropdown.connect('notify::selected', () => {
            const sel = repairBackupDropdown.get_selected();
            if (sel === 0) {
                repairBackupModelSlug = '';
                repairBackupProviderEntry.set_text('');
                repairBackupModelEntry.set_text('');
            } else if (sel === 1) {
                repairBackupModelSlug = '';
            } else {
                const slug = repairBackupChoices[sel];
                const mc = models[slug];
                if (mc) {
                    repairBackupModelSlug = slug;
                    repairBackupProviderEntry.set_text(mc.providerId);
                    repairBackupModelEntry.set_text(mc.modelId);
                }
            }
        });

        // Fallback info row
        const fallbackRow = new Adw.ActionRow({
            title: 'Fallback behavior',
            subtitle: 'If unconfigured, uses active provider/model. Last resort: same model as failed agent.',
        });
        fallbackRow.add_suffix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
        repairAgentGroup.add(fallbackRow);

        // Save button
        const repairSaveRow = new Adw.ActionRow({
            title: repairExisting.providerId ? 'Update Repair Agent' : 'Create Repair Agent',
            subtitle: repairExisting.providerId
                ? `Currently: ${repairExisting.providerId} / ${repairExisting.modelId}`
                : 'Save provider and model to create a dedicated repair agent',
            activatable: true,
        });
        const repairSaveBtn = new Gtk.Button({
            icon_name: repairExisting.providerId ? 'document-save-symbolic' : 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular', 'suggested-action'],
            tooltip_text: 'Save auto-repair agent config',
        });
        const repairSaveHandler = () => {
            const providerId = repairProviderEntry.get_text().trim();
            const modelId = repairModelEntry.get_text().trim();
            if (!providerId || !modelId)
                return;
            const configs = this._getAgentConfigs();
            const rBackupProv = repairBackupProviderEntry.get_text().trim();
            const rBackupMod = repairBackupModelEntry.get_text().trim();
            configs['auto-repair'] = {
                name: 'Auto-Repair',
                providerId,
                modelId,
                systemPrompt: '',
                ...(repairModelSlug ? {modelSlug: repairModelSlug} : {}),
                ...(rBackupProv && rBackupMod ? {backupProviderId: rBackupProv, backupModelId: rBackupMod} : {}),
                ...(repairBackupModelSlug ? {backupModelSlug: repairBackupModelSlug} : {}),
            };
            this._saveAgentConfigs(configs);
            repairSaveRow.set_subtitle(`Saved: ${providerId} / ${modelId}`);
            repairSaveRow.set_title('Update Repair Agent');
            repairSaveBtn.set_icon_name('document-save-symbolic');
            if (this._agentRows)
                this._buildAgentList();
        };
        repairSaveBtn.connect('clicked', repairSaveHandler);
        repairSaveRow.connect('activated', repairSaveHandler);
        repairSaveRow.add_suffix(repairSaveBtn);
        repairAgentGroup.add(repairSaveRow);

        // Clear button — remove dedicated config, revert to fallback
        const repairClearRow = new Adw.ActionRow({
            title: 'Clear Dedicated Config',
            subtitle: 'Remove the auto-repair agent config and revert to fallback behavior',
            activatable: true,
        });
        const repairClearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular', 'destructive-action'],
            tooltip_text: 'Remove auto-repair config',
        });
        const repairClearHandler = () => {
            const configs = this._getAgentConfigs();
            delete configs['auto-repair'];
            this._saveAgentConfigs(configs);
            repairProviderEntry.set_text('');
            repairModelEntry.set_text('');
            repairSaveRow.set_subtitle('Save provider and model to create a dedicated repair agent');
            repairSaveRow.set_title('Create Repair Agent');
            repairSaveBtn.set_icon_name('list-add-symbolic');
            repairClearRow.set_subtitle('Config cleared — will use fallback behavior');
            if (this._agentRows)
                this._buildAgentList();
        };
        repairClearBtn.connect('clicked', repairClearHandler);
        repairClearRow.connect('activated', repairClearHandler);
        repairClearRow.add_suffix(repairClearBtn);
        repairAgentGroup.add(repairClearRow);

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

    // ── Models Registry Management ──

    _getModels() {
        try {
            return JSON.parse(this._settings.get_string('models') || '{}');
        } catch {
            return {};
        }
    }

    _saveModels(models) {
        this._settings.set_string('models', JSON.stringify(models));
    }

    _buildModelList() {
        for (const row of this._modelRows)
            this._modelListGroup.remove(row);
        this._modelRows = [];

        const models = this._getModels();
        const providers = this._getProviders();

        for (const [slug, cfg] of Object.entries(models)) {
            const provName = providers[cfg.providerId]?.name || cfg.providerId;
            const visionTag = cfg.isVision ? '  [vision]' : '';
            const row = new Adw.ActionRow({
                title: `${cfg.name || slug}`,
                subtitle: `${provName} / ${cfg.modelId}  |  Context: ${(cfg.maxContext || 128000).toLocaleString()}${visionTag}`,
            });

            const editBtn = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
                tooltip_text: `Edit ${slug}`,
            });
            editBtn.connect('clicked', () => this._showEditModelDialog(slug, cfg));
            row.add_suffix(editBtn);

            const deleteBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
                tooltip_text: `Remove ${slug}`,
            });
            deleteBtn.connect('clicked', () => {
                const m = this._getModels();
                delete m[slug];
                this._saveModels(m);
                this._buildModelList();
            });
            row.add_suffix(deleteBtn);

            this._modelListGroup.add(row);
            this._modelRows.push(row);
        }

        if (Object.keys(models).length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No models registered',
                subtitle: 'Click "Add Model" below to register one',
            });
            this._modelListGroup.add(emptyRow);
            this._modelRows.push(emptyRow);
        }
    }

    _showAddModelDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'Add Model',
            body: 'Register a model with its provider, API ID, and context limit',
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });

        const slugEntry = new Gtk.Entry({placeholder_text: 'Slug (e.g., sonnet, gpt4o, gemini-flash)'});
        const nameEntry = new Gtk.Entry({placeholder_text: 'Display name (e.g., Claude Sonnet 4)'});

        // Provider dropdown
        const providers = this._getProviders();
        const providerIds = Object.keys(providers);
        const providerList = new Gtk.StringList();
        for (const id of providerIds)
            providerList.append(id);
        const providerLabel = new Gtk.Label({label: 'Provider:', halign: Gtk.Align.START});
        const providerDropdown = new Gtk.DropDown({model: providerList});

        const modelIdEntry = new Gtk.Entry({placeholder_text: 'API Model ID (e.g., anthropic/claude-sonnet-4)'});
        const contextLabel = new Gtk.Label({label: 'Max Context Tokens:', halign: Gtk.Align.START});
        const contextSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1000, upper: 2000000,
                step_increment: 1000, value: 128000,
            }),
        });
        const visionCheck = new Gtk.CheckButton({label: 'Vision capable'});

        box.append(slugEntry);
        box.append(nameEntry);
        box.append(providerLabel);
        if (providerIds.length > 0)
            box.append(providerDropdown);
        else
            box.append(new Gtk.Label({label: '(No providers configured)', css_classes: ['dim-label']}));
        box.append(modelIdEntry);
        box.append(contextLabel);
        box.append(contextSpin);
        box.append(visionCheck);

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('add', 'Add');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (_dlg, response) => {
            if (response === 'add') {
                const slug = slugEntry.get_text().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
                const name = nameEntry.get_text().trim();
                const providerId = providerIds.length > 0
                    ? providerIds[providerDropdown.get_selected()] : '';
                const modelId = modelIdEntry.get_text().trim();
                const maxContext = contextSpin.get_value();
                const isVision = visionCheck.get_active();

                if (slug && providerId && modelId) {
                    const mdls = this._getModels();
                    mdls[slug] = {name: name || slug, providerId, modelId, maxContext, isVision};
                    this._saveModels(mdls);
                    this._buildModelList();
                }
            }
        });

        dialog.present(this._window);
    }

    _showEditModelDialog(slug, cfg) {
        const dialog = new Adw.AlertDialog({
            heading: `Edit Model: ${cfg.name || slug}`,
            body: `Editing model "${slug}"`,
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
            text: cfg.name || slug,
        });

        const providers = this._getProviders();
        const providerIds = Object.keys(providers);
        const providerList = new Gtk.StringList();
        for (const id of providerIds)
            providerList.append(id);
        const providerLabel = new Gtk.Label({label: 'Provider:', halign: Gtk.Align.START});
        const providerDropdown = new Gtk.DropDown({model: providerList});
        const currentProvIdx = providerIds.indexOf(cfg.providerId);
        if (currentProvIdx >= 0)
            providerDropdown.set_selected(currentProvIdx);

        const modelIdEntry = new Gtk.Entry({
            placeholder_text: 'API Model ID',
            text: cfg.modelId || '',
        });

        const contextLabel = new Gtk.Label({label: 'Max Context Tokens:', halign: Gtk.Align.START});
        const contextSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1000, upper: 2000000,
                step_increment: 1000, value: cfg.maxContext || 128000,
            }),
        });

        const visionCheck = new Gtk.CheckButton({label: 'Vision capable', active: cfg.isVision || false});

        box.append(nameEntry);
        box.append(providerLabel);
        if (providerIds.length > 0)
            box.append(providerDropdown);
        box.append(modelIdEntry);
        box.append(contextLabel);
        box.append(contextSpin);
        box.append(visionCheck);

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (_dlg, response) => {
            if (response === 'save') {
                const name = nameEntry.get_text().trim();
                const providerId = providerIds.length > 0
                    ? providerIds[providerDropdown.get_selected()] : cfg.providerId;
                const modelId = modelIdEntry.get_text().trim();
                const maxContext = contextSpin.get_value();
                const isVision = visionCheck.get_active();

                if (providerId && modelId) {
                    const mdls = this._getModels();
                    mdls[slug] = {name: name || slug, providerId, modelId, maxContext, isVision};
                    this._saveModels(mdls);
                    this._buildModelList();
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

        // Filter out agents that have their own dedicated settings pages
        const DEDICATED_AGENTS = ['computer-use', 'auto-repair'];

        for (const [id, cfg] of Object.entries(configs)) {
            if (DEDICATED_AGENTS.includes(id))
                continue;

            // Show model slug if available, otherwise provider/model
            const modelInfo = cfg.modelSlug
                ? `Model: ${cfg.modelSlug}`
                : `Provider: ${cfg.providerId}  |  Model: ${cfg.modelId}`;
            const backupInfo = cfg.backupModelSlug
                ? `  |  Backup: ${cfg.backupModelSlug}`
                : (cfg.backupProviderId
                    ? `  |  Backup: ${cfg.backupProviderId}/${cfg.backupModelId}`
                    : '');
            const row = new Adw.ActionRow({
                title: cfg.name || id,
                subtitle: `${modelInfo}${backupInfo}`,
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

        const userAgentCount = Object.keys(configs).filter(id => !DEDICATED_AGENTS.includes(id)).length;
        if (userAgentCount === 0) {
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

        // Model dropdown from registry
        const models = this._getModels();
        const slugs = Object.keys(models);
        const modelChoices = ['(Manual)', ...slugs];
        const modelList = new Gtk.StringList();
        for (const c of modelChoices)
            modelList.append(c);
        const modelLabel = new Gtk.Label({label: 'Model (from registry):', halign: Gtk.Align.START});
        const modelDropdown = new Gtk.DropDown({model: modelList});

        const providerEntry = new Gtk.Entry({placeholder_text: 'Provider ID (must match an existing provider)'});
        const modelEntry = new Gtk.Entry({placeholder_text: 'Model ID (e.g., anthropic/claude-sonnet-4)'});

        // Backup model dropdown
        const backupChoices = ['(None)', '(Manual)', ...slugs];
        const backupList = new Gtk.StringList();
        for (const c of backupChoices)
            backupList.append(c);
        const backupLabel = new Gtk.Label({label: 'Backup Model:', halign: Gtk.Align.START});
        const backupDropdown = new Gtk.DropDown({model: backupList});

        const backupProviderEntry = new Gtk.Entry({placeholder_text: 'Backup Provider ID (optional)'});
        const backupModelEntry = new Gtk.Entry({placeholder_text: 'Backup Model ID (optional)'});

        // Wire model dropdown → auto-fill entries
        let selectedModelSlug = '';
        let selectedBackupSlug = '';

        modelDropdown.connect('notify::selected', () => {
            const sel = modelDropdown.get_selected();
            if (sel === 0) {
                selectedModelSlug = '';
            } else {
                const slug = modelChoices[sel];
                const mc = models[slug];
                if (mc) {
                    selectedModelSlug = slug;
                    providerEntry.set_text(mc.providerId);
                    modelEntry.set_text(mc.modelId);
                }
            }
        });

        backupDropdown.connect('notify::selected', () => {
            const sel = backupDropdown.get_selected();
            if (sel === 0) {
                selectedBackupSlug = '';
                backupProviderEntry.set_text('');
                backupModelEntry.set_text('');
            } else if (sel === 1) {
                selectedBackupSlug = '';
            } else {
                const slug = backupChoices[sel];
                const mc = models[slug];
                if (mc) {
                    selectedBackupSlug = slug;
                    backupProviderEntry.set_text(mc.providerId);
                    backupModelEntry.set_text(mc.modelId);
                }
            }
        });

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
        box.append(modelLabel);
        box.append(modelDropdown);
        box.append(providerEntry);
        box.append(modelEntry);
        box.append(backupLabel);
        box.append(backupDropdown);
        box.append(backupProviderEntry);
        box.append(backupModelEntry);
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
                    const bProv = backupProviderEntry.get_text().trim();
                    const bMod = backupModelEntry.get_text().trim();
                    configs[id] = {
                        name: name || id, providerId, modelId, systemPrompt,
                        ...(selectedModelSlug ? {modelSlug: selectedModelSlug} : {}),
                        ...(bProv && bMod ? {backupProviderId: bProv, backupModelId: bMod} : {}),
                        ...(selectedBackupSlug ? {backupModelSlug: selectedBackupSlug} : {}),
                    };
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

        // Model dropdown from registry
        const models = this._getModels();
        const slugs = Object.keys(models);
        const modelChoices = ['(Manual)', ...slugs];
        const modelList = new Gtk.StringList();
        for (const c of modelChoices)
            modelList.append(c);
        const modelLabel = new Gtk.Label({label: 'Model (from registry):', halign: Gtk.Align.START});
        const modelDropdown = new Gtk.DropDown({model: modelList});
        const currentModelIdx = cfg.modelSlug ? modelChoices.indexOf(cfg.modelSlug) : 0;
        modelDropdown.set_selected(currentModelIdx >= 0 ? currentModelIdx : 0);

        const providerEntry = new Gtk.Entry({
            placeholder_text: 'Provider ID',
            text: cfg.providerId || '',
        });
        const modelEntry = new Gtk.Entry({
            placeholder_text: 'Model ID',
            text: cfg.modelId || '',
        });

        // Backup model dropdown
        const backupChoices = ['(None)', '(Manual)', ...slugs];
        const backupList = new Gtk.StringList();
        for (const c of backupChoices)
            backupList.append(c);
        const backupLabel = new Gtk.Label({label: 'Backup Model:', halign: Gtk.Align.START});
        const backupDropdown = new Gtk.DropDown({model: backupList});
        let backupIdx = 0;
        if (cfg.backupModelSlug && backupChoices.indexOf(cfg.backupModelSlug) >= 0)
            backupIdx = backupChoices.indexOf(cfg.backupModelSlug);
        else if (cfg.backupProviderId)
            backupIdx = 1;
        backupDropdown.set_selected(backupIdx);

        const backupProviderEntry = new Gtk.Entry({
            placeholder_text: 'Backup Provider ID (optional)',
            text: cfg.backupProviderId || '',
        });
        const backupModelEntry = new Gtk.Entry({
            placeholder_text: 'Backup Model ID (optional)',
            text: cfg.backupModelId || '',
        });

        // Wire dropdowns
        let selectedModelSlug = cfg.modelSlug || '';
        let selectedBackupSlug = cfg.backupModelSlug || '';

        modelDropdown.connect('notify::selected', () => {
            const sel = modelDropdown.get_selected();
            if (sel === 0) {
                selectedModelSlug = '';
            } else {
                const slug = modelChoices[sel];
                const mc = models[slug];
                if (mc) {
                    selectedModelSlug = slug;
                    providerEntry.set_text(mc.providerId);
                    modelEntry.set_text(mc.modelId);
                }
            }
        });

        backupDropdown.connect('notify::selected', () => {
            const sel = backupDropdown.get_selected();
            if (sel === 0) {
                selectedBackupSlug = '';
                backupProviderEntry.set_text('');
                backupModelEntry.set_text('');
            } else if (sel === 1) {
                selectedBackupSlug = '';
            } else {
                const slug = backupChoices[sel];
                const mc = models[slug];
                if (mc) {
                    selectedBackupSlug = slug;
                    backupProviderEntry.set_text(mc.providerId);
                    backupModelEntry.set_text(mc.modelId);
                }
            }
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
        box.append(modelLabel);
        box.append(modelDropdown);
        box.append(providerEntry);
        box.append(modelEntry);
        box.append(backupLabel);
        box.append(backupDropdown);
        box.append(backupProviderEntry);
        box.append(backupModelEntry);
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
                    const bProv = backupProviderEntry.get_text().trim();
                    const bMod = backupModelEntry.get_text().trim();
                    configs[id] = {
                        name: name || id, providerId, modelId, systemPrompt,
                        ...(selectedModelSlug ? {modelSlug: selectedModelSlug} : {}),
                        ...(bProv && bMod ? {backupProviderId: bProv, backupModelId: bMod} : {}),
                        ...(selectedBackupSlug ? {backupModelSlug: selectedBackupSlug} : {}),
                    };
                    this._saveAgentConfigs(configs);
                    this._buildAgentList();
                }
            }
        });

        dialog.present(this._window);
    }
}
