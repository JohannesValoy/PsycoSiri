import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

export const AnimationState = {
    OFF: 'off',
    IDLE: 'idle',
    LISTENING: 'listening',
    THINKING: 'thinking',
};

const ALL_STATES = [AnimationState.IDLE, AnimationState.LISTENING, AnimationState.THINKING];

const PULSE_INTERVALS = {
    [AnimationState.IDLE]: 2500,
    [AnimationState.LISTENING]: 500,
    [AnimationState.THINKING]: 900,
};

export class GlowAnimation {
    /**
     * @param {St.Widget} widget - The widget to animate
     * @param {string} classPrefix - CSS class prefix (e.g. 'aether-ring' or 'aether-aurora')
     * @param {boolean} controlsOpacity - Whether to manipulate widget opacity.
     *   Set to false when animating a widget that has its own content (like the popup),
     *   so only CSS class toggling is used for the glow effect.
     */
    constructor(widget, classPrefix = 'aether-ring', controlsOpacity = true) {
        this._widget = widget;
        this._classPrefix = classPrefix;
        this._controlsOpacity = controlsOpacity;
        this._state = AnimationState.OFF;
        this._pulseTimeoutId = null;
        this._pulsePhase = false;
    }

    get state() {
        return this._state;
    }

    _getStateClass(state) {
        return `${this._classPrefix}-${state}`;
    }

    _getAltClass(state) {
        return `${this._classPrefix}-${state}-alt`;
    }

    setState(newState) {
        if (this._state === newState)
            return;

        this._state = newState;

        // Remove all state CSS classes (base + alt)
        for (const s of ALL_STATES) {
            this._widget.remove_style_class_name(this._getStateClass(s));
            this._widget.remove_style_class_name(this._getAltClass(s));
        }

        // Stop old pulse
        this._stopPulse();

        if (newState === AnimationState.OFF) {
            if (this._controlsOpacity)
                this._widget.opacity = 0;
            return;
        }

        if (this._controlsOpacity)
            this._widget.opacity = 255;

        // Apply new CSS class
        this._widget.add_style_class_name(this._getStateClass(newState));

        // Start pulse animation
        this._startPulse(newState);

        // Transition animation (only if controlling opacity)
        if (this._controlsOpacity) {
            this._widget.ease({
                opacity: 255,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            });
        }
    }

    _startPulse(state) {
        const interval = PULSE_INTERVALS[state];
        if (!interval)
            return;

        this._pulsePhase = false;

        this._pulseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._widget || this._state !== state)
                return GLib.SOURCE_REMOVE;

            this._pulsePhase = !this._pulsePhase;

            // Alternate opacity for breathing effect (only if controlling opacity)
            if (this._controlsOpacity) {
                const targetOpacity = this._pulsePhase ? 200 : 255;
                this._widget.ease({
                    opacity: targetOpacity,
                    duration: interval,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            }

            // Toggle alt class for color breathing on all states
            const altClass = this._getAltClass(state);
            if (this._pulsePhase)
                this._widget.add_style_class_name(altClass);
            else
                this._widget.remove_style_class_name(altClass);

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPulse() {
        if (this._pulseTimeoutId) {
            GLib.source_remove(this._pulseTimeoutId);
            this._pulseTimeoutId = null;
        }
    }

    destroy() {
        this._stopPulse();
        this._widget = null;
    }
}
