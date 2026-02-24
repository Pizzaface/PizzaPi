## 2026-02-24 - Path Traversal in Runner CWD
**Vulnerability:** The server allowed `..` path segments in `cwd` parameters, enabling path traversal outside allowed runner roots.
**Learning:** `normalizePath` helper only converted slashes but did not resolve `..` segments, creating a false sense of security.
**Prevention:** Always use `path.resolve` or `path.normalize` (specifically `path.posix.normalize` for consistent server-side handling) to canonicalize paths before validating them against allowlists.
