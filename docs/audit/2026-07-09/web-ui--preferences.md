# Audit: web-ui/preferences.mdx
Verdict: MAJOR ISSUES
Claims checked: 24 | Failed: 9

## Findings

### [P1] Accent colors table is outdated — describes removed preset system
- Claim (lines 41–49): "Choose from preset accent color palettes … | Default | Blue … | Green … | Orange … | Purple …"
- Reality: The current UI offers **8 hex presets** (Blue, Green, Orange, Purple, Red, Pink, Teal, Yellow) **plus a native color picker** for any custom color. The docs' 4-row table matches the *old* `data-accent="green|orange|purple"` system in `accent-colors.css`, which is now dead code. `AppearanceSettings.tsx:7-16` defines `ACCENT_PRESETS` with 8 entries; `AppearanceSettings.tsx:185-215` renders the custom `<input type="color">` picker and a "Reset color" button. The docs omit Red, Pink, Teal, Yellow and the entire custom-color feature.
- Fix: Rewrite the section to list all 8 presets + the custom color picker + reset button.

### [P2] "data-accent attribute" mechanism description is wrong
- Claim (line 51): "The selection is applied via a `data-accent` attribute on the root element."
- Reality: `applyAccentColor` (`AppearanceSettings.tsx:67-87`) sets `data-accent` to the literal string `"custom"` for *every* selection and applies the actual color via inline `--primary`/`--ring` CSS variables computed from the hex. The attribute value never reflects the chosen preset name; the old `accent-colors.css` `[data-accent="green"]` selectors are no longer triggered. The FOUC inline script likewise hardcodes `data-accent="custom"` (`index.html:46`).
- Fix: Say accent colors are applied via `--primary`/`--ring` CSS variables on `<html>` (with a `data-accent="custom"` marker).

### [P1] No standalone ⚙️ gear icon in the desktop toolbar
- Claim (line 7): "Open it from the user menu (avatar icon) → Preferences, or from the ⚙️ icon in the toolbar on desktop."
- Reality: The desktop header toolbar (`AppHeaders.tsx:152-205`) contains buttons for Theme (Monitor/Sun/Moon), Notifications (Bell), Haptics (Vibrate), API keys (KeyRound), and Keyboard shortcuts — **no gear/Settings toolbar button**. Preferences is reachable on desktop *only* via the "Preferences" item inside the avatar dropdown (`AppHeaders.tsx:229-231`), where the `Settings` icon is the menu item's glyph, not a toolbar icon.
- Fix: Drop "or from the ⚙️ icon in the toolbar on desktop"; state Preferences is opened from the avatar dropdown on both desktop and mobile.

### [P2] "Theme toggle in the user dropdown menu" is only true on mobile
- Claim (line 19): "The theme toggle in the user dropdown menu provides a quick cycle through all three modes without opening Preferences."
- Reality: The cycling theme toggle (`ThemeMenuItems`, `AppHeaders.tsx:65-72`) is rendered only in the **Mobile** header dropdown (`AppHeaders.tsx:478`). On desktop the cycler is a **standalone toolbar button** `ThemeToggleButton` (`AppHeaders.tsx:44-62`, rendered at `AppHeaders.tsx:176`), and the desktop avatar dropdown contains no theme item. The docs imply the dropdown cycler exists generally.
- Fix: Clarify the desktop toolbar has a dedicated theme button; the dropdown cycler is mobile-only.

### [P1] "All preferences stored locally in localStorage" contradicts model-visibility server sync
- Claim (lines 9-10): "All preferences are stored locally in your browser (`localStorage`) and persist across sessions. They are not tied to any specific runner."
- Reality: Hidden-model visibility is persisted **server-side per user account** via `PUT /api/settings/hidden-models` (`HiddenModelsManager.tsx:46-58` `saveHiddenModels`; server `routes/settings.ts:18-34` calls `setHiddenModels(identity.userId, …)`). `fetchHiddenModels` merges the server-authoritative set back into localStorage. So model visibility is account-scoped, not purely local. ("Not tied to any specific runner" is true, but "All … stored locally in localStorage" is false for this preference.)
- Fix: State that appearance/notification prefs are localStorage-only, while model visibility also syncs to your account on the server.

### [P2] "Thicker borders" in High contrast is unsupported
- Claim (line 57): "Uses thicker borders and larger focus indicators"
- Reality: High-contrast CSS (`style.css:289-320`) only changes `--border` **color** to pure black/white — it never increases `border-width`. The only sizing change is the focus ring: `[data-contrast="high"] *:focus-visible { outline: 3px solid …; outline-offset: 2px; }` (`style.css:356-359`). "Larger focus indicators" is correct; "thicker borders" is not.
- Fix: Say High contrast switches borders to maximum-contrast colors and enlarges focus outlines.

### [P2] UI density scope overstated
- Claim (line 69): "Controls spacing and padding throughout the interface"
- Reality: `data-density` selectors (`style.css:402-408`) only target `.pp-message-content`, `.group/msg`, and `header` padding. Other UI (sidebars, panels, dialogs, inputs) is unaffected. "Throughout the interface" overstates the scope.
- Fix: Say density controls message and header padding/spacing.

### [P3] Suppress-child toggle availability nuance omitted
- Claim (lines 89-92): "When enabled, notifications from child sessions … are suppressed."
- Reality: Behavior is correct (`push.ts:574` skips subs with `suppressChildNotifications` when `isChildSession`). But the toggle is shown only `when supported && subscribed && !native` (`UserPreferencesPanel.tsx:71-87`) — i.e. Web Push only; it is hidden on the Android native/ntfy path (`native` branch). Docs don't mention this gate.
- Fix: Note the suppress-child option appears only for browser Web Push subscriptions, not the native app path.

### [P3] Accent "Default = Blue" framing doesn't match the picker UI
- Claim (line 43): "| Default | Blue — the standard PizzaPi palette |"
- Reality: There is no "Default" swatch; the default is the *absence* of an override (empty hex), restored via a "Reset color" button (`AppearanceSettings.tsx:209-218`). "Blue" is just the first preset swatch, not a distinct "Default" entry.
- Fix: Describe the default as the built-in palette (no override) with a reset control, and list Blue as one of the 8 swatches.

## Redesign notes
- The Appearance → Accent section needs a full rewrite: it documents a removed `data-accent` preset system; the live UI is 8 swatches + custom color picker + reset.
- Add a short "Where these are stored" matrix: appearance = localStorage; push subscription + suppress-child = server per endpoint; hidden models = server per user (with localStorage cache). The current "all localStorage" framing is the single biggest conceptual error.
- Reconcile the "open Preferences" instructions with both desktop (avatar dropdown only) and mobile (avatar dropdown) — there is no toolbar gear button.
- Consider a small "Reset appearance" mention; the panel has a "Reset all" button (`AppearanceSettings.tsx:288-302`) not documented anywhere.
- The Notifications tab's "not supported on this device" fallback (`UserPreferencesPanel.tsx:31-35`) is worth one line.

## Code UX opportunities
- `applyAccentColor` sets `data-accent="custom"` for every selection, leaving the named-preset selectors in `accent-colors.css` as dead code — either delete `accent-colors.css` or have the swatches set meaningful `data-accent` values so the docs' mental model could be real.
- The desktop header exposes Theme/Notifications/Haptics/API-keys as toolbar buttons but forces users into the avatar dropdown for Preferences; a gear toolbar button (which the docs already imply exists) would match user expectation and the docs.
- `data-density` and `data-font-size` only affect message content/headers, yet the UI labels promise "throughout the interface"; either widen the CSS scope or soften the labels so docs and product agree.
- High-contrast changes border *color* but not *width*; if "thicker borders" is a desired AA/AAA trait, add `border-width` overrides rather than relying on color alone.
