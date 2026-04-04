package tools_test

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

func TestReadFile_Basic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	content := "line1\nline2\nline3\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != content {
		t.Errorf("expected %q, got %q", content, result.Content)
	}
	if result.TotalLines != 3 {
		t.Errorf("expected 3 lines, got %d", result.TotalLines)
	}
	if result.Truncated {
		t.Error("expected not truncated")
	}
	if result.IsImage {
		t.Error("expected not image")
	}
}

func TestReadFile_WithOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	content := "line1\nline2\nline3\nline4\nline5\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{Offset: 3})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(result.Content, "line3\n") {
		t.Errorf("expected content starting with line3, got %q", result.Content)
	}
	if result.TotalLines != 5 {
		t.Errorf("expected 5 total lines, got %d", result.TotalLines)
	}
}

func TestReadFile_WithLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	content := "line1\nline2\nline3\nline4\nline5\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{Limit: 2})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	lines := strings.Split(strings.TrimRight(result.Content, "\n"), "\n")
	if len(lines) != 2 {
		t.Errorf("expected 2 lines, got %d: %v", len(lines), lines)
	}
	if result.Truncated {
		t.Error("expected not truncated (limit == returned lines is not truncated)")
	}
}

func TestReadFile_OffsetAndLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	var sb strings.Builder
	for i := 1; i <= 10; i++ {
		fmt.Fprintf(&sb, "line%d\n", i)
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{Offset: 3, Limit: 3})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := "line3\nline4\nline5\n"
	if result.Content != expected {
		t.Errorf("expected %q, got %q", expected, result.Content)
	}
}

func TestReadFile_TruncationAtLineLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")
	var sb strings.Builder
	for i := 1; i <= 2500; i++ {
		fmt.Fprintf(&sb, "line%d\n", i)
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Truncated {
		t.Error("expected truncated")
	}
	lines := strings.Split(strings.TrimRight(result.Content, "\n"), "\n")
	if len(lines) > 2000 {
		t.Errorf("expected at most 2000 lines, got %d", len(lines))
	}
	if result.TotalLines != 2500 {
		t.Errorf("expected 2500 total lines, got %d", result.TotalLines)
	}
}

func TestReadFile_TruncationAtByteLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")
	// Each line: "AAAAAAAAA...\n" = 101 bytes. 600 lines = 60600 bytes > 50KB
	line := strings.Repeat("A", 100) + "\n"
	var sb strings.Builder
	for i := 0; i < 600; i++ {
		sb.WriteString(line)
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Truncated {
		t.Error("expected truncated due to byte limit")
	}
	if len(result.Content) > 50*1024 {
		t.Errorf("expected content <= 50KB, got %d bytes", len(result.Content))
	}
}

func TestReadFile_ImageFile(t *testing.T) {
	dir := t.TempDir()
	// Minimal 1x1 PNG bytes
	pngData := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
		0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
		0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
		0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
		0x44, 0xAE, 0x42, 0x60, 0x82,
	}
	path := filepath.Join(dir, "image.png")
	if err := os.WriteFile(path, pngData, 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsImage {
		t.Error("expected IsImage = true for .png file")
	}
	if result.MimeType != "image/png" {
		t.Errorf("expected image/png, got %s", result.MimeType)
	}
	// Content should be valid base64 of the original data
	decoded, err := base64.StdEncoding.DecodeString(result.Content)
	if err != nil {
		t.Fatalf("content is not valid base64: %v", err)
	}
	if string(decoded) != string(pngData) {
		t.Error("decoded base64 does not match original data")
	}
}

func TestReadFile_NotFound(t *testing.T) {
	_, err := tools.ReadFile("/nonexistent/path/file.txt", tools.ReadOpts{})
	if err == nil {
		t.Error("expected error for non-existent file")
	}
}

func TestReadFile_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(path, []byte{}, 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(path, tools.ReadOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "" {
		t.Errorf("expected empty content, got %q", result.Content)
	}
	if result.TotalLines != 0 {
		t.Errorf("expected 0 total lines, got %d", result.TotalLines)
	}
	if result.Truncated {
		t.Error("expected not truncated")
	}
}

func TestReadFile_ImageTypes(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		ext      string
		mimeType string
	}{
		{".jpg", "image/jpeg"},
		{".jpeg", "image/jpeg"},
		{".png", "image/png"},
		{".gif", "image/gif"},
		{".webp", "image/webp"},
	}
	for _, tc := range cases {
		path := filepath.Join(dir, "img"+tc.ext)
		if err := os.WriteFile(path, []byte("fake image data"), 0644); err != nil {
			t.Fatal(err)
		}
		result, err := tools.ReadFile(path, tools.ReadOpts{})
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.ext, err)
		}
		if !result.IsImage {
			t.Errorf("%s: expected IsImage = true", tc.ext)
		}
		if result.MimeType != tc.mimeType {
			t.Errorf("%s: expected %s, got %s", tc.ext, tc.mimeType, result.MimeType)
		}
	}
}
