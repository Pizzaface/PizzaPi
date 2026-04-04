package tools

import (
	"errors"
	"fmt"
	"os"
	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/pathutil"
	"path/filepath"
	"strings"
)

// EditOpts controls path confinement for EditFile and EditFileMulti.
type EditOpts struct {
	// CWD is the working directory used to resolve relative paths.
	// Ignored when path is absolute. Required if path is relative and
	// AllowedRoots is non-empty.
	CWD string
	// AllowedRoots restricts which directories may be edited.
	// When non-empty, the resolved canonical path must fall within at least
	// one of these directories; otherwise the operation returns an error.
	// If empty, no path confinement is applied.
	AllowedRoots []string
}

// SingleEdit represents one oldText→newText replacement.
type SingleEdit struct {
	OldText string
	NewText string
}

// EditFile replaces a single occurrence of oldText with newText in the file at path.
// It returns a diff string showing the change, or an error if:
//   - the file is not found
//   - oldText is empty
//   - oldText is not found in the file
//   - oldText appears more than once (ambiguous match)
//   - the replacement produces no change (oldText == newText in effect)
func EditFile(path, oldText, newText string, opts EditOpts) (string, error) {
	return EditFileMulti(path, []SingleEdit{{OldText: oldText, NewText: newText}}, opts)
}

// EditFileMulti applies multiple non-overlapping edits to the file at path
// simultaneously. All edits are matched against the original file content (not
// applied incrementally). Edits are sorted by match position and applied in
// reverse order so byte offsets remain stable.
//
// Returns a combined diff string showing all changes, or an error if any edit
// is invalid (not found, ambiguous, overlapping, or produces no change).
func EditFileMulti(path string, edits []SingleEdit, opts EditOpts) (string, error) {
	if len(edits) == 0 {
		return "", fmt.Errorf("edits must contain at least one replacement")
	}

	// Resolve path and enforce confinement.
	resolvedPath := path
	if len(opts.AllowedRoots) > 0 {
		var err error
		resolvedPath, err = pathutil.ResolvePath(path, opts.CWD)
		if err != nil {
			return "", err
		}
		if err := pathutil.ValidatePathWithinRoots(resolvedPath, opts.AllowedRoots); err != nil {
			return "", err
		}
	} else if !filepath.IsAbs(path) && opts.CWD != "" {
		resolvedPath = filepath.Join(opts.CWD, path)
	}

	// Read the file.
	rawBytes, err := os.ReadFile(resolvedPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("file not found: %s", path)
		}
		return "", fmt.Errorf("reading file %s: %w", path, err)
	}
	rawContent := string(rawBytes)

	// Strip UTF-8 BOM before matching (models won't include invisible BOM in
	// oldText). We restore it on write.
	bom, content := stripBOM(rawContent)

	// Detect line endings and normalise to LF for matching. We restore the
	// original line endings on write.
	originalEnding := detectLineEnding(content)
	normalizedContent := normalizeToLF(content)

	// Apply all edits atomically against the original normalised content.
	baseContent, newContent, err := applyEditsToContent(normalizedContent, edits, path)
	if err != nil {
		return "", err
	}

	// Restore line endings and prepend BOM, then write.
	finalContent := bom + restoreLineEndings(newContent, originalEnding)

	// Preserve the original file's permission bits (P2 fix). Fall back to 0644
	// for new files, though EditFileMulti always requires the file to exist.
	fileMode := os.FileMode(0644)
	if fi, statErr := os.Stat(resolvedPath); statErr == nil {
		fileMode = fi.Mode()
	}
	if err := os.WriteFile(resolvedPath, []byte(finalContent), fileMode); err != nil {
		return "", fmt.Errorf("writing file %s: %w", path, err)
	}

	return generateDiffString(baseContent, newContent, 4), nil
}

// ---------------------------------------------------------------------------
// BOM handling
// ---------------------------------------------------------------------------

func stripBOM(s string) (bom, text string) {
	const bomRune = "\uFEFF"
	if strings.HasPrefix(s, bomRune) {
		return bomRune, s[len(bomRune):]
	}
	return "", s
}

// ---------------------------------------------------------------------------
// Line-ending handling
// ---------------------------------------------------------------------------

func detectLineEnding(content string) string {
	crlfIdx := strings.Index(content, "\r\n")
	lfIdx := strings.Index(content, "\n")
	if lfIdx == -1 {
		return "\n"
	}
	if crlfIdx == -1 {
		return "\n"
	}
	if crlfIdx < lfIdx {
		return "\r\n"
	}
	return "\n"
}

func normalizeToLF(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text
}

func restoreLineEndings(text, ending string) string {
	if ending == "\r\n" {
		return strings.ReplaceAll(text, "\n", "\r\n")
	}
	return text
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

// normFuzzyRune returns the rune that normalizeForFuzzyMatch would map r to.
// Each input rune maps to exactly one output rune (never removed, never split).
func normFuzzyRune(r rune) rune {
	switch {
	case r == '\u2018' || r == '\u2019' || r == '\u201A' || r == '\u201B':
		return '\''
	case r == '\u201C' || r == '\u201D' || r == '\u201E' || r == '\u201F':
		return '"'
	case r == '\u2010' || r == '\u2011' || r == '\u2012' || r == '\u2013' ||
		r == '\u2014' || r == '\u2015' || r == '\u2212':
		return '-'
	case r == '\u00A0' || r == '\u202F' || r == '\u205F' || r == '\u3000':
		return ' '
	case r >= '\u2002' && r <= '\u200A':
		return ' '
	}
	return r
}

// buildFuzzyMapping applies the same transformations as normalizeForFuzzyMatch
// and simultaneously builds a mapping from each fuzzy byte position back to the
// corresponding byte position in the original (normalizedContent) string.
//
// fuzzyToNorm has len(fuzzyContent)+1 entries. The sentinel entry at index
// len(fuzzyContent) equals len(normalizedContent), so you can safely look up
// the normalizedContent end position for any match that reaches the end of fuzzy.
//
// When a fuzzy match spans [fuzzyIdx, fuzzyEnd), the corresponding range in
// normalizedContent is [fuzzyToNorm[fuzzyIdx], fuzzyToNorm[fuzzyEnd]).
func buildFuzzyMapping(normalizedContent string) (fuzzyContent string, fuzzyToNorm []int) {
	var b strings.Builder
	b.Grow(len(normalizedContent))
	fuzzyToNorm = make([]int, 0, len(normalizedContent)+1)

	lines := strings.Split(normalizedContent, "\n")
	lineStartInNorm := 0

	for lineIdx, line := range lines {
		trimmed := strings.TrimRight(line, " \t\r")
		trimmedLen := len(trimmed) // byte length of the kept prefix

		// Iterate rune-by-rune; the range index i is the byte offset of the rune
		// within line.
		for runeByteStart, r := range line {
			if runeByteStart < trimmedLen {
				// Rune is in the non-trailing-whitespace region — include in fuzzy.
				transformed := normFuzzyRune(r)
				start := b.Len()
				b.WriteRune(transformed)
				end := b.Len()
				// Map every byte of the output rune to the start of the original rune.
				absNormPos := lineStartInNorm + runeByteStart
				for j := start; j < end; j++ {
					fuzzyToNorm = append(fuzzyToNorm, absNormPos)
				}
			}
			// else: trailing whitespace — omitted from fuzzy, no mapping entry.
		}

		// Advance past the line's bytes.
		lineStartInNorm += len(line)

		if lineIdx < len(lines)-1 {
			// Record the '\n' separator that strings.Split consumed.
			fuzzyToNorm = append(fuzzyToNorm, lineStartInNorm)
			b.WriteByte('\n')
			lineStartInNorm++ // '\n' is one byte
		}
	}

	// Sentinel: maps the past-the-end position of fuzzy to that of normalized.
	fuzzyToNorm = append(fuzzyToNorm, lineStartInNorm)

	return b.String(), fuzzyToNorm
}

// normalizeForFuzzyMatch applies progressive transformations to normalise text
// for fuzzy matching. This mirrors the JS reference implementation.
//
// Note: Unlike the JS reference (which also applies NFKC Unicode normalisation),
// this implementation does not apply NFKC because that would require the
// golang.org/x/text package. The remaining transformations cover the vast
// majority of practical fuzzy-match cases.
func normalizeForFuzzyMatch(text string) string {
	// Strip trailing whitespace from each line.
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t\r")
	}
	text = strings.Join(lines, "\n")

	// Smart single quotes → ASCII apostrophe.
	text = replaceRunes(text, "\u2018\u2019\u201A\u201B", '\'')
	// Smart double quotes → ASCII double quote.
	text = replaceRunes(text, "\u201C\u201D\u201E\u201F", '"')
	// Various dashes / hyphens → ASCII hyphen.
	text = replaceRunes(text, "\u2010\u2011\u2012\u2013\u2014\u2015\u2212", '-')
	// Non-standard spaces → regular space (U+0020).
	// U+00A0 NBSP, U+202F narrow NBSP, U+205F medium math space, U+3000 ideographic.
	text = replaceRunes(text, "\u00A0\u202F\u205F\u3000", ' ')
	// U+2002 – U+200A various typographic spaces.
	text = replaceRuneRange(text, '\u2002', '\u200A', ' ')

	return text
}

// replaceRunes replaces every rune in the string `from` with `to`.
func replaceRunes(text, from string, to rune) string {
	var b strings.Builder
	b.Grow(len(text))
	for _, r := range text {
		replaced := false
		for _, f := range from {
			if r == f {
				b.WriteRune(to)
				replaced = true
				break
			}
		}
		if !replaced {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// replaceRuneRange replaces every rune in [lo, hi] (inclusive) with to.
func replaceRuneRange(text string, lo, hi rune, to rune) string {
	var b strings.Builder
	b.Grow(len(text))
	for _, r := range text {
		if r >= lo && r <= hi {
			b.WriteRune(to)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

type findResult struct {
	found     bool
	usedFuzzy bool
}

// fuzzyFindText reports whether oldText can be found in content (exact or
// fuzzy) and whether fuzzy matching was required. It is used solely to
// determine whether fuzzy mode should be activated; actual position resolution
// is handled separately via buildFuzzyMapping.
func fuzzyFindText(content, oldText string) findResult {
	// Exact match.
	if strings.Contains(content, oldText) {
		return findResult{found: true, usedFuzzy: false}
	}
	// Fuzzy fallback.
	fuzzyContent := normalizeForFuzzyMatch(content)
	fuzzyOldText := normalizeForFuzzyMatch(oldText)
	if strings.Contains(fuzzyContent, fuzzyOldText) {
		return findResult{found: true, usedFuzzy: true}
	}
	return findResult{found: false}
}

// countOccurrences counts how many non-overlapping occurrences of oldText
// appear in content (both are fuzzy-normalised before comparison).
func countOccurrences(content, oldText string) int {
	fuzzyContent := normalizeForFuzzyMatch(content)
	fuzzyOldText := normalizeForFuzzyMatch(oldText)
	return strings.Count(fuzzyContent, fuzzyOldText)
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

type matchedEdit struct {
	editIndex   int
	matchIndex  int // byte offset in baseContent
	matchLength int // byte length of the match
	newText     string
}

// applyEditsToContent applies all edits to normalizedContent and returns:
//   - baseContent: normalizedContent (used as the "before" side of the diff)
//   - newContent:  normalizedContent with all replacements applied
//
// Errors are returned for empty oldText, not-found, ambiguous (multi-occurrence),
// overlapping edits, or no-change results.
//
// Fuzzy matching strategy (P1 fix):
//   - Fuzzy matching is used ONLY to locate match positions.
//   - Once a position is found in fuzzy space it is mapped back to normalizedContent
//     byte offsets via buildFuzzyMapping, so the replacement is applied to the
//     ORIGINAL bytes. Characters outside the matched region — including smart
//     quotes, em-dashes, or any other Unicode — are never modified.
func applyEditsToContent(normalizedContent string, edits []SingleEdit, path string) (baseContent, newContent string, err error) {
	// Normalise edit line endings.
	normalised := make([]SingleEdit, len(edits))
	for i, e := range edits {
		normalised[i] = SingleEdit{
			OldText: normalizeToLF(e.OldText),
			NewText: normalizeToLF(e.NewText),
		}
	}

	// Validate: no empty oldText.
	for i, e := range normalised {
		if e.OldText == "" {
			return errEmptyOldText(path, i, len(normalised))
		}
	}

	// baseContent is always the original normalizedContent (for the diff).
	baseContent = normalizedContent

	// Determine if any edit requires fuzzy matching.
	useFuzzy := false
	for _, e := range normalised {
		if r := fuzzyFindText(normalizedContent, e.OldText); r.usedFuzzy {
			useFuzzy = true
			break
		}
	}

	matched := make([]matchedEdit, 0, len(normalised))

	if !useFuzzy {
		// Fast path: all edits can be found via exact string match.
		for i, e := range normalised {
			idx := strings.Index(normalizedContent, e.OldText)
			if idx == -1 {
				_, _, err = errNotFound(path, i, len(normalised))
				return
			}
			occ := strings.Count(normalizedContent, e.OldText)
			if occ > 1 {
				_, _, err = errDuplicate(path, i, len(normalised), occ)
				return
			}
			matched = append(matched, matchedEdit{
				editIndex:   i,
				matchIndex:  idx,
				matchLength: len(e.OldText),
				newText:     e.NewText,
			})
		}
	} else {
		// Fuzzy path: build a position mapping from fuzzy space back to normalizedContent.
		// Replacements are still applied to normalizedContent so non-edited regions
		// are never touched.
		fuzzyContent, fuzzyToNorm := buildFuzzyMapping(normalizedContent)

		for i, e := range normalised {
			fuzzyOldText := normalizeForFuzzyMatch(e.OldText)

			occ := strings.Count(fuzzyContent, fuzzyOldText)
			if occ == 0 {
				_, _, err = errNotFound(path, i, len(normalised))
				return
			}
			if occ > 1 {
				_, _, err = errDuplicate(path, i, len(normalised), occ)
				return
			}

			// Locate the match in fuzzy space, then map to normalizedContent offsets.
			fuzzyIdx := strings.Index(fuzzyContent, fuzzyOldText)
			fuzzyEnd := fuzzyIdx + len(fuzzyOldText)
			normStart := fuzzyToNorm[fuzzyIdx]
			normEnd := fuzzyToNorm[fuzzyEnd]

			matched = append(matched, matchedEdit{
				editIndex:   i,
				matchIndex:  normStart,
				matchLength: normEnd - normStart,
				newText:     e.NewText,
			})
		}
	}

	// Sort by position (ascending) so overlapping check is O(n).
	sortByMatchIndex(matched)

	// Detect overlaps.
	for i := 1; i < len(matched); i++ {
		prev := matched[i-1]
		curr := matched[i]
		if prev.matchIndex+prev.matchLength > curr.matchIndex {
			return "", "", fmt.Errorf(
				"edits[%d] and edits[%d] overlap in %s. Merge them into one edit or target disjoint regions",
				prev.editIndex, curr.editIndex, path,
			)
		}
	}

	// Apply replacements to normalizedContent in reverse order so earlier offsets
	// remain valid after each splice.
	result := normalizedContent
	for i := len(matched) - 1; i >= 0; i-- {
		e := matched[i]
		result = result[:e.matchIndex] + e.newText + result[e.matchIndex+e.matchLength:]
	}

	// Guard: no effective change.
	if result == normalizedContent {
		if len(normalised) == 1 {
			return "", "", fmt.Errorf(
				"no changes made to %s. The replacement produced identical content. "+
					"This might indicate an issue with special characters or the text not existing as expected",
				path,
			)
		}
		return "", "", fmt.Errorf("no changes made to %s. The replacements produced identical content", path)
	}

	return normalizedContent, result, nil
}

func errEmptyOldText(path string, i, total int) (string, string, error) {
	if total == 1 {
		return "", "", fmt.Errorf("oldText must not be empty in %s", path)
	}
	return "", "", fmt.Errorf("edits[%d].oldText must not be empty in %s", i, path)
}

func errNotFound(path string, i, total int) (string, string, error) {
	if total == 1 {
		return "", "", fmt.Errorf(
			"could not find the exact text in %s. "+
				"The old text must match exactly including all whitespace and newlines",
			path,
		)
	}
	return "", "", fmt.Errorf(
		"could not find edits[%d] in %s. "+
			"The oldText must match exactly including all whitespace and newlines",
		i, path,
	)
}

func errDuplicate(path string, i, total, occurrences int) (string, string, error) {
	if total == 1 {
		return "", "", fmt.Errorf(
			"found %d occurrences of the text in %s. "+
				"The text must be unique. Please provide more context to make it unique",
			occurrences, path,
		)
	}
	return "", "", fmt.Errorf(
		"found %d occurrences of edits[%d] in %s. "+
			"Each oldText must be unique. Please provide more context to make it unique",
		occurrences, i, path,
	)
}

// sortByMatchIndex sorts matched edits by matchIndex ascending (insertion sort;
// edits lists are short in practice).
func sortByMatchIndex(edits []matchedEdit) {
	for i := 1; i < len(edits); i++ {
		for j := i; j > 0 && edits[j-1].matchIndex > edits[j].matchIndex; j-- {
			edits[j-1], edits[j] = edits[j], edits[j-1]
		}
	}
}

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------

type diffPart struct {
	Value   string
	Added   bool
	Removed bool
}

// diffLinesContent computes a line-level LCS diff between oldContent and
// newContent (both LF-normalised). Returns a slice of diffPart values where
// consecutive lines of the same type are merged into one part.
//
// This uses a classic O(m*n) DP table suitable for typical code file sizes
// (< a few thousand lines). For very large files the memory usage would be
// proportionally higher.
func diffLinesContent(oldContent, newContent string) []diffPart {
	old := splitIntoLines(oldContent)
	nw := splitIntoLines(newContent)
	m, n := len(old), len(nw)

	// Build LCS table.
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := m - 1; i >= 0; i-- {
		for j := n - 1; j >= 0; j-- {
			if old[i] == nw[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	// Walk the LCS table to generate diff operations.
	var parts []diffPart
	i, j := 0, 0
	for i < m || j < n {
		if i < m && j < n && old[i] == nw[j] {
			appendDiffLine(&parts, old[i], false, false)
			i++
			j++
		} else if i < m && (j >= n || dp[i+1][j] >= dp[i][j+1]) {
			appendDiffLine(&parts, old[i], false, true) // removed
			i++
		} else {
			appendDiffLine(&parts, nw[j], true, false) // added
			j++
		}
	}
	return parts
}

// splitIntoLines splits s into a slice of "lines with newlines" preserving
// the trailing newline character as part of each element.
// e.g. "a\nb\n" → ["a\n", "b\n", ""]
//
//	"a\nb"  → ["a\n", "b"]
//	""      → [""]
func splitIntoLines(s string) []string {
	if s == "" {
		return []string{""}
	}
	var lines []string
	for {
		idx := strings.Index(s, "\n")
		if idx == -1 {
			lines = append(lines, s)
			break
		}
		lines = append(lines, s[:idx+1])
		s = s[idx+1:]
	}
	return lines
}

// appendDiffLine appends line to the last diffPart in parts if it has the same
// Added/Removed flags; otherwise appends a new diffPart.
func appendDiffLine(parts *[]diffPart, line string, added, removed bool) {
	if len(*parts) > 0 {
		last := &(*parts)[len(*parts)-1]
		if last.Added == added && last.Removed == removed {
			last.Value += line
			return
		}
	}
	*parts = append(*parts, diffPart{Value: line, Added: added, Removed: removed})
}

// generateDiffString produces a human-readable diff with contextLines lines of
// surrounding context around each change. The format mirrors the Pi JS edit
// tool's output:
//
//	+  3 added line content
//	-  4 removed line content
//	   5 unchanged context line
//	     ...
func generateDiffString(oldContent, newContent string, contextLines int) string {
	parts := diffLinesContent(oldContent, newContent)
	if len(parts) == 0 {
		return ""
	}

	// Compute the line-number padding width from the maximum line number that
	// will appear in either file.
	oldLineCount := len(strings.Split(oldContent, "\n"))
	newLineCount := len(strings.Split(newContent, "\n"))
	maxLineNum := oldLineCount
	if newLineCount > maxLineNum {
		maxLineNum = newLineCount
	}
	lineNumWidth := len(fmt.Sprintf("%d", maxLineNum))
	spaces := strings.Repeat(" ", lineNumWidth)

	pad := func(n int) string {
		return fmt.Sprintf("%*d", lineNumWidth, n)
	}

	var output []string
	oldLineNum := 1
	newLineNum := 1
	lastWasChange := false

	for i, part := range parts {
		// Split the part's value into individual lines, discarding the trailing
		// empty element that arises from a terminating newline.
		raw := strings.Split(part.Value, "\n")
		if len(raw) > 0 && raw[len(raw)-1] == "" {
			raw = raw[:len(raw)-1]
		}

		if part.Added || part.Removed {
			for _, line := range raw {
				if part.Added {
					output = append(output, fmt.Sprintf("+%s %s", pad(newLineNum), line))
					newLineNum++
				} else {
					output = append(output, fmt.Sprintf("-%s %s", pad(oldLineNum), line))
					oldLineNum++
				}
			}
			lastWasChange = true
		} else {
			nextIsChange := i < len(parts)-1 && (parts[i+1].Added || parts[i+1].Removed)
			hasLeading := lastWasChange   // after a change → trailing context
			hasTrailing := nextIsChange   // before a change → leading context

			switch {
			case hasLeading && hasTrailing:
				// Between two changes: show contextLines on each side.
				if len(raw) <= contextLines*2 {
					for _, line := range raw {
						output = append(output, fmt.Sprintf(" %s %s", pad(oldLineNum), line))
						oldLineNum++
						newLineNum++
					}
				} else {
					leading := raw[:contextLines]
					trailing := raw[len(raw)-contextLines:]
					skipped := len(raw) - len(leading) - len(trailing)
					for _, line := range leading {
						output = append(output, fmt.Sprintf(" %s %s", pad(oldLineNum), line))
						oldLineNum++
						newLineNum++
					}
					output = append(output, fmt.Sprintf(" %s ...", spaces))
					oldLineNum += skipped
					newLineNum += skipped
					for _, line := range trailing {
						output = append(output, fmt.Sprintf(" %s %s", pad(oldLineNum), line))
						oldLineNum++
						newLineNum++
					}
				}
			case hasLeading:
				// Trailing context (after a change): show first contextLines.
				shown := raw
				if len(shown) > contextLines {
					shown = shown[:contextLines]
				}
				skipped := len(raw) - len(shown)
				for _, line := range shown {
					output = append(output, fmt.Sprintf(" %s %s", pad(oldLineNum), line))
					oldLineNum++
					newLineNum++
				}
				if skipped > 0 {
					output = append(output, fmt.Sprintf(" %s ...", spaces))
					oldLineNum += skipped
					newLineNum += skipped
				}
			case hasTrailing:
				// Leading context (before a change): show last contextLines.
				skipped := len(raw) - contextLines
				if skipped < 0 {
					skipped = 0
				}
				if skipped > 0 {
					output = append(output, fmt.Sprintf(" %s ...", spaces))
					oldLineNum += skipped
					newLineNum += skipped
				}
				for _, line := range raw[skipped:] {
					output = append(output, fmt.Sprintf(" %s %s", pad(oldLineNum), line))
					oldLineNum++
					newLineNum++
				}
			default:
				// No adjacent changes: skip entirely.
				oldLineNum += len(raw)
				newLineNum += len(raw)
			}
			lastWasChange = false
		}
	}

	return strings.Join(output, "\n")
}
