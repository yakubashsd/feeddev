# ListingFlow design system

## Direction

Calendly-inspired operational workspace for real-estate feed teams. Light is the default operating mode; dark is an explicit user preference. The shell uses a cool blue canvas, white (or deep navy) surfaces, saturated scheduling-blue actions, and restrained status colors. The main task remains visible: find a project, open it, then work with its feed.

## Tokens

- Font: local Circe (`--lf-font`), with system sans fallback.
- Light canvas: `#f4f8ff`; surface: `#ffffff`; text: `#11385e`; muted: `#506e8a`; line: `#d9e6f5`.
- Dark canvas: `#0e2438`; surface: `#12314f`; text: `#edf6ff`; muted: `#a9c2da`; line: `#2d5273`.
- Accent: `#0444fc` light / `#4f83ff` dark. Success, warning and error remain functional status colors.
- Radius: 12px for workspace surfaces; 7–8px for controls.
- Elevation: low-contrast border and soft shadow in light mode; no decorative glow.

## Surfaces

The client shell has one sidebar, one topbar, and one content column. The «Все проекты» page uses a heading/action row, four summary metrics, one filter row, and a compact project table. Project-specific navigation appears only after a project is selected.

## Interaction states

All primary controls expose hover, disabled and focus-visible states. Project lists support empty data, filters, sorting and pagination. Theme choice is stored in `localStorage` under `listingflow-theme` and safely falls back to light mode when storage is unavailable.
