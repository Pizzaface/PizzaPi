---
name: UI org switcher and admin pages
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.9
depends_on: [PizzaPi-8d5.2, PizzaPi-8d5.3]
parallel: true
conflicts_with: []
---

# Task: UI org switcher and admin pages

## Description

Build the UI components for multitenancy: an org switcher in the main app header, a control plane admin page for managing orgs, and an org settings page within each instance.

## Acceptance Criteria

- [ ] **Org switcher** dropdown in app header showing user's orgs (fetched from control plane `/api/user/orgs`)
- [ ] Selecting an org navigates to `{slug}.pizzapi.example.com`
- [ ] Current org is visually highlighted in the switcher
- [ ] **Admin page** (`/admin` on control plane domain): list all orgs, create new org, delete org, view health status
- [ ] **Org settings page** (`/settings/org` on org instance): view org info, manage members (list, invite, remove), view connected runners
- [ ] All pages are responsive and follow existing shadcn/ui design patterns
- [ ] Loading and error states handled for all API calls

## Technical Details

- Org switcher: Radix UI `DropdownMenu` component, placed in existing header/nav
- Admin page: new route in UI, only rendered when on control plane domain (detect via `window.location`)
- Org settings: new route in existing org instance UI
- API calls: use existing fetch utilities, point to control plane URL for org data
- Control plane URL stored in env var `VITE_CONTROL_PLANE_URL`

## Dependencies

- [ ] Task 002 — org CRUD API endpoints
- [ ] Task 003 — JWT auth (for authenticating cross-origin requests to control plane)

## Effort Estimate

- Size: L
- Hours: 10
- Parallel: true — can run alongside tasks 4, 5, 6, 7, 8
