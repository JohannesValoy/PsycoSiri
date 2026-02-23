import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export class AIProvider {
    constructor(id, name, apiKey, baseUrl) {
        this.id = id;
        this.name = name;
        this.apiKey = apiKey;
        // Normalize: strip trailing slashes and known endpoint suffixes
        // so we always store just the base (e.g. https://api.cerebras.ai/v1)
        let url = baseUrl.replace(/\/+$/, '');
        url = url.replace(/\/chat\/completions$/, '');
        url = url.replace(/\/models$/, '');
        // Ollama serves its OpenAI-compatible API at /v1 — auto-detect and append
        if (/:\d{4,5}$/.test(url) && !url.includes('/v1') && !url.includes('/api'))
            url += '/v1';
        this.baseUrl = url;
        this._session = new Soup.Session({
            timeout: 300, // 5 min — generous for local models (Ollama on CPU)
        });
    }

    /**
     * Fetch available models from the provider's /models endpoint.
     */
    listModels() {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}/models`;
            const msg = Soup.Message.new('GET', url);
            msg.get_request_headers().append('Authorization', `Bearer ${this.apiKey}`);

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const data = JSON.parse(text);
                    const models = (data.data || []).map(m => ({
                        id: m.id,
                        name: m.name || m.id,
                        context_length: m.context_length || 128000,
                    }));
                    resolve(models);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Send a chat completion request with automatic retry on transient errors.
     * Retries on: 429, 500, 502, 503, 504, socket/IO errors.
     * Uses exponential backoff: 2s, 4s, 8s, 16s, 32s.
     */
    async chat(messages, tools = [], onChunk = null, cancellable = null) {
        const MAX_RETRIES = 5;
        const BASE_DELAY_MS = 2000;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const _ta = Date.now();
                const result = await this._chatOnce(messages, tools, onChunk, cancellable);
                console.log(`[Aether][TIMING] _chatOnce OK: ${Date.now() - _ta}ms (attempt ${attempt}, tools: ${tools.length})`);
                return result;
            } catch (e) {
                const msg = e.message || String(e);
                console.log(`[Aether][TIMING] _chatOnce FAIL (attempt ${attempt}): ${msg.slice(0, 120)}`);
                // Don't retry if explicitly cancelled by user
                const isCancelled = cancellable?.is_cancelled()
                    || (msg.includes('ancelled') && !msg.includes('timeout'));
                if (isCancelled)
                    throw e;

                // Model doesn't support tools — retry once without tools
                if (/does not support tools/i.test(msg) && tools.length > 0) {
                    console.log(`[Aether] Model does not support tools — retrying without tools`);
                    const _tb = Date.now();
                    const noToolResult = await this._chatOnce(messages, [], onChunk, cancellable);
                    console.log(`[Aether][TIMING] _chatOnce (no tools) OK: ${Date.now() - _tb}ms`);
                    return noToolResult;
                }

                // Check if this is a retryable error
                const isRetryable = /HTTP (429|500|502|503|504)/i.test(msg)
                    || /timeout|timed out|socket|connection|reset|broken pipe|ECONNRESET/i.test(msg)
                    || /network|unreachable/i.test(msg)
                    || /IOErrorEnum/i.test(msg);

                if (!isRetryable || attempt === MAX_RETRIES)
                    throw e;

                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                console.log(`[Aether] API error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg.slice(0, 100)} — retrying in ${delay / 1000}s`);

                // Wait using GLib timeout (non-blocking in GJS)
                await new Promise(resolve => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
        }
    }

    /**
     * Single chat completion attempt (no retry).
     */
    _chatOnce(messages, tools = [], onChunk = null, cancellable = null) {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}/chat/completions`;
            const msg = Soup.Message.new('POST', url);
            msg.get_request_headers().append('Authorization', `Bearer ${this.apiKey}`);
            msg.get_request_headers().append('Content-Type', 'application/json');

            const payload = {
                model: this._model || 'openai/gpt-4o',
                messages,
                stream: !!onChunk,
            };

            if (tools.length > 0)
                payload.tools = tools;

            const bodyStr = JSON.stringify(payload);
            const bodyBytes = new GLib.Bytes(new TextEncoder().encode(bodyStr));
            msg.set_request_body_from_bytes('application/json', bodyBytes);

            if (onChunk) {
                // Streaming mode
                this._streamRequest(msg, onChunk, cancellable, resolve, reject);
            } else {
                // Non-streaming
                this._session.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, cancellable,
                    (session, result) => {
                        try {
                            const bytes = session.send_and_read_finish(result);
                            const text = new TextDecoder().decode(bytes.get_data());

                            // Use status_code property (raw int), NOT get_status() which
                            // returns Soup.Status enum and crashes on codes like 429
                            const statusCode = msg.status_code;

                            // Check HTTP status code
                            if (statusCode < 200 || statusCode >= 300) {
                                let errorMsg = `HTTP ${statusCode}`;
                                try {
                                    const errData = JSON.parse(text);
                                    if (errData.error?.message)
                                        errorMsg += `: ${errData.error.message}`;
                                    else if (errData.message)
                                        errorMsg += `: ${errData.message}`;
                                    else
                                        errorMsg += `: ${text.slice(0, 200)}`;
                                } catch {
                                    errorMsg += `: ${text.slice(0, 200)}`;
                                }
                                reject(new Error(errorMsg));
                                return;
                            }

                            const data = JSON.parse(text);
                            if (data.error) {
                                reject(new Error(data.error.message || JSON.stringify(data.error)));
                                return;
                            }
                            const choice = data.choices?.[0];
                            if (!choice) {
                                reject(new Error(`API returned no choices. Response: ${text.slice(0, 300)}`));
                                return;
                            }
                            resolve({
                                content: choice?.message?.content || '',
                                tool_calls: choice?.message?.tool_calls || [],
                                finish_reason: choice?.finish_reason || 'stop',
                                usage: data.usage,
                            });
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            }
        });
    }

    _streamRequest(msg, onChunk, cancellable, resolve, reject) {
        this._session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
            try {
                const inputStream = session.send_finish(result);
                const statusCode = msg.status_code;

                // If non-2xx, read the error body and reject
                if (statusCode < 200 || statusCode >= 300) {
                    const errStream = new Gio.DataInputStream({base_stream: inputStream});
                    let errText = '';
                    let errLine;
                    try {
                        while (([errLine] = errStream.read_line_utf8(cancellable)) && errLine !== null)
                            errText += errLine;
                    } catch {}
                    let errorMsg = `HTTP ${statusCode}`;
                    try {
                        const errData = JSON.parse(errText);
                        errorMsg += `: ${errData.error?.message || errData.message || errText.slice(0, 200)}`;
                    } catch {
                        if (errText) errorMsg += `: ${errText.slice(0, 200)}`;
                    }
                    reject(new Error(errorMsg));
                    return;
                }

                const dataStream = new Gio.DataInputStream({
                    base_stream: inputStream,
                });

                let fullContent = '';
                let toolCalls = [];
                let finishReason = 'stop';

                const readNextLine = () => {
                    dataStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, lineResult) => {
                        try {
                            const [line] = stream.read_line_finish_utf8(lineResult);

                            if (line === null) {
                                // Stream ended
                                resolve({content: fullContent, tool_calls: toolCalls, finish_reason: finishReason});
                                return;
                            }

                            if (line.startsWith('data: ')) {
                                const jsonStr = line.slice(6).trim();
                                if (jsonStr === '[DONE]') {
                                    resolve({content: fullContent, tool_calls: toolCalls, finish_reason: finishReason});
                                    return;
                                }

                                try {
                                    const chunk = JSON.parse(jsonStr);
                                    const delta = chunk.choices?.[0]?.delta;
                                    if (delta?.content) {
                                        fullContent += delta.content;
                                        if (onChunk)
                                            onChunk(delta.content);
                                    }
                                    if (delta?.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            if (tc.index !== undefined) {
                                                if (!toolCalls[tc.index]) {
                                                    toolCalls[tc.index] = {
                                                        id: tc.id || '',
                                                        type: 'function',
                                                        function: {name: '', arguments: ''},
                                                    };
                                                }
                                                if (tc.id)
                                                    toolCalls[tc.index].id = tc.id;
                                                if (tc.function?.name)
                                                    toolCalls[tc.index].function.name += tc.function.name;
                                                if (tc.function?.arguments)
                                                    toolCalls[tc.index].function.arguments += tc.function.arguments;
                                            }
                                        }
                                    }
                                    if (chunk.choices?.[0]?.finish_reason)
                                        finishReason = chunk.choices[0].finish_reason;
                                } catch {
                                    // Skip malformed JSON lines
                                }
                            }

                            readNextLine();
                        } catch (e) {
                            reject(e);
                        }
                    });
                };

                readNextLine();
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * TTS via OpenAI-compatible /audio/speech endpoint.
     * Returns a path to the generated audio file.
     */
    tts(text, voice = 'alloy') {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}/audio/speech`;
            const msg = Soup.Message.new('POST', url);
            msg.get_request_headers().append('Authorization', `Bearer ${this.apiKey}`);
            msg.get_request_headers().append('Content-Type', 'application/json');

            const payload = JSON.stringify({
                model: 'openai/tts-1',
                input: text,
                voice,
            });
            msg.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(payload))
            );

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const tmpPath = GLib.build_filenamev([GLib.get_tmp_dir(), 'aether_tts.mp3']);
                    const file = Gio.File.new_for_path(tmpPath);
                    const [ok] = file.replace_contents(
                        bytes.get_data(), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null
                    );
                    resolve(tmpPath);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    setModel(modelId) {
        this._model = modelId;
    }

    destroy() {
        this._session = null;
    }
}

/**
 * Manages multiple AI providers and the active selection.
 */
export class ProviderManager {
    constructor(settings) {
        this._settings = settings;
        this._providers = new Map();
        this._models = new Map();
        this._activeMaxContext = settings.get_int('max-context-tokens');
        this._loadProviders();
        this._loadModels();

        this._settings.connect('changed::providers', () => this._loadProviders());
        this._settings.connect('changed::models', () => { this._loadModels(); this._updateActive(); this._updateBackup(); });
        this._settings.connect('changed::active-provider', () => this._updateActive());
        this._settings.connect('changed::active-model', () => this._updateActiveModel());
        this._settings.connect('changed::active-model-slug', () => this._updateActive());
        this._settings.connect('changed::backup-provider', () => this._updateBackup());
        this._settings.connect('changed::backup-model', () => this._updateBackupModel());
        this._settings.connect('changed::backup-model-slug', () => this._updateBackup());
    }

    _loadProviders() {
        this._providers.clear();
        try {
            const raw = this._settings.get_string('providers');
            const configs = JSON.parse(raw);
            for (const [id, cfg] of Object.entries(configs)) {
                this._providers.set(id, new AIProvider(id, cfg.name, cfg.apiKey, cfg.baseUrl));
            }
        } catch {
            // Invalid JSON, start fresh
        }
        this._updateActive();
        this._updateBackup();
    }

    _loadModels() {
        this._models.clear();
        try {
            const raw = this._settings.get_string('models');
            const registry = JSON.parse(raw);
            for (const [slug, cfg] of Object.entries(registry))
                this._models.set(slug, cfg);
        } catch {
            // Invalid JSON
        }
    }

    _updateActive() {
        // Try model slug first (new registry system)
        const slug = this._settings.get_string('active-model-slug');
        if (slug) {
            const modelCfg = this._models.get(slug);
            if (modelCfg) {
                const provider = this._providers.get(modelCfg.providerId);
                if (provider) {
                    this._active = provider;
                    this._active.setModel(modelCfg.modelId);
                    this._activeMaxContext = modelCfg.maxContext || 128000;
                    return;
                }
            }
        }
        // Fallback to legacy direct provider/model keys
        const activeId = this._settings.get_string('active-provider');
        this._active = this._providers.get(activeId) || null;
        this._activeMaxContext = this._settings.get_int('max-context-tokens');
        this._updateActiveModel();
    }

    _updateActiveModel() {
        if (this._active) {
            const modelId = this._settings.get_string('active-model');
            this._active.setModel(modelId);
        }
    }

    _updateBackup() {
        // Try model slug first
        const slug = this._settings.get_string('backup-model-slug');
        if (slug) {
            const modelCfg = this._models.get(slug);
            if (modelCfg) {
                const provider = this._providers.get(modelCfg.providerId);
                if (provider) {
                    this._backup = provider;
                    this._backup.setModel(modelCfg.modelId);
                    return;
                }
            }
        }
        // Fallback to legacy
        const backupId = this._settings.get_string('backup-provider');
        this._backup = this._providers.get(backupId) || null;
        this._updateBackupModel();
    }

    _updateBackupModel() {
        if (this._backup) {
            const modelId = this._settings.get_string('backup-model');
            this._backup.setModel(modelId);
        }
    }

    get active() {
        return this._active;
    }

    get backup() {
        return this._backup;
    }

    get activeMaxContext() {
        return this._activeMaxContext || this._settings.get_int('max-context-tokens');
    }

    getProvider(id) {
        return this._providers.get(id);
    }

    get allProviders() {
        return [...this._providers.values()];
    }

    get modelsRegistry() {
        return Object.fromEntries(this._models);
    }

    getModelConfig(slug) {
        return this._models.get(slug) || null;
    }

    addProvider(id, name, apiKey, baseUrl) {
        const configs = JSON.parse(this._settings.get_string('providers') || '{}');
        configs[id] = {name, apiKey, baseUrl};
        this._settings.set_string('providers', JSON.stringify(configs));
    }

    removeProvider(id) {
        const configs = JSON.parse(this._settings.get_string('providers') || '{}');
        delete configs[id];
        this._settings.set_string('providers', JSON.stringify(configs));
    }
}
