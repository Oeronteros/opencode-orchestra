import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const XML = `<node><interface name="ai.opencode.VoiceOverlay.Focus">
  <method name="GetFocus"><arg type="s" direction="out"/></method>
  <method name="Copy"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
  <method name="Paste"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
</interface></node>`;
const PATH = '/ai/opencode/VoiceOverlay/Focus';
const CONTROL = Clutter.ModifierType.CONTROL_MASK;
const SHIFT = Clutter.ModifierType.SHIFT_MASK;
const ALT = Clutter.ModifierType.MOD1_MASK;
const SUPER = Clutter.ModifierType.MOD4_MASK;

export default class VoiceInput extends Extension {
    _focus() {
        const w = global.display.focus_window;
        return w ? {backend: 'gnome', id: String(w.get_stable_sequence()),
            process: Math.max(0, w.get_pid()), title: w.get_title() ?? '',
            app_id: w.get_wm_class() ?? ''} : null;
    }

    GetFocus() { return JSON.stringify(this._focus()); }

    _released(callback, invocation = null) {
        let tries = 0;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (++tries > 100) {
                this._sources.delete(source);
                if (invocation) this._pasting = false;
                else this._triggerPending = false;
                invocation?.return_dbus_error('ai.opencode.VoiceOverlay.Error', 'Отпустите клавиши. Текст сохранён.');
                return GLib.SOURCE_REMOVE;
            }
            if (global.get_pointer()[2] & (CONTROL | SHIFT | ALT | SUPER))
                return GLib.SOURCE_CONTINUE;
            this._sources.delete(source);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.set(source, invocation);
    }

    _authorized(invocation) {
        // Only the running overlay that owns its session-bus name can inject.
        try {
            const owner = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', ['ai.opencode.VoiceOverlay']),
                new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 1000, null).deep_unpack()[0];
            if (invocation.get_sender() !== owner) throw new Error('Unauthorized caller');
        } catch (error) {
            invocation.return_dbus_error('ai.opencode.VoiceOverlay.Error', String(error));
            return false;
        }
        return true;
    }

    CopyAsync([text], invocation) {
        if (!this._authorized(invocation)) return;
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            invocation.return_value(new GLib.Variant('(b)', [true]));
        } catch (error) { invocation.return_dbus_error('ai.opencode.VoiceOverlay.Error', String(error)); }
    }

    PasteAsync([expected, text], invocation) {
        if (!this._authorized(invocation)) return;
        if (this._pasting || !text.trim()) {
            invocation.return_dbus_error('ai.opencode.VoiceOverlay.Error', 'Вставка занята или текст пуст.');
            return;
        }
        this._pasting = true;
        this._released(() => {
            try {
                // The check happens after modifiers are released, just before injection.
                if (this.GetFocus() !== expected)
                    throw new Error('Окно изменилось. Текст сохранён.');
                const focus = JSON.parse(expected);
                if (!focus || focus.app_id === 'ai.opencode.voice-overlay')
                    throw new Error('Поставьте курсор в поле OpenCode.');
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
                const terminal = /^(gnome-terminal(-server)?|org\.gnome\.(terminal|console|ptyxis)|kgx|kitty|alacritty|org\.alacritty\.alacritty|konsole|org\.kde\.(konsole|yakuake)|yakuake|guake|foot|wezterm|org\.wezfurlong\.wezterm|ghostty|com\.mitchellh\.ghostty|tilix|terminator|xterm|uxterm|st|urxvt|rxvt|xfce4-terminal|mate-terminal|lxterminal)$/i.test(focus.app_id);
                const keys = [Clutter.KEY_Control_L, ...(terminal ? [Clutter.KEY_Shift_L] : []), Clutter.KEY_v];
                const pressed = [];
                try {
                    for (const key of keys) {
                        this._keyboard.notify_keyval(GLib.get_monotonic_time(),
                            key, Clutter.KeyState.PRESSED);
                        pressed.push(key);
                    }
                } finally {
                    for (const key of pressed.reverse())
                        this._keyboard.notify_keyval(GLib.get_monotonic_time(),
                            key, Clutter.KeyState.RELEASED);
                }
                invocation.return_value(new GLib.Variant('(b)', [true]));
            } catch (error) {
                invocation.return_dbus_error('ai.opencode.VoiceOverlay.Error', String(error));
            } finally { this._pasting = false; }
        }, invocation);
    }

    enable() {
        this._sources = new Map();
        this._pasting = false;
        const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend?.();
        this._keyboard = backend.get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._object = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._object.export(Gio.DBus.session, PATH);
        this._accelerator = global.display.grab_accelerator('<Control><Alt>space', Meta.KeyBindingFlags.NONE);
        if (!this._accelerator) {
            this.disable();
            throw new Error('Ctrl+Alt+Space занят другим приложением.');
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._accelerator), Shell.ActionMode.NORMAL);
        this._signal = global.display.connect('accelerator-activated', (_display, action) => {
            if (action !== this._accelerator || this._triggerPending) return;
            this._triggerPending = true;
            this._released(() => {
                this._triggerPending = false;
                Gio.DBus.session.call('ai.opencode.VoiceOverlay', '/ai/opencode/VoiceOverlay',
                    'ai.opencode.VoiceOverlay', 'Toggle', null, null,
                    Gio.DBusCallFlags.NONE, 3000, null, (connection, result) => {
                        try { connection.call_finish(result); } catch (error) { console.debug(String(error)); }
                    });
            });
        });
    }

    disable() {
        if (this._signal) global.display.disconnect(this._signal);
        if (this._accelerator) {
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._accelerator), Shell.ActionMode.NONE);
            global.display.ungrab_accelerator(this._accelerator);
        }
        for (const [source, invocation] of this._sources ?? []) {
            GLib.source_remove(source);
            invocation?.return_dbus_error('ai.opencode.VoiceOverlay.Error', 'Расширение выключено. Текст сохранён.');
        }
        this._sources?.clear();
        this._object?.unexport();
        this._keyboard = null;
        this._object = null;
        this._signal = this._accelerator = 0;
        this._triggerPending = false;
        this._pasting = false;
    }
}
