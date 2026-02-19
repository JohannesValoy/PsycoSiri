import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {runSubprocess, readFileAsync} from './utils.js';

const RECORD_PATH = '/tmp/aether_rec.wav';
const SILENCE_TIMEOUT_MS = 2500;

export class SpeechToText {
    constructor(settings) {
        this._settings = settings;
        this._isRecording = false;
        this._pipeline = null;
        this._silenceTimeoutId = null;
        this._onStopped = null;
    }

    get isRecording() {
        return this._isRecording;
    }

    /**
     * Get the whisper model path from settings or default.
     */
    _getModelPath() {
        let path = this._settings.get_string('stt-model-path');
        if (!path) {
            // Try common locations
            const candidates = [
                GLib.build_filenamev([GLib.get_home_dir(), '.config', 'aether', 'models', 'ggml-base.en.bin']),
                '/usr/share/whisper-cpp/models/ggml-base.en.bin',
                '/usr/local/share/whisper-cpp/models/ggml-base.en.bin',
            ];
            for (const c of candidates) {
                if (GLib.file_test(c, GLib.FileTest.EXISTS)) {
                    path = c;
                    break;
                }
            }
        }
        return path;
    }

    /**
     * Start recording audio from the microphone.
     * @param {Function} onStopped - Called with transcribed text when recording stops
     * @param {boolean} noAutoStop - If true, skip the auto-stop timeout (caller will manually stop)
     */
    startRecording(onStopped, noAutoStop = false) {
        if (this._isRecording)
            return;

        this._isRecording = true;
        this._onStopped = onStopped;

        // Clean up any previous recording
        const recFile = Gio.File.new_for_path(RECORD_PATH);
        if (recFile.query_exists(null)) {
            try { recFile.delete(null); } catch {}
        }

        // Start GStreamer recording via subprocess
        // Using gst-launch-1.0 for simplicity and reliability
        try {
            this._recordProc = new Gio.Subprocess({
                argv: [
                    'gst-launch-1.0', '-e',
                    'pulsesrc', '!',
                    'audioconvert', '!',
                    'audioresample', '!',
                    'audio/x-raw,rate=16000,channels=1,format=S16LE', '!',
                    'wavenc', '!',
                    'filesink', `location=${RECORD_PATH}`,
                ],
                flags: Gio.SubprocessFlags.STDERR_PIPE,
            });
            this._recordProc.init(null);

            // Auto-stop after max recording time (skip if caller controls stop)
            if (!noAutoStop) {
                this._silenceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SILENCE_TIMEOUT_MS * 4, () => {
                    this._silenceTimeoutId = null;
                    if (this._isRecording)
                        this.stopRecording();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (e) {
            console.error(`[Aether] Failed to start recording: ${e.message}`);
            this._isRecording = false;
        }
    }

    /**
     * Stop recording and transcribe the audio.
     */
    async stopRecording() {
        if (!this._isRecording)
            return;

        this._isRecording = false;

        if (this._silenceTimeoutId) {
            GLib.source_remove(this._silenceTimeoutId);
            this._silenceTimeoutId = null;
        }

        // Stop GStreamer recording
        if (this._recordProc) {
            this._recordProc.send_signal(2); // SIGINT for clean EOS
            try {
                await new Promise((resolve) => {
                    this._recordProc.wait_async(null, (proc, result) => {
                        try { proc.wait_finish(result); } catch {}
                        resolve();
                    });
                });
            } catch {}
            this._recordProc = null;
        }

        // Small delay to ensure file is written
        await new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Transcribe with whisper.cpp
        const modelPath = this._getModelPath();
        if (!modelPath) {
            if (this._onStopped)
                this._onStopped('(Error: No whisper model found. Set path in settings.)');
            return;
        }

        try {
            // Find whisper-cpp binary — check known locations
            let whisperCmd = null;
            const candidates = [
                'whisper-cpp',
                GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'whisper-cpp']),
                '/usr/local/bin/whisper-cpp',
                '/usr/bin/whisper-cpp',
            ];
            for (const cmd of candidates) {
                if (cmd.startsWith('/')) {
                    if (GLib.file_test(cmd, GLib.FileTest.EXISTS)) {
                        whisperCmd = cmd;
                        break;
                    }
                } else {
                    const {exitStatus} = await runSubprocess(['which', cmd]);
                    if (exitStatus === 0) {
                        whisperCmd = cmd;
                        break;
                    }
                }
            }
            if (!whisperCmd) {
                if (this._onStopped)
                    this._onStopped('(Error: whisper-cpp not found. Install to ~/.local/bin/)');
                return;
            }

            const {stdout, stderr, exitStatus} = await runSubprocess([
                whisperCmd,
                '-m', modelPath,
                '-f', RECORD_PATH,
                '--no-timestamps',
                '-l', 'en',
            ]);

            if (exitStatus !== 0) {
                console.error(`[Aether] Whisper error: ${stderr}`);
                if (this._onStopped)
                    this._onStopped(`(Transcription error: ${stderr.slice(0, 200)})`);
                return;
            }

            // whisper-cpp outputs transcription on stdout
            const transcription = stdout.trim()
                .split('\n')
                .filter(line => !line.startsWith('['))  // Remove timestamp lines
                .join(' ')
                .trim();

            if (this._onStopped)
                this._onStopped(transcription || '(No speech detected)');
        } catch (e) {
            console.error(`[Aether] Transcription failed: ${e.message}`);
            if (this._onStopped)
                this._onStopped(`(Transcription failed: ${e.message})`);
        }
    }

    destroy() {
        if (this._isRecording) {
            this._isRecording = false;
            if (this._recordProc) {
                this._recordProc.force_exit();
                this._recordProc = null;
            }
        }
        if (this._silenceTimeoutId) {
            GLib.source_remove(this._silenceTimeoutId);
            this._silenceTimeoutId = null;
        }
    }
}
