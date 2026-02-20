import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TIMEOUT_MS = 300000; // 5 minutes

// Background process registry (shared across instances)
const _bgProcesses = new Map();
let _bgIdCounter = 0;

// Statistics tracking
let _statsDbPath = null;
let _currentSessionId = null;

/**
 * Initialize statistics tracking with database path
 */
function _initStats(dbPath) {
    if (_statsDbPath) return;
    _statsDbPath = dbPath;
    log('[Aether] Statistics tracking initialized');
}

/**
 * Execute SQL against the statistics database
 */
async function _execStatsSql(sql, params = []) {
    if (!_statsDbPath) return null;
    
    try {
        const argv = ['sqlite3', _statsDbPath, ...params, sql];
        const proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        
        const [ok, stdout, stderr] = await new Promise((resolve) => {
            proc.communicate_utf8_async(null, null, (source, result) => {
                resolve(source.communicate_utf8_finish(result));
            });
        });
        
        const exitStatus = proc.get_exit_status();
        return {stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), exitStatus};
    } catch (e) {
        log(`[Aether Stats] SQL exec error: ${e.message}`);
        return null;
    }
}

/**
 * Get command signature for grouping similar commands
 * Extracts the base command (first word) and key parts
 */
function _getCommandSignature(command) {
    // Get first word (the command itself)
    const parts = command.trim().split(/\s+/);
    if (parts.length === 0) return 'unknown';
    
    const baseCmd = parts[0];
    
    // For certain commands, include key options for better grouping
    if (['git', 'cargo', 'npm', 'pip', 'python3', 'python', 'node', 'make', 'gcc', 'g++'].includes(baseCmd)) {
        if (parts.length > 1) {
            return `${baseCmd} ${parts[1]}`; // e.g., "git clone", "npm install"
        }
    }
    
    return baseCmd;
}

/**
 * Escape SQL string value
 */
function _sqlEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/'/g, "''");
}

/**
 * Track a failed shell command (async, non-blocking)
 */
async function _trackFailure(command, exitCode, stderr, executionMode = 'foreground') {
    if (!_statsDbPath) return;
    
    try {
        const signature = _getCommandSignature(command);
        const timestamp = new Date().toISOString();
        const truncatedError = _sqlEscape(stderr ? stderr.slice(0, 2000) : '');
        const escapedCommand = _sqlEscape(command);
        const escapedSignature = _sqlEscape(signature);
        const escapedSessionId = _sqlEscape(_currentSessionId || '');
        
        // Insert into failures table
        const insertFailures = `
            INSERT INTO shell_command_failures 
            (command, command_type, exit_code, error_output, timestamp, session_id, execution_mode)
            VALUES ('${escapedCommand}', '${escapedSignature}', ${exitCode}, '${truncatedError}', '${timestamp}', '${escapedSessionId}', '${executionMode}');
        `;
        await _execStatsSql(insertFailures);
        
        // Update stats table (insert or update via upsert pattern)
        const upsertStats = `
            INSERT INTO shell_command_stats (command_signature, failure_count, last_failure, last_exit_code, last_error_output)
            VALUES ('${escapedSignature}', 1, '${timestamp}', ${exitCode}, '${truncatedError}')
            ON CONFLICT(command_signature) DO UPDATE SET
                failure_count = failure_count + 1,
                last_failure = '${timestamp}',
                last_exit_code = ${exitCode},
                last_error_output = '${truncatedError}';
        `;
        await _execStatsSql(upsertStats);
        
        log(`[Aether Stats] Tracked failure: ${signature} (exit: ${exitCode})`);
    } catch (e) {
        log(`[Aether Stats] Failed to track failure: ${e.message}`);
    }
}

/**
 * Set the current session ID for statistics tracking
 */
export function setStatsSessionId(sessionId) {
    _currentSessionId = sessionId;
}

/**
 * Initialize statistics tracking with database path
 */
export function initStats(dbPath) {
    _initStats(dbPath);
}

/**
 * Get failure statistics
 */
export async function getFailureStats() {
    if (!_statsDbPath) return [];
    
    try {
        const query = `
            SELECT command_signature, failure_count, last_failure, last_exit_code 
            FROM shell_command_stats 
            ORDER BY failure_count DESC 
            LIMIT 20;
        `;
        const result = await _execStatsSql(query);
        if (!result || result.exitStatus !== 0) return [];
        
        const lines = result.stdout.split('\n').filter(line => line.trim());
        return lines.map(line => {
            const parts = line.split('|');
            if (parts.length >= 4) {
                return {
                    command_signature: parts[0],
                    failure_count: parseInt(parts[1], 10) || 0,
                    last_failure: parts[2],
                    last_exit_code: parseInt(parts[3], 10) || 0
                };
            }
            return null;
        }).filter(Boolean);
    } catch (e) {
        log(`[Aether Stats] Failed to get stats: ${e.message}`);
        return [];
    }
}

export class ShellCommandTool {
    constructor() {
        this.name = 'run_command';
        this.description = 'Execute a bash shell command and return its output. Has full unrestricted sudo access. Use background=true for long-running commands — returns a process ID you can check with check_command. Failed commands are automatically tracked in statistics.';
        this.parameters = {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The bash command to execute',
                },
                timeout_ms: {
                    type: 'integer',
                    description: 'Timeout in milliseconds (default 300000 = 5 min)',
                },
                background: {
                    type: 'boolean',
                    description: 'Run in background and return immediately with a process ID (default: false)',
                },
                working_directory: {
                    type: 'string',
                    description: 'Working directory for the command (default: home directory)',
                },
            },
            required: ['command'],
        };
    }

    execute(args) {
        const {command, timeout_ms, background, working_directory} = args;

        // Build the actual command, prepending cd if working_directory is set
        const actualCommand = working_directory
            ? `cd ${GLib.shell_quote(working_directory)} && ${command}`
            : command;

        if (background)
            return this._runBackground(actualCommand);

        return this._runForeground(actualCommand, timeout_ms || TIMEOUT_MS);
    }

    _runBackground(command) {
        return new Promise((resolve) => {
            try {
                const proc = new Gio.Subprocess({
                    argv: ['bash', '-c', command],
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);

                const id = `bg_${++_bgIdCounter}`;
                const entry = {
                    id,
                    command,
                    proc,
                    startedAt: new Date().toISOString(),
                    state: 'running',
                    stdout: '',
                    stderr: '',
                    exit_code: null,
                };

                _bgProcesses.set(id, entry);

                // Collect output when done
                proc.communicate_utf8_async(null, null, (source, result) => {
                    try {
                        const [ok, stdout, stderr] = source.communicate_utf8_finish(result);
                        entry.stdout = (stdout || '').trim();
                        entry.stderr = (stderr || '').trim();
                        entry.exit_code = source.get_exit_status();
                        entry.state = entry.exit_code === 0 ? 'completed' : 'failed';
                        entry.completedAt = new Date().toISOString();
                        
                        // Track failures in statistics (non-blocking)
                        if (entry.exit_code !== 0) {
                            _trackFailure(command, entry.exit_code, entry.stderr, 'background').catch(() => {});
                        }
                    } catch (e) {
                        entry.state = 'failed';
                        entry.stderr = e.message;
                        entry.completedAt = new Date().toISOString();
                        
                        // Track exception as failure (non-blocking)
                        _trackFailure(command, -1, e.message, 'background').catch(() => {});
                    }
                });

                resolve(JSON.stringify({
                    process_id: id,
                    status: 'started',
                    message: `Background process started. Use check_command with process_id "${id}" to check status/output.`,
                }));
            } catch (e) {
                resolve(JSON.stringify({error: e.message, command}));
            }
        });
    }

    _runForeground(command, timeout) {
        return new Promise((resolve, reject) => {
            try {
                const proc = new Gio.Subprocess({
                    argv: ['bash', '-c', command],
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);

                let timedOut = false;
                const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                    timedOut = true;
                    proc.force_exit();
                    return GLib.SOURCE_REMOVE;
                });

                proc.communicate_utf8_async(null, null, (source, result) => {
                    GLib.source_remove(timeoutId);

                    try {
                        const [ok, stdout, stderr] = source.communicate_utf8_finish(result);
                        const exitCode = source.get_exit_status();

                        if (timedOut) {
                            resolve(JSON.stringify({
                                error: `Command timed out after ${timeout}ms. Consider using background=true for long-running commands.`,
                                command,
                            }));
                            return;
                        }

                        const output = {
                            stdout: (stdout || '').trim(),
                            stderr: (stderr || '').trim(),
                            exit_code: exitCode,
                        };

                        // Smart truncation: keep head + tail so errors at the end are visible
                        const MAX_OUT = 15000;
                        const MAX_ERR = 8000;
                        if (output.stdout.length > MAX_OUT) {
                            const head = output.stdout.slice(0, 4000);
                            const tail = output.stdout.slice(-10000);
                            output.stdout = `${head}\n\n... (${output.stdout.length - 14000} chars truncated) ...\n\n${tail}`;
                        }
                        if (output.stderr.length > MAX_ERR) {
                            const head = output.stderr.slice(0, 2000);
                            const tail = output.stderr.slice(-5000);
                            output.stderr = `${head}\n\n... (${output.stderr.length - 7000} chars truncated) ...\n\n${tail}`;
                        }

                        const jsonOutput = JSON.stringify(output);

                        // Track failures in statistics (non-blocking)
                        if (exitCode !== 0 && !timedOut) {
                            _trackFailure(command, exitCode, output.stderr, 'foreground').catch(() => {});
                        }

                        resolve(jsonOutput);
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                resolve(JSON.stringify({error: e.message, command}));
                
                // Track exception as failure (non-blocking)
                _trackFailure(command, -1, e.message, 'foreground').catch(() => {});
            }
        });
    }
}

export class CheckCommandTool {
    constructor() {
        this.name = 'check_command';
        this.description = 'Check the status and output of a background command started with run_command background=true. Can also kill running processes.';
        this.parameters = {
            type: 'object',
            properties: {
                process_id: {
                    type: 'string',
                    description: 'The process ID returned by run_command',
                },
                kill: {
                    type: 'boolean',
                    description: 'Kill the process if still running (default: false)',
                },
            },
            required: ['process_id'],
        };
    }

    execute(args) {
        const entry = _bgProcesses.get(args.process_id);
        if (!entry)
            return JSON.stringify({error: `No background process found with ID "${args.process_id}"`});

        if (args.kill && entry.state === 'running') {
            entry.proc.force_exit();
            entry.state = 'killed';
            entry.completedAt = new Date().toISOString();
            
            // Track killed process as failure (non-blocking)
            _trackFailure(entry.command, -9, 'Process killed by user', 'background').catch(() => {});
            
            return JSON.stringify({status: 'killed', process_id: args.process_id});
        }

        const result = {
            process_id: entry.id,
            command: entry.command,
            state: entry.state,
            startedAt: entry.startedAt,
            completedAt: entry.completedAt || null,
        };

        if (entry.state !== 'running') {
            result.stdout = entry.stdout;
            result.stderr = entry.stderr;
            result.exit_code = entry.exit_code;

            // Apply same smart truncation
            if (result.stdout && result.stdout.length > 15000) {
                const head = result.stdout.slice(0, 4000);
                const tail = result.stdout.slice(-10000);
                result.stdout = `${head}\n\n... (${result.stdout.length - 14000} chars truncated) ...\n\n${tail}`;
            }
            if (result.stderr && result.stderr.length > 8000) {
                const head = result.stderr.slice(0, 2000);
                const tail = result.stderr.slice(-5000);
                result.stderr = `${head}\n\n... (${result.stderr.length - 7000} chars truncated) ...\n\n${tail}`;
            }
        }

        return JSON.stringify(result);
    }
}
