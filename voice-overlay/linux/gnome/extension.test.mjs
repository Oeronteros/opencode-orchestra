import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

// Execute the actual extension against a deterministic GNOME API fixture.
const source = readFileSync(new URL('./extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export default class', 'return class');

function fixture({legacy = false} = {}) {
    const timers = new Map();
    const events = [];
    const clipboard = [];
    let next = 1, modifiers = 0, focusedId = 23, app = 'OpenCode';
    const keyboard = {notify_keyval(_time, key, state) { events.push([key, state]); }};
    const backend = {get_default_seat: () => ({create_virtual_device: () => keyboard})};
    const global = {
        stage: {context: legacy ? undefined : {get_backend: () => backend}},
        get_pointer: () => [0, 0, modifiers],
        display: {
            focus_window: {get_stable_sequence: () => focusedId, get_pid: () => 42,
                get_title: () => 'OpenCode 中文', get_wm_class: () => app},
            grab_accelerator: () => 9, ungrab_accelerator() {},
            connect(_name, callback) { global.trigger = callback; return 8; }, disconnect() {},
        },
    };
    const GLib = {
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        get_monotonic_time: () => 1000000,
        timeout_add(_priority, _time, callback) { const id = next++; timers.set(id, callback); return id; },
        source_remove: id => timers.delete(id),
        Variant: class {constructor(type, value) { this.type = type; this.value = value; }},
        VariantType: class {},
    };
    const Gio = {
        DBusCallFlags: {NONE: 0},
        DBus: {session: {call_sync: () => ({deep_unpack: () => [':1.42']}), call() { events.push(['toggle']); }}},
        DBusExportedObject: {wrapJSObject: () => ({export() {}, unexport() {}})},
    };
    const Clutter = {
        ModifierType: {CONTROL_MASK: 1, SHIFT_MASK: 2, MOD1_MASK: 4, MOD4_MASK: 8},
        InputDeviceType: {KEYBOARD_DEVICE: 1}, KeyState: {PRESSED: 1, RELEASED: 0},
        KEY_Control_L: 29, KEY_Shift_L: 42, KEY_v: 47,
        ...(legacy ? {get_default_backend: () => backend} : {}),
    };
    const St = {ClipboardType: {CLIPBOARD: 1}, Clipboard: {get_default: () => ({set_text(_type, text) { clipboard.push(text); }})}};
    const Extension = new Function('Gio', 'GLib', 'Clutter', 'Meta', 'Shell', 'St', 'Main', 'Extension', 'global', source)(
        Gio, GLib, Clutter, {KeyBindingFlags: {NONE: 0}, external_binding_name_for_action: () => 'voice'},
        {ActionMode: {NORMAL: 1, NONE: 0}}, St, {wm: {allowKeybinding() {}}}, class {}, global);
    const extension = new Extension();
    extension.enable();
    function tick() { for (const [id, callback] of [...timers]) if (!callback()) timers.delete(id); }
    function invocation(sender = ':1.42') {
        return {get_sender: () => sender, value: null, error: null,
            return_value(value) { this.value = value.value; },
            return_dbus_error(_name, error) { this.error = error; }};
    }
    return {extension, events, clipboard, tick, timers, keyboard, invocation, global,
        modifiers(value) { modifiers = value; }, focus(value) { focusedId = value; }, app(value) { app = value; }};
}

test('GNOME inserts multilingual clipboard text without Enter and releases modifiers', () => {
    const f = fixture(); const call = f.invocation();
    f.extension.PasteAsync([f.extension.GetFocus(), 'Русский English 中文 🐧'], call); f.tick();
    assert.deepEqual(f.clipboard, ['Русский English 中文 🐧']);
    assert.deepEqual(f.events, [[29, 1], [47, 1], [47, 0], [29, 0]]);
    assert.deepEqual(call.value, [true]);
    f.extension.disable();
});
test('GNOME terminal uses Ctrl+Shift+V, with legacy and current backend APIs', () => {
    for (const legacy of [false, true]) {
        const f = fixture({legacy}); f.app('org.gnome.Ptyxis'); const call = f.invocation();
        f.extension.PasteAsync([f.extension.GetFocus(), 'текст'], call); f.tick();
        assert.deepEqual(f.events, [[29, 1], [42, 1], [47, 1], [47, 0], [42, 0], [29, 0]]);
        f.extension.disable();
    }
});
test('GNOME never pastes into a window changed while waiting for release', () => {
    const f = fixture(); f.modifiers(1); const call = f.invocation();
    f.extension.PasteAsync([f.extension.GetFocus(), 'private draft'], call); f.tick();
    f.focus(24); f.modifiers(0); f.tick();
    assert.match(call.error, /Окно изменилось/); assert.equal(f.events.length, 0); assert.equal(f.clipboard.length, 0);
    f.extension.disable();
});
test('GNOME refuses injection and clipboard writes from another D-Bus client', () => {
    const f = fixture();
    for (const method of ['PasteAsync', 'CopyAsync']) {
        const call = f.invocation(':1.99');
        f.extension[method](method === 'CopyAsync' ? ['text'] : [f.extension.GetFocus(), 'text'], call);
        assert.match(call.error, /Unauthorized/);
    }
    assert.equal(f.events.length, 0); assert.equal(f.clipboard.length, 0); f.extension.disable();
});
test('GNOME explicit copy never injects keys', () => {
    const f = fixture(); const call = f.invocation();
    f.extension.CopyAsync(['中文'], call);
    assert.deepEqual(f.clipboard, ['中文']); assert.deepEqual(call.value, [true]);
    assert.equal(f.events.length, 0); f.extension.disable();
});
test('GNOME shortcut debounces autorepeat and waits for modifier release', () => {
    const f = fixture(); f.modifiers(5);
    f.global.trigger(null, 9); f.global.trigger(null, 9); f.tick(); assert.equal(f.events.length, 0);
    f.modifiers(0); f.tick(); assert.deepEqual(f.events, [['toggle']]);
    f.extension.disable(); assert.equal(f.timers.size, 0);
});
test('GNOME timeout and disable finish requests and allow later retries', () => {
    const f = fixture(); f.modifiers(1); const call = f.invocation();
    f.extension.PasteAsync([f.extension.GetFocus(), 'text'], call);
    for (let i = 0; i < 101; ++i) f.tick();
    assert.match(call.error, /Отпустите/); assert.equal(f.extension._pasting, false);
    const retry = f.invocation(); f.extension.PasteAsync([f.extension.GetFocus(), 'text'], retry);
    f.extension.disable(); assert.match(retry.error, /выключено/); assert.equal(f.timers.size, 0);
});
test('GNOME releases successfully pressed keys after an injection failure', () => {
    const f = fixture(); const call = f.invocation();
    const original = f.keyboard.notify_keyval;
    f.keyboard.notify_keyval = (time, key, state) => { if (key === 47 && state === 1) throw new Error('keyboard refused'); original(time, key, state); };
    f.extension.PasteAsync([f.extension.GetFocus(), 'text'], call); f.tick();
    assert.match(call.error, /keyboard refused/); assert.deepEqual(f.events, [[29, 1], [29, 0]]);
    assert.equal(f.extension._pasting, false); f.extension.disable();
});
