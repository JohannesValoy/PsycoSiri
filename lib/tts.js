import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class TextToSpeech {
    constructor(providerManager, settings) {
        this._providerManager = providerManager;
        this._settings = settings;
        this._playbackProc = null;
    }

    get enabled() {
        return this._settings.get_boolean('tts-enabled');
    }

    /**
     * Speak text aloud using the AI provider's TTS endpoint.
     */
    async speak(text) {
        if (!this.enabled)
            return;

        const provider = this._providerManager.active;
        if (!provider)
            return;

        // Stop any current playback
        this.stop();

        try {
            const voice = this._settings.get_string('tts-voice') || 'alloy';
            const audioPath = await provider.tts(text, voice);

            // Play audio via gst-launch-1.0
            this._playbackProc = new Gio.Subprocess({
                argv: [
                    'gst-launch-1.0',
                    'filesrc', `location=${audioPath}`, '!',
                    'decodebin', '!',
                    'audioconvert', '!',
                    'pulsesink',
                ],
                flags: Gio.SubprocessFlags.NONE,
            });
            this._playbackProc.init(null);

            // Wait for playback to finish, then clean up
            this._playbackProc.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                } catch {}
                // Clean up temp file
                try {
                    Gio.File.new_for_path(audioPath).delete(null);
                } catch {}
                this._playbackProc = null;
            });
        } catch (e) {
            log(`[Aether] TTS error: ${e.message}`);
        }
    }

    /**
     * Stop current audio playback.
     */
    stop() {
        if (this._playbackProc) {
            this._playbackProc.force_exit();
            this._playbackProc = null;
        }
    }

    destroy() {
        this.stop();
    }
}
