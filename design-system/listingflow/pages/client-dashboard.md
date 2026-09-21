# Client Dashboard Page Overrides

> **PROJECT:** ListingFlow
> **Generated:** 2026-09-21 11:11:34
> **Page Type:** Dashboard / Data View

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** 1400px or full-width
- **Grid:** 12-column grid for data flexibility

### Spacing Overrides

- **Content Density:** High — optimize for information display

### Typography Overrides

- No overrides — use Master typography

### Color Overrides

- No overrides — use Master colors

### Component Overrides

- Avoid: Leave UI frozen with no feedback
- Avoid: Make dragging the only way to reorder resize or select
- Avoid: Depend on animationend or transitionend for required state correctness

---

## Page-Specific Components

- No unique components for this page

---

## Recommendations

- Effects: Hover tooltips, chart zoom on click, row highlighting on hover, smooth filter animations, data loading spinners
- Animation: Use skeleton screens or spinners
- Accessibility: Add buttons menus or tap-to-move controls and retain keyboard operation
- Animation: Cancel or replace prior motion; set the final semantic state directly and handle cancellation cleanup
