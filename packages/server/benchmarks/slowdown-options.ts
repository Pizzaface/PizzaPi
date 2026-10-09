import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export type SlowdownBenchmarkOptions = {
  histories: number[];
  mediaKb: number[];
  burstRunners: number;
  burstSessions: number;
  soakMs: number;
  outDir: string;
  buildUi: boolean;
  uiDir: string;
  headless: boolean;
};

export function parseSlowdownArgs(argv: string[]): SlowdownBenchmarkOptions {
  const flag = (name: string) => argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const value = (name: string, fallback: string) => {
    const hit = flag(name);
    if (!hit) return fallback;
    if (hit === `--${name}`) return "1";
    return hit.slice(name.length + 3);
  };
  const ints = (name: string, fallback: string) => value(name, fallback)
    .split(",")
    .map((v) => Number.parseInt(v, 10))
    .filter(Number.isFinite);
  return {
    histories: ints("histories", "125,500,2000"),
    mediaKb: ints("media-kb", "65,1024,4096"),
    burstRunners: Number.parseInt(value("burst-runners", "10"), 10),
    burstSessions: Number.parseInt(value("burst-sessions", "20"), 10),
    soakMs: Number.parseInt(value("soak-ms", "300000"), 10),
    outDir: resolve(value("out", join(tmpdir(), `pizzapi-slowdown-${Date.now()}`))),
    buildUi: argv.includes("--build-ui"),
    uiDir: resolve(value("ui-dir", "packages/ui/dist")),
    headless: !argv.includes("--headed"),
  };
}

export function renderReport(result: any): string {
  return `# Session UI slowdown benchmark results\n\n- Run: ${result.at}\n- Production UI: ${result.uiDir}\n- Histories: ${result.histories.join(", ")} messages\n- Media: ${result.mediaKb.length ? result.mediaKb.join(", ") + " KB PNG markdown data URLs" : "none"}\n\n## Measurements\n\n| Metric | Value |\n| --- | ---: |\n| Switch median | ${result.switchMs.median} ms |\n| Switch p95 | ${result.switchMs.p95} ms |\n| Switch max | ${result.switchMs.max} ms |\n| Burst sessions emitted | ${result.burst.emitted}/${result.burst.sessions} |\n| Soak events | ${result.soak.events} |\n| Max long task | ${result.longTasks.maxMs} ms |\n\nRaw JSON: \`slowdown-results.json\`.\n`;
}
