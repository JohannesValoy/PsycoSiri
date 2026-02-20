import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {AetherOverlay} from './lib/overlay.js';
import {ProviderManager} from './lib/aiProvider.js';
import {Conversation} from './lib/conversation.js';
import {MemoryManager} from './lib/memory.js';
import {TodoManager} from './lib/todoManager.js';
import {ToolRegistry} from './lib/toolSystem.js';
import {ContextSummarizer} from './lib/summarizer.js';
import {SpeechToText} from './lib/stt.js';
import {TextToSpeech} from './lib/tts.js';
import {AetherDBusService} from './lib/dbusService.js';
import {AgentManager} from './lib/agentManager.js';
import {AgentIndicator} from './lib/agentIndicator.js';
import {generateSessionId, getDefaultDbPath} from './lib/utils.js';

export default class AetherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sessionId = generateSessionId();

        // Database path
        const dbPath = this._settings.get_string('db-path') || getDefaultDbPath();

        // Initialize subsystems
        this._memory = new MemoryManager(dbPath, this.path);
        this._memory.init().catch(e =>
            console.error(`[Aether] Memory init error: ${e.message}`));

        this._todoManager = new TodoManager(this._memory);

        this._providerManager = new ProviderManager(this._settings);

        this._toolRegistry = new ToolRegistry();
        this._agentManager = new AgentManager(this._settings, this._toolRegistry, this._memory, this.path);
        this._toolRegistry.registerBuiltins(this._memory, this._todoManager, this._settings, this._agentManager);
        this._toolRegistry.loadCustomTools();

        this._summarizer = new ContextSummarizer(
            this._providerManager,
            this._memory,
            this._settings
        );

        this._conversation = new Conversation(
            this._sessionId,
            this._providerManager,
            this._toolRegistry,
            this._memory,
            this._todoManager,
            this._summarizer,
            this._settings
        );

        this._stt = new SpeechToText(this._settings);
        this._tts = new TextToSpeech(this._providerManager, this._settings);

        // Create overlay UI and add to uiGroup
        this._overlay = new AetherOverlay(
            this._conversation,
            this._stt,
            this._tts,
            this._todoManager,
            this._settings
        );
        Main.layoutManager.uiGroup.add_child(this._overlay);

        // Register keybinding: hold Ctrl+Space for voice, tap for toggle
        Main.wm.addKeybinding(
            'toggle-overlay',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._overlay.holdToTalkStart()
        );

        // Start D-Bus service
        this._dbusService = new AetherDBusService(
            this._conversation,
            this._memory,
            this._todoManager,
            this._overlay,
            this._agentManager
        );
        this._dbusService.enable();

        // Agent panel indicator (top-right status area)
        this._agentIndicator = new AgentIndicator(this._agentManager, this._settings);
        Main.panel.addToStatusArea('aether-agents', this._agentIndicator);
    }

    disable() {
        // Remove keybinding
        Main.wm.removeKeybinding('toggle-overlay');

        // Remove agent indicator
        if (this._agentIndicator) {
            this._agentIndicator.destroy();
            this._agentIndicator = null;
        }

        // Destroy agent manager (cancels all running agents)
        if (this._agentManager) {
            this._agentManager.destroy();
            this._agentManager = null;
        }

        // Stop D-Bus service
        if (this._dbusService) {
            this._dbusService.disable();
            this._dbusService = null;
        }

        // Destroy overlay (it removes itself from uiGroup via destroy())
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }

        // Clean up subsystems
        if (this._stt) {
            this._stt.destroy();
            this._stt = null;
        }
        if (this._tts) {
            this._tts.destroy();
            this._tts = null;
        }

        this._conversation = null;
        this._summarizer = null;
        this._toolRegistry = null;
        this._todoManager = null;
        this._memory = null;
        this._providerManager = null;
        this._settings = null;
    }
}
