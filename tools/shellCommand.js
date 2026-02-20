import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TIMEOUT_MS = 300000; // 5 minutes

// Background process registry (shared across instances)
const _bgProcesses = new Map();
let _bgIdCounter = 0;

export class ShellCommandTool {
    constructor() {
        this.name = 'run_command';
        this.description = 'Execute a bash shell command and return its output. Has full unrestricted sudo access. Use background=true for long-running commands — returns a process ID you can check with check_command.';
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
                    } catch (e) {
                        entry.state = 'failed';
                        entry.stderr = e.message;
                        entry.completedAt = new Date().toISOString();
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

                        resolve(JSON.stringify(output));
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                resolve(JSON.stringify({error: e.message, command}));
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
