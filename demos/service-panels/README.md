# Service Panel Demos

Example UI panel components for PizzaPi runner services.

## SystemMonitorPanel

A React component that displays CPU, memory, and disk usage from the `system-monitor` runner service plugin.

### Prerequisites

The `system-monitor` service must be installed on the runner:

```bash
# Copy the service plugin to the runner's services directory
cp ~/.pizzapi/services/system-monitor.js ~/.pizzapi/services/
```

### Usage

To use this panel in your PizzaPi UI, add it to `packages/ui/src/components/service-panels/registry.tsx`:

```tsx
import { Activity } from "lucide-react";
import { SystemMonitorPanel } from "./SystemMonitorPanel";

// Add to SERVICE_PANELS array:
{
    serviceId: "system-monitor",
    label: "System",
    icon: <Activity className="size-3.5" />,
    component: SystemMonitorPanel as React.ComponentType<{ sessionId: string }>,
}
```

### How it works

- Uses `useServiceChannel("system-monitor")` to subscribe to stats updates
- The runner service pushes CPU load, memory, and disk stats at a configurable interval
- Renders gauge bars with color-coded thresholds (green → amber → red)
