import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {runSubprocess} from '../lib/utils.js';

export class SystemInfoTool {
    constructor() {
        this.name = 'system_info';
        this.description = 'Get system information: CPU, memory, disk, hostname, uptime, processes.';
        this.parameters = {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    enum: ['all', 'cpu', 'memory', 'disk', 'processes', 'hostname', 'uptime'],
                    description: 'What info to retrieve (default: all)',
                },
            },
        };
    }

    async execute(args) {
        const category = args.category || 'all';
        const info = {};

        try {
            if (category === 'all' || category === 'hostname') {
                info.hostname = GLib.get_host_name();
                info.user = GLib.get_user_name();
            }

            if (category === 'all' || category === 'uptime') {
                const {stdout} = await runSubprocess(['uptime', '-p']);
                info.uptime = stdout.trim();
            }

            if (category === 'all' || category === 'cpu') {
                const {stdout} = await runSubprocess(['bash', '-c',
                    "grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | xargs && nproc"]);
                const lines = stdout.trim().split('\n');
                info.cpu = {model: lines[0], cores: parseInt(lines[1]) || 0};

                const {stdout: loadAvg} = await runSubprocess(['bash', '-c',
                    "cat /proc/loadavg | cut -d' ' -f1-3"]);
                info.cpu.load_average = loadAvg.trim();
            }

            if (category === 'all' || category === 'memory') {
                const {stdout} = await runSubprocess(['free', '-h', '--si']);
                info.memory = stdout.trim();
            }

            if (category === 'all' || category === 'disk') {
                const {stdout} = await runSubprocess(['df', '-h', '/']);
                info.disk = stdout.trim();
            }

            if (category === 'all' || category === 'processes') {
                const {stdout} = await runSubprocess(['bash', '-c',
                    'ps aux --sort=-%mem | head -11']);
                info.top_processes = stdout.trim();
            }

            return JSON.stringify(info, null, 2);
        } catch (e) {
            return JSON.stringify({error: e.message});
        }
    }
}
