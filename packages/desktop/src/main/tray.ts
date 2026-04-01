// packages/desktop/src/main/tray.ts
import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import log from "./logger.js";

export type ServiceHealth = "healthy" | "degraded" | "error";

export interface TrayStatus {
  server: "starting" | "running" | "error" | "stopped";
  runner: "starting" | "running" | "error" | "stopped";
  redis: "connected" | "disconnected";
}

export class AppTray {
  private tray: Tray;
  private window: BrowserWindow;
  private status: TrayStatus = {
    server: "stopped",
    runner: "stopped",
    redis: "disconnected",
  };

  constructor(window: BrowserWindow) {
    this.window = window;

    const iconPath = join(__dirname, "..", "..", "assets", "tray-default.png");
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    icon.setTemplateImage(true);

    this.tray = new Tray(icon);
    this.tray.setToolTip("PizzaPi");

    this.tray.on("click", () => {
      if (this.window.isVisible()) {
        this.window.hide();
      } else {
        this.window.show();
        this.window.focus();
      }
    });

    this.rebuildMenu();
  }

  updateStatus(status: Partial<TrayStatus>): void {
    Object.assign(this.status, status);
    this.updateIcon();
    this.rebuildMenu();
  }

  private getOverallHealth(): ServiceHealth {
    const { server, runner, redis } = this.status;
    if (server === "error" || redis === "disconnected") return "error";
    if (server === "starting" || runner === "starting") return "degraded";
    if (server === "running" && runner === "running" && redis === "connected") return "healthy";
    return "degraded";
  }

  private updateIcon(): void {
    const health = this.getOverallHealth();
    const iconName =
      health === "error" ? "tray-error.png" :
      health === "degraded" ? "tray-warning.png" :
      "tray-default.png";

    const iconPath = join(__dirname, "..", "..", "assets", iconName);
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    icon.setTemplateImage(true);
    this.tray.setImage(icon);
  }

  private statusIcon(val: string): string {
    if (val === "running" || val === "connected") return "\u2713";
    if (val === "starting") return "\u2026";
    return "\u2715";
  }

  private rebuildMenu(): void {
    const menu = Menu.buildFromTemplate([
      {
        label: this.window.isVisible() ? "Hide Window" : "Show Window",
        click: () => {
          if (this.window.isVisible()) {
            this.window.hide();
          } else {
            this.window.show();
            this.window.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: `Server: localhost ${this.statusIcon(this.status.server)}`,
        enabled: false,
      },
      {
        label: `Runner: ${this.status.runner} ${this.statusIcon(this.status.runner)}`,
        enabled: false,
      },
      {
        label: `Redis: ${this.status.redis} ${this.statusIcon(this.status.redis)}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Quit PizzaPi",
        role: "quit",
      },
    ]);

    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
