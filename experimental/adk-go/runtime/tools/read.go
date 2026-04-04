// Package tools provides pure Go implementations of fundamental agent coding tools.
package tools

import (
	"bufio"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxReadLines = 2000
	maxReadBytes = 50 * 1024 // 50KB
)

// ReadOpts controls how ReadFile reads a file.
type ReadOpts struct {
	// Offset is the 1-indexed line number to start reading from.
	// Zero means start from the beginning.
	Offset int
	// Limit is the maximum number of lines to return.
	// Zero means no limit (subject to built-in truncation limits).
	Limit int
}

// ReadResult holds the result of a ReadFile call.
type ReadResult struct {
	// Content is the file content (base64-encoded for images, plain text otherwise).
	Content string
	// TotalLines is the total number of lines in the file (for text files).
	TotalLines int
	// Truncated is true if the output was cut short due to line/byte limits.
	Truncated bool
	// IsImage is true if the file was detected as an image type.
	IsImage bool
	// MimeType is the MIME type for image files (e.g., "image/png").
	MimeType string
}

var imageExts = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
}

// ReadFile reads the file at path and returns its content according to opts.
// For image files (.jpg, .jpeg, .png, .gif, .webp), the content is returned
// as a base64-encoded string with IsImage set to true.
// Text output is truncated at 2000 lines or 50KB, whichever comes first.
func ReadFile(path string, opts ReadOpts) (ReadResult, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if mimeType, ok := imageExts[ext]; ok {
		return readImage(path, mimeType)
	}
	return readText(path, opts)
}

func readImage(path string, mimeType string) (ReadResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ReadResult{}, err
	}
	return ReadResult{
		Content:  base64.StdEncoding.EncodeToString(data),
		IsImage:  true,
		MimeType: mimeType,
	}, nil
}

func readText(path string, opts ReadOpts) (ReadResult, error) {
	f, err := os.Open(path)
	if err != nil {
		return ReadResult{}, err
	}
	defer f.Close()

	// First pass: count total lines
	totalLines := 0
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 10<<20) // raise token limit to 10 MB (default is 64 KB)
	for scanner.Scan() {
		totalLines++
	}
	if err := scanner.Err(); err != nil {
		return ReadResult{}, err
	}

	// Seek back to start for second pass
	if _, err := f.Seek(0, 0); err != nil {
		return ReadResult{}, err
	}

	// Determine read window
	startLine := 1
	if opts.Offset > 0 {
		startLine = opts.Offset
	}

	// userLimit is the caller's requested line cap (0 = no user limit).
	userLimit := opts.Limit

	// Second pass: collect lines in window
	var sb strings.Builder
	scanner = bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 10<<20) // raise token limit to 10 MB (default is 64 KB)
	lineNum := 0
	linesRead := 0
	byteCount := 0
	truncated := false

	for scanner.Scan() {
		lineNum++
		if lineNum < startLine {
			continue
		}

		// Apply user-specified limit first (not a truncation signal).
		if userLimit > 0 && linesRead >= userLimit {
			break
		}

		// Apply internal hard limits (these are truncation signals).
		if linesRead >= maxReadLines {
			truncated = true
			break
		}

		line := scanner.Text() + "\n"
		lineBytes := len(line)

		if byteCount+lineBytes > maxReadBytes {
			truncated = true
			break
		}

		sb.WriteString(line)
		byteCount += lineBytes
		linesRead++
	}
	if err := scanner.Err(); err != nil {
		return ReadResult{}, err
	}

	return ReadResult{
		Content:    sb.String(),
		TotalLines: totalLines,
		Truncated:  truncated,
	}, nil
}
