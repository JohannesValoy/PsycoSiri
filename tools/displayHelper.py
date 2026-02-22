#!/usr/bin/env python3
"""Aether display resolution helper for GNOME Wayland.

Switches the primary monitor's resolution via Mutter's D-Bus API.
Used by the Computer Use agent to temporarily lower resolution
for faster OCR, smaller screenshots, and bigger UI elements.

Usage:
  displayHelper.py save              Save current config
  displayHelper.py set WxH           Switch to WxH (e.g. 1280x720)
  displayHelper.py restore           Restore saved config
  displayHelper.py list              List available modes
"""
import sys, json, os

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

BUS_NAME = 'org.gnome.Mutter.DisplayConfig'
OBJ_PATH = '/org/gnome/Mutter/DisplayConfig'
SAVE_PATH = '/tmp/.aether-display-saved.json'


def dbus_call(method, params=None):
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return bus.call_sync(BUS_NAME, OBJ_PATH, BUS_NAME, method,
                         params, None, Gio.DBusCallFlags.NONE, -1, None)


def get_state():
    """Returns (serial, monitors, logical_monitors) GVariants."""
    r = dbus_call('GetCurrentState')
    return (r.get_child_value(0).get_uint32(),
            r.get_child_value(1),
            r.get_child_value(2))


def get_primary_info(monitors, logical_monitors):
    """Get primary monitor's connector, current mode ID, and scale."""
    connector = None
    scale = 1.0

    # Find primary logical monitor
    for i in range(logical_monitors.n_children()):
        lm = logical_monitors.get_child_value(i)
        if lm.get_child_value(4).get_boolean():  # primary
            scale = lm.get_child_value(2).get_double()
            specs = lm.get_child_value(5)
            if specs.n_children() > 0:
                connector = specs.get_child_value(0).get_child_value(0).get_string()
            break

    # Fallback: first monitor
    if not connector and monitors.n_children() > 0:
        connector = monitors.get_child_value(0).get_child_value(0).get_child_value(0).get_string()

    # Find current mode for this connector
    current_mode = None
    for i in range(monitors.n_children()):
        mon = monitors.get_child_value(i)
        spec = mon.get_child_value(0)
        if spec.get_child_value(0).get_string() != connector:
            continue
        modes = mon.get_child_value(1)
        for j in range(modes.n_children()):
            mode = modes.get_child_value(j)
            props = mode.get_child_value(6)  # a{sv}
            for k in range(props.n_children()):
                entry = props.get_child_value(k)
                if entry.get_child_value(0).get_string() == 'is-current':
                    if entry.get_child_value(1).get_variant().get_boolean():
                        current_mode = mode.get_child_value(0).get_string()
                        break
            if current_mode:
                break
        break

    return connector, current_mode, scale


def find_mode(monitors, connector, target_w, target_h):
    """Find best mode matching target resolution (highest refresh rate)."""
    for i in range(monitors.n_children()):
        mon = monitors.get_child_value(i)
        spec = mon.get_child_value(0)
        if spec.get_child_value(0).get_string() != connector:
            continue
        modes = mon.get_child_value(1)
        best_id = None
        best_refresh = 0
        for j in range(modes.n_children()):
            mode = modes.get_child_value(j)
            mw = mode.get_child_value(1).get_int32()
            mh = mode.get_child_value(2).get_int32()
            mrefresh = mode.get_child_value(3).get_double()
            if mw == target_w and mh == target_h and mrefresh > best_refresh:
                best_id = mode.get_child_value(0).get_string()
                best_refresh = mrefresh
        return best_id
    return None


def list_modes(monitors, connector):
    """List all available modes for a connector."""
    result = []
    for i in range(monitors.n_children()):
        mon = monitors.get_child_value(i)
        spec = mon.get_child_value(0)
        if spec.get_child_value(0).get_string() != connector:
            continue
        modes = mon.get_child_value(1)
        for j in range(modes.n_children()):
            mode = modes.get_child_value(j)
            mid = mode.get_child_value(0).get_string()
            mw = mode.get_child_value(1).get_int32()
            mh = mode.get_child_value(2).get_int32()
            mrefresh = mode.get_child_value(3).get_double()
            # Check if current
            is_current = False
            props = mode.get_child_value(6)
            for k in range(props.n_children()):
                entry = props.get_child_value(k)
                if entry.get_child_value(0).get_string() == 'is-current':
                    is_current = entry.get_child_value(1).get_variant().get_boolean()
            result.append({
                'id': mid, 'w': mw, 'h': mh,
                'refresh': round(mrefresh, 2),
                'current': is_current,
            })
        break
    return result


def apply_config(serial, connector, mode_id, scale=1.0):
    """Apply monitor config (persistent)."""
    params = GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (
        serial,
        2,  # method: 2 = persistent
        [(0, 0, scale, 0, True, [(connector, mode_id, {})])],
        {}
    ))
    dbus_call('ApplyMonitorsConfig', params)


def cmd_save():
    serial, monitors, logical_monitors = get_state()
    connector, mode_id, scale = get_primary_info(monitors, logical_monitors)
    if not connector or not mode_id:
        print(json.dumps({'error': 'Could not determine current display config'}))
        sys.exit(1)

    config = {'connector': connector, 'mode_id': mode_id, 'scale': scale}
    with open(SAVE_PATH, 'w') as f:
        json.dump(config, f)
    print(json.dumps({'status': 'saved', **config}))


def cmd_set(resolution):
    w, h = map(int, resolution.lower().split('x'))
    serial, monitors, logical_monitors = get_state()
    connector, current_mode, _ = get_primary_info(monitors, logical_monitors)
    if not connector:
        print(json.dumps({'error': 'No primary monitor found'}))
        sys.exit(1)

    mode_id = find_mode(monitors, connector, w, h)
    if not mode_id:
        # List available resolutions for error message
        avail = list_modes(monitors, connector)
        resolutions = sorted(set(f"{m['w']}x{m['h']}" for m in avail),
                           key=lambda r: int(r.split('x')[0]), reverse=True)
        print(json.dumps({
            'error': f'No {w}x{h} mode available',
            'available': resolutions[:10],
        }))
        sys.exit(1)

    apply_config(serial, connector, mode_id, scale=1.0)
    print(json.dumps({
        'status': 'applied',
        'resolution': f'{w}x{h}',
        'mode_id': mode_id,
    }))


def cmd_restore():
    try:
        with open(SAVE_PATH) as f:
            config = json.load(f)
    except FileNotFoundError:
        print(json.dumps({'error': 'No saved config found'}))
        sys.exit(1)

    serial, _, _ = get_state()  # fresh serial required
    apply_config(serial, config['connector'], config['mode_id'], config['scale'])
    os.unlink(SAVE_PATH)
    print(json.dumps({'status': 'restored', **config}))


def cmd_list():
    serial, monitors, logical_monitors = get_state()
    connector, _, _ = get_primary_info(monitors, logical_monitors)
    modes = list_modes(monitors, connector)
    print(json.dumps({'connector': connector, 'modes': modes}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: displayHelper.py [save|set WxH|restore|list]')
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == 'save':
            cmd_save()
        elif cmd == 'set' and len(sys.argv) >= 3:
            cmd_set(sys.argv[2])
        elif cmd == 'restore':
            cmd_restore()
        elif cmd == 'list':
            cmd_list()
        else:
            print(json.dumps({'error': f'Unknown command: {cmd}'}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
