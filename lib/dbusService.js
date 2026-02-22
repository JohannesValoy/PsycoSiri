import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_IFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.Aether">
    <method name="SendMessage">
      <arg type="s" name="message" direction="in"/>
      <arg type="s" name="response" direction="out"/>
    </method>
    <method name="Toggle"/>
    <method name="AddMemory">
      <arg type="s" name="type" direction="in"/>
      <arg type="s" name="content" direction="in"/>
    </method>
    <method name="AddTodo">
      <arg type="s" name="content" direction="in"/>
      <arg type="i" name="id" direction="out"/>
    </method>
    <method name="ListTodos">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="CompleteTodo">
      <arg type="i" name="id" direction="in"/>
    </method>
    <method name="GetStatus">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="ListSavedTasks">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="RetryTask">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="runId" direction="out"/>
    </method>
    <method name="DismissTask">
      <arg type="i" name="id" direction="in"/>
    </method>
    <method name="SendAgentMessage">
      <arg type="s" name="runId" direction="in"/>
      <arg type="s" name="message" direction="in"/>
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="ListAgentRuns">
      <arg type="s" name="json" direction="out"/>
    </method>
    <method name="GetAgentRun">
      <arg type="s" name="runId" direction="in"/>
      <arg type="s" name="json" direction="out"/>
    </method>
    <signal name="ResponseChunk">
      <arg type="s" name="chunk"/>
    </signal>
  </interface>
</node>`;

export class AetherDBusService {
    constructor(conversation, memory, todoManager, overlay, agentManager = null) {
        this._conversation = conversation;
        this._memory = memory;
        this._todoManager = todoManager;
        this._overlay = overlay;
        this._agentManager = agentManager;
        this._dbusId = null;
        this._nameId = null;
    }

    enable() {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_IFACE);
        const ifaceInfo = nodeInfo.interfaces[0];

        this._dbusId = Gio.DBus.session.register_object(
            '/org/gnome/Shell/Extensions/Aether',
            ifaceInfo,
            (connection, sender, objectPath, interfaceName, methodName, params, invocation) => {
                this._handleMethod(methodName, params, invocation);
            },
            null, null
        );

        this._nameId = Gio.DBus.session.own_name(
            'org.gnome.Shell.Extensions.Aether',
            Gio.BusNameOwnerFlags.NONE,
            null, null
        );
    }

    async _handleMethod(methodName, params, invocation) {
        try {
            switch (methodName) {
            case 'SendMessage': {
                const [message] = params.deep_unpack();
                const response = await this._overlay.sendMessage(message);
                invocation.return_value(new GLib.Variant('(s)', [response]));
                break;
            }
            case 'Toggle': {
                this._overlay.toggle();
                invocation.return_value(null);
                break;
            }
            case 'AddMemory': {
                const [type, content] = params.deep_unpack();
                await this._memory.store(type, content, '', 5);
                invocation.return_value(null);
                break;
            }
            case 'AddTodo': {
                const [content] = params.deep_unpack();
                const id = await this._todoManager.add(content);
                invocation.return_value(new GLib.Variant('(i)', [id]));
                break;
            }
            case 'ListTodos': {
                const todos = await this._todoManager.list();
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(todos)]));
                break;
            }
            case 'CompleteTodo': {
                const [id] = params.deep_unpack();
                await this._todoManager.complete(id);
                invocation.return_value(null);
                break;
            }
            case 'GetStatus': {
                const status = {
                    session_id: this._conversation.sessionId,
                    messages: this._conversation.messages.length,
                    provider: 'active',
                };
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(status)]));
                break;
            }
            case 'ListSavedTasks': {
                const tasks = this._agentManager
                    ? await this._agentManager.getSavedTasks() : [];
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(tasks)]));
                break;
            }
            case 'RetryTask': {
                const [id] = params.deep_unpack();
                if (!this._agentManager)
                    throw new Error('AgentManager not available');
                const runId = await this._agentManager.retryTask(id);
                invocation.return_value(new GLib.Variant('(s)', [runId]));
                break;
            }
            case 'DismissTask': {
                const [id] = params.deep_unpack();
                if (!this._agentManager)
                    throw new Error('AgentManager not available');
                await this._agentManager.dismissTask(id);
                invocation.return_value(null);
                break;
            }
            case 'SendAgentMessage': {
                const [runId, message] = params.deep_unpack();
                if (!this._agentManager)
                    throw new Error('AgentManager not available');
                const result = this._agentManager.sendMessageToAgent(runId, message);
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
                break;
            }
            case 'ListAgentRuns': {
                const agents = this._agentManager
                    ? this._agentManager.listAgents() : [];
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(agents)]));
                break;
            }
            case 'GetAgentRun': {
                const [runId] = params.deep_unpack();
                let result;
                if (this._agentManager) {
                    result = this._agentManager.checkAgent(runId);
                    if (result.error && result.error.includes('No agent run found') && this._memory) {
                        result = await this._memory.getAgentRun(runId) || {error: 'Not found'};
                    }
                } else {
                    result = {error: 'AgentManager not available'};
                }
                invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
                break;
            }
            default:
                invocation.return_dbus_error(
                    'org.gnome.Shell.Extensions.Aether.Error',
                    `Unknown method: ${methodName}`
                );
            }
        } catch (e) {
            invocation.return_dbus_error(
                'org.gnome.Shell.Extensions.Aether.Error',
                e.message
            );
        }
    }

    disable() {
        if (this._dbusId) {
            Gio.DBus.session.unregister_object(this._dbusId);
            this._dbusId = null;
        }
        if (this._nameId) {
            Gio.DBus.session.unown_name(this._nameId);
            this._nameId = null;
        }
    }
}
