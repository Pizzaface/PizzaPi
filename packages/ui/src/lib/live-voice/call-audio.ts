import { Capacitor, registerPlugin } from "@capacitor/core";
import { getMobileRuntimeConfig } from "../mobile-runtime.js";

/** Android app only: voice-call audio mode while Live is open (see LiveAudioPlugin.java). */
const LiveAudio = registerPlugin<{ start(): Promise<void>; stop(): Promise<void> }>("PizzapiLiveAudio");

const nativeAndroid = () => getMobileRuntimeConfig().isMobileBundled && Capacitor.getPlatform() === "android";

/**
 * Android (browser or app) is where Web Audio playback escapes echo
 * cancellation. ponytail: gated to Android; widen if desktop/iOS still self-interrupt.
 */
export const needsCallAudio = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** Enter call mode; returns the undo. Best effort: Live still works without it. */
export function enterCallMode(): () => void {
    if (!nativeAndroid()) return () => {};
    const started = LiveAudio.start().catch((e: unknown) => console.warn("[live-voice] call mode unavailable", e));
    return () => void started.then(() => LiveAudio.stop()).catch(() => {});
}
