import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {getConfigDir} from './utils.js';

// Import built-in tools
import {ShellCommandTool, CheckCommandTool} from '../tools/shellCommand.js';
import {ReadFileTool, WriteFileTool, EditFileTool, ListDirectoryTool} from '../tools/fileOps.js';
import {WebSearchTool} from '../tools/webSearch.js';
import {AppLauncherTool} from '../tools/appLauncher.js';
import {SystemInfoTool} from '../tools/systemInfo.js';
import {ClipboardReadTool, ClipboardWriteTool} from '../tools/clipboard.js';
import {ScreenshotTool, MouseClickTool, MouseMoveTool, KeyboardTypeTool,
    KeyboardShortcutTool, ScrollTool, WaitTool, ClickAtTextTool} from '../tools/computerUse.js';

export class ToolRegistry {
    constructor() {
        this._tools = new Map();
    }

    /**
     * Register a tool definition.
     */
    register(tool) {
        this._tools.set(tool.name, tool);
    }

    /**
     * Unregister a tool by name.
     */
    unregister(name) {
        this._tools.delete(name);
    }

    /**
     * Get OpenAI-format tool schemas for the API request.
     */
    getToolSchemas() {
        return [...this._tools.values()].map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    /**
     * Execute a tool by name with given arguments.
     */
    async execute(name, args) {
        const tool = this._tools.get(name);
        if (!tool)
            return JSON.stringify({error: `Unknown tool: ${name}`});

        try {
            const result = await tool.execute(args);
            return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (e) {
            return JSON.stringify({error: e.message});
        }
    }

    /**
     * Register all built-in tools.
     */
    registerBuiltins(memory, todoManager, settings, agentManager = null) {
        this.register(new ShellCommandTool());
        this.register(new CheckCommandTool());
        this.register(new ReadFileTool());
        this.register(new WriteFileTool());
        this.register(new EditFileTool());
        this.register(new ListDirectoryTool());
        this.register(new WebSearchTool(settings));
        this.register(new AppLauncherTool());
        this.register(new SystemInfoTool());
        this.register(new ClipboardReadTool());
        this.register(new ClipboardWriteTool());

        // Computer use tools (screenshot, mouse, keyboard, scroll)
        if (settings.get_boolean('computer-use-enabled')) {
            this.register(new ScreenshotTool(settings));
            this.register(new MouseClickTool(settings));
            this.register(new MouseMoveTool());
            this.register(new KeyboardTypeTool());
            this.register(new KeyboardShortcutTool());
            this.register(new ScrollTool());
            this.register(new WaitTool());
            this.register(new ClickAtTextTool(settings));
        }

        // Memory tools
        this.register({
            name: 'memory_store',
            description: 'Store a memory/fact for long-term recall. Use agent_learning for patterns, gotchas, and solutions discovered during tasks.',
            parameters: {
            background: {type: 'boolean', default: false},
                type: 'object',
                properties: {
                    type: {type: 'string', enum: ['fact', 'preference', 'procedure', 'note', 'agent_learning']},
                    content: {type: 'string', description: 'The information to remember'},
                    keywords: {type: 'string', description: 'Comma-separated keywords for search'},
                },
                required: ['type', 'content'],
            },
            execute: async (args) => {
                await memory.store(args.type, args.content, args.keywords || '', 5);
                return 'Memory stored successfully.';
            },
        });

        this.register({
            name: 'memory_recall',
            description: 'Search stored memories by keyword or phrase.',
            parameters: {
                type: 'object',
                properties: {
                    query: {type: 'string', description: 'Search query'},
                },
                required: ['query'],
            },
            execute: async (args) => {
                const results = await memory.recall(args.query);
                if (results.length === 0)
                    return 'No memories found matching that query.';
                return results.map(m => `[${m.type}] ${m.content}`).join('\n');
            },
        });

        // Todo tools
        this.register({
            name: 'todo_add',
            description: 'Add a new todo item.',
            parameters: {
                type: 'object',
                properties: {
                    content: {type: 'string', description: 'The todo item text'},
                    priority: {type: 'integer', description: 'Priority 1-10 (default 5)'},
                },
                required: ['content'],
            },
            execute: async (args) => {
                const id = await todoManager.add(args.content, args.priority || 5);
                return `Todo added with ID ${id}.`;
            },
        });

        this.register({
            name: 'todo_list',
            description: 'List all todo items, optionally filtered by status.',
            parameters: {
                type: 'object',
                properties: {
                    status: {type: 'string', enum: ['pending', 'in_progress', 'completed']},
                },
            },
            execute: async (args) => {
                const todos = await todoManager.list(args.status || null);
                if (todos.length === 0)
                    return 'No todos found.';
                return todos.map(t =>
                    `#${t.id} [${t.status}] (p${t.priority}) ${t.content}`
                ).join('\n');
            },
        });

        this.register({
            name: 'todo_complete',
            description: 'Mark a todo item as completed by its ID.',
            parameters: {
                type: 'object',
                properties: {
                    id: {type: 'integer', description: 'The todo item ID'},
                },
                required: ['id'],
            },
            execute: async (args) => {
                await todoManager.complete(args.id);
                return `Todo #${args.id} marked as completed.`;
            },
        });

        this.register({
            name: 'todo_remove',
            description: 'Delete a todo item by its ID.',
            parameters: {
                type: 'object',
                properties: {
                    id: {type: 'integer', description: 'The todo item ID'},
                },
                required: ['id'],
            },
            execute: async (args) => {
                await todoManager.remove(args.id);
                return `Todo #${args.id} removed.`;
            },
        });

        // Agent tools (only if agentManager is available)
        if (agentManager) {
            this.register({
                name: 'spawn_agent',
                description: 'Spawn a background AI agent to work on a task independently. Returns a run ID to check later. The agent runs in the background with its own AI provider/model and has access to all tools (shell, files, web search, etc.). Call with no arguments to list available agents.',
                parameters: {
                    type: 'object',
                    properties: {
                        agent_id: {
                            type: 'string',
                            description: 'The agent configuration ID (e.g., "researcher", "coder"). Omit to list available agents.',
                        },
                        task: {
                            type: 'string',
                            description: 'The task description for the agent to work on.',
                        },
                    },
                },
                execute: async (args) => {
                    if (!args.agent_id || !args.task) {
                        const configs = agentManager.getAgentConfigs();
                        const entries = Object.entries(configs);
                        if (entries.length === 0)
                            return 'No agents configured. Go to Aether Settings > Agents to add agent configurations.';
                        return 'Available agents:\n' + entries.map(([id, cfg]) =>
                            `  - ${id}: ${cfg.name} (${cfg.modelId})`
                        ).join('\n');
                    }

                    try {
                        const runId = await agentManager.spawnAgent(args.agent_id, args.task);
                        return JSON.stringify({
                            status: 'spawned',
                            run_id: runId,
                            message: `Agent spawned successfully. Use check_agent with run_id "${runId}" to check progress later.`,
                        });
                    } catch (e) {
                        return JSON.stringify({error: e.message});
                    }
                },
            });

            this.register({
                name: 'check_agent',
                description: 'Check the status and result of a background agent run. Pass the run_id returned by spawn_agent. Returns state (running/completed/error), result text if completed, and tool call count.',
                parameters: {
                    type: 'object',
                    properties: {
                        run_id: {
                            type: 'string',
                            description: 'The agent run ID returned by spawn_agent.',
                        },
                    },
                    required: ['run_id'],
                },
                execute: async (args) => {
                    const result = agentManager.checkAgent(args.run_id);
                    return JSON.stringify(result, null, 2);
                },
            });
        }
    }

    /**
     * Load custom tools from ~/.config/aether/tools/
     */
    async loadCustomTools() {
        const toolsDir = GLib.build_filenamev([getConfigDir(), 'tools']);
        const dir = Gio.File.new_for_path(toolsDir);
        if (!dir.query_exists(null))
            return;

        try {
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.endsWith('.js')) {
                    try {
                        const module = await import(
                            GLib.build_filenamev([toolsDir, name])
                        );
                        if (module.default)
                            this.register(module.default);
                    } catch (e) {
                        log(`[Aether] Failed to load custom tool ${name}: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            log(`[Aether] Failed to enumerate custom tools: ${e.message}`);
        }
    }
}
