
## 2025-01-20 - Command Injection Mitigation via `execFileSync` & `spawnSync`
**Vulnerability:** Use of `child_process.execSync` to run shell commands using string interpolation with unsanitized arguments (e.g., `git clone ${REPO_URL}` or `npm install ${versionSpec}`). This allows arbitrary command execution if an attacker manages to manipulate these arguments.
**Learning:** Using `execSync` is inherently risky when incorporating external or dynamically computed variables. Node's `execFileSync` or `spawnSync` are safer as they run the specified executable directly without invoking a subshell. However, on Windows, Node.js cannot execute `.cmd` or `.bat` files (like the globally installed `npm.cmd` or `yarn.cmd`) using `execFileSync` without a shell.
**Prevention:**
To securely avoid shell injection while still maintaining cross-platform functionality for `.cmd` executables, use `spawnSync(cmd, args, { shell: process.platform === 'win32' })`. When `shell: true` is used with an arguments array, Node.js attempts to safely quote and escape the arguments for `cmd.exe`.
