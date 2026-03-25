import { useState, useEffect } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { Cpu, MemoryStick, HardDrive } from "lucide-react";

interface CpuStats {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    cores: number;
}

interface MemStats {
    totalMb: number;
    usedMb: number;
    freeMb: number;
    usedPct: number;
}

interface DiskStats {
    path: string;
    totalGb: number;
    usedGb: number;
    availableGb: number;
    usedPct: number;
}

interface SystemStats {
    timestamp: number;
    cpu: CpuStats;
    mem: MemStats;
    disk: DiskStats | null;
}

// ── Mini gauge bar ────────────────────────────────────────────────────────────

function GaugeBar({ pct, warn = 70, crit = 90 }: { pct: number; warn?: number; crit?: number }) {
    const color =
        pct >= crit ? "bg-red-400" :
        pct >= warn ? "bg-amber-400" :
        "bg-[#6ee7b7]";
    return (
        <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
            <div
                className={`h-full rounded-full transition-all duration-500 ${color}`}
                style={{ width: `${Math.min(100, pct)}%` }}
            />
        </div>
    );
}

// ── Stat row ──────────────────────────────────────────────────────────────────

function StatRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-xs font-mono tabular-nums text-foreground">
                {value}
                {sub && <span className="text-muted-foreground ml-1">{sub}</span>}
            </span>
        </div>
    );
}

// ── Section card ──────────────────────────────────────────────────────────────

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-md border border-white/10 bg-white/5 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-[#e8b4f8]">
                {icon}
                {title}
            </div>
            {children}
        </div>
    );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function SystemMonitorPanel() {
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [age, setAge] = useState(0);

    const { send, available } = useServiceChannel<unknown, SystemStats>("system-monitor", {
        onMessage: (type, payload) => {
            if (type === "stats") {
                setStats(payload);
                setAge(0);
            }
        },
    });

    // Subscribe on mount
    useEffect(() => {
        if (!available) return;
        send("subscribe", { interval: 3000 });
        return () => send("unsubscribe", {});
    }, [available, send]);

    // Age counter
    useEffect(() => {
        if (!stats) return;
        const id = setInterval(() => setAge(a => a + 1), 1000);
        return () => clearInterval(id);
    }, [stats]);

    if (!available) {
        return (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground p-4 text-center">
                System monitor not available
                <br />
                <span className="opacity-60">Add system-monitor.js to ~/.pizzapi/services/</span>
            </div>
        );
    }

    if (!stats) {
        return (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Loading…
            </div>
        );
    }

    const { cpu, mem, disk } = stats;
    const cpuPct = Math.round(cpu.loadAvg1 * 100);

    return (
        <div className="p-3 space-y-2 overflow-y-auto h-full">

            {/* CPU */}
            <Section icon={<Cpu size={12} />} title="CPU">
                <GaugeBar pct={cpuPct} />
                <StatRow label="Load (1m)" value={`${cpu.loadAvg1.toFixed(2)}`} sub={`/ ${cpu.cores} cores`} />
                <StatRow label="Load (5m)"  value={`${cpu.loadAvg5.toFixed(2)}`} />
                <StatRow label="Load (15m)" value={`${cpu.loadAvg15.toFixed(2)}`} />
            </Section>

            {/* Memory */}
            <Section icon={<MemoryStick size={12} />} title="Memory">
                <GaugeBar pct={mem.usedPct} />
                <StatRow label="Used"  value={`${mem.usedMb.toLocaleString()} MB`} sub={`${mem.usedPct}%`} />
                <StatRow label="Free"  value={`${mem.freeMb.toLocaleString()} MB`} />
                <StatRow label="Total" value={`${mem.totalMb.toLocaleString()} MB`} />
            </Section>

            {/* Disk */}
            {disk && (
                <Section icon={<HardDrive size={12} />} title={`Disk (${disk.path})`}>
                    <GaugeBar pct={disk.usedPct} warn={80} crit={95} />
                    <StatRow label="Used"  value={`${disk.usedGb} GB`} sub={`${disk.usedPct}%`} />
                    <StatRow label="Free"  value={`${disk.availableGb} GB`} />
                    <StatRow label="Total" value={`${disk.totalGb} GB`} />
                </Section>
            )}

            {/* Footer */}
            <div className="text-[10px] text-muted-foreground text-right opacity-50">
                {age === 0 ? "just updated" : `${age}s ago`} · 3s interval
            </div>
        </div>
    );
}
