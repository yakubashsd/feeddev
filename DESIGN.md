# ListingFlow design system

## Direction

DashStack-inspired operational workspace for real-estate feed teams. Light is the default operating mode; dark is an explicit user preference. The shell uses a quiet grey canvas, white (or graphite) surfaces, a blue-violet action color, and restrained status colors. The main task remains visible: find a project, open it, then work with its feed.

## Tokens

- Font: local Circe (`--lf-font`), with system sans fallback.
- Light canvas: `#f5f6fa`; surface: `#ffffff`; text: `#202633`; muted: `#60697a`; line: `#e5e8ef`.
- Dark canvas: `#202431`; surface: `#2b3041`; text: `#f3f4fa`; muted: `#bec4d4`; line: `#3b4257`.
- Accent: `#5965d8` light / `#7b85ee` dark. Success, warning and error remain functional status colors.
- Radius: 12px for workspace surfaces; 7–8px for controls.
- Elevation: low-contrast border and soft shadow in light mode; no decorative glow.

## Surfaces

The client shell has one sidebar, one topbar, and one content column. The «Все проекты» page uses a heading/action row, four summary metrics, one filter row, and a compact project table. Project-specific navigation appears only after a project is selected.

## Interaction states

All primary controls expose hover, disabled and focus-visible states. Project lists support empty data, filters, sorting and pagination. Theme choice is stored in `localStorage` under `listingflow-theme` and safely falls back to light mode when storage is unavailable.
