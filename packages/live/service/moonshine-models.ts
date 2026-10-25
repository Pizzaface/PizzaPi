/**
 * Moonshine model files: the manifest comes from the pinned WASM module's own
 * C ABI (`sttDependencies`), files come from the official CDN, and every file
 * is checked against the manifest's size and CRC32C before it is used.
 */
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ManifestFile {
    name: string;
    url?: string;
    size?: number;
    checksum?: string;
    checksum_type?: string;
}
export interface Manifest {
    groups: { base_url: string; files: ManifestFile[] }[];
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

/** Incremental CRC32C (Castagnoli). Start with 0, feed chunks, compare the result. */
export function crc32c(buf: Uint8Array, crc = 0): number {
    let c = ~crc >>> 0;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return ~c >>> 0;
}

/** The manifest encodes CRC32C as base64 of the big-endian 32-bit value. */
export function crc32cBase64(crc: number): string {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(crc >>> 0);
    return b.toString("base64");
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Local directory for a manifest group, e.g. `<root>/small-streaming-en/quantized_26_07_30`. */
export function groupDir(root: string, baseUrl: string): string {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") throw new Error(`refusing non-https model URL ${baseUrl}`);
    const parts = u.pathname.split("/").filter(Boolean).slice(-2);
    if (parts.length !== 2 || !parts.every((p) => SAFE_SEGMENT.test(p) && p !== "." && p !== "..")) {
        throw new Error(`unexpected model URL ${baseUrl}`);
    }
    return join(root, ...parts);
}

function fileCrc(path: string): number {
    const fd = openSync(path, "r");
    try {
        const buf = new Uint8Array(1 << 20);
        let crc = 0;
        for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) crc = crc32c(buf.subarray(0, n), crc);
        return crc;
    } finally {
        closeSync(fd);
    }
}

/** A cached file is usable only if it matches the manifest's size and checksum exactly. */
export function verifyFile(path: string, f: ManifestFile): boolean {
    if (!existsSync(path)) return false;
    if (typeof f.size === "number" && statSync(path).size !== f.size) return false;
    if (f.checksum && f.checksum_type === "crc32c" && crc32cBase64(fileCrc(path)) !== f.checksum) return false;
    return true;
}

function assertSafeName(name: string) {
    if (!SAFE_SEGMENT.test(name) || name === "." || name === "..") throw new Error(`unexpected model file name ${name}`);
}

/**
 * Download to a temp file, verify size and CRC32C, then rename into place.
 * A partial or corrupt download never sits at the final path.
 */
export async function downloadFile(
    url: string,
    dest: string,
    f: ManifestFile,
    onProgress: (pct: number) => void,
    fetcher: typeof fetch = fetch,
): Promise<void> {
    const tmp = `${dest}.part-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        const res = await fetcher(url);
        if (!res.ok || !res.body) throw new Error(`download ${f.name}: HTTP ${res.status}`);
        const total = f.size ?? Number(res.headers.get("content-length") ?? 0);
        const out = createWriteStream(tmp);
        let writeError: Error | null = null;
        const done = new Promise<void>((resolve, reject) => {
            out.on("finish", resolve);
            out.on("error", (e) => { writeError = e; reject(e); });
        });
        done.catch(() => {});
        let crc = 0;
        let got = 0;
        try {
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                crc = crc32c(chunk, crc);
                got += chunk.length;
                if (typeof f.size === "number" && got > f.size) throw new Error(`download ${f.name}: larger than ${f.size} bytes`);
                if (writeError) throw writeError;
                // Wait for drain, but a failed stream (e.g. disk full) never drains.
                if (!out.write(chunk)) await Promise.race([new Promise((r) => out.once("drain", r)), done]);
                if (writeError) throw writeError;
                if (total) onProgress(Math.min(100, (got / total) * 100));
            }
        } finally {
            if (writeError) out.destroy();
            else out.end();
            await done;
        }
        if (typeof f.size === "number" && got !== f.size) throw new Error(`download ${f.name}: got ${got} of ${f.size} bytes`);
        if (f.checksum && f.checksum_type === "crc32c" && crc32cBase64(crc) !== f.checksum) {
            throw new Error(`download ${f.name}: checksum mismatch`);
        }
        renameSync(tmp, dest);
    } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Remove temp files left by a downloader that was killed (idle unload, crash, runner exit). */
export function sweepPartials(dir: string, isAlive: (pid: number) => boolean = alive): void {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const n of names) {
        const pid = Number(n.match(/\.part-(\d+)-[a-z0-9]+$/)?.[1]);
        if (pid && pid !== process.pid && !isAlive(pid)) rmSync(join(dir, n), { force: true });
    }
}

/** Ensure every manifest file is present and verified; returns name → local path. */
export async function ensureModelFiles(
    manifest: Manifest,
    root: string,
    onProgress: (file: string, pct: number) => void = () => {},
    fetcher: typeof fetch = fetch,
): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    for (const group of manifest.groups ?? []) {
        const dir = groupDir(root, group.base_url);
        mkdirSync(dir, { recursive: true });
        sweepPartials(dir);
        for (const f of group.files) {
            assertSafeName(f.name);
            const dest = join(dir, f.name);
            if (!verifyFile(dest, f)) {
                rmSync(dest, { force: true });
                const url = f.url ?? `${group.base_url.replace(/\/$/, "")}/${f.name}`;
                if (!url.startsWith("https://")) throw new Error(`refusing non-https model URL ${url}`);
                await downloadFile(url, dest, f, (pct) => onProgress(f.name, pct), fetcher);
                onProgress(f.name, 100);
            }
            paths.set(f.name, dest);
        }
    }
    return paths;
}
