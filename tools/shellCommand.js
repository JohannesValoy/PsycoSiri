import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const TIMEOUT_MS = 30000;

export class ShellCommandTool {
    constructor() {
        this.name = 'run_command';
        this.description = 'Execute a bash shell command and return its output. Use for opening apps, managing files, system tasks, etc.';
        this.parameters = {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The bash command to execute',
                },
                timeout_ms: {
                    type: 'integer',
                    description: 'Timeout in milliseconds (default 30000)',
                },
            },
            required: ['command'],
        };
    }

    execute(args) {
        return new Promise((resolve, reject) => {
            const {command, timeout_ms} = args;
            const timeout = timeout_ms || TIMEOUT_MS;

            try {
                const proc = new Gio.Subprocess({
                    argv: ['bash', '-c', command],
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);

                // Set up timeout
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
                                error: `Command timed out after ${timeout}ms`,
                                command,
                            }));
                            return;
                        }

                        const output = {
                            stdout: (stdout || '').trim(),
                            stderr: (stderr || '').trim(),
                            exit_code: exitCode,
                        };

                        // Truncate very long output
                        if (output.stdout.length > 10000)
                            output.stdout = output.stdout.slice(0, 10000) + '\n... (truncated)';
                        if (output.stderr.length > 5000)
                            output.stderr = output.stderr.slice(0, 5000) + '\n... (truncated)';

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
