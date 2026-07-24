package claude

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"pican/internal/projections"
)

const maxTranscriptLineBytes = 256 << 20

var ErrNoTranscriptRecords = errors.New("Claude transcript has no complete records")

type nativeMessage struct {
	ID      string          `json:"id"`
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   json.RawMessage `json:"usage"`
}

type record struct {
	Type       string
	UUID       string
	ParentUUID string
	SessionID  string
	CWD        string
	Timestamp  string
	Message    *nativeMessage
	Raw        json.RawMessage
	Line       int
	Identity   string
}

// Transcript is one native-file snapshot. Stable says the captured prefix was
// newline-complete and unchanged while read. Complete additionally requires
// every captured record and invariant to decode cleanly. A stable-but-partial
// valid prefix remains materializable without authorizing catalog pruning.
type Transcript struct {
	NativeID       string
	CWD            string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	Title          string
	Preview        string
	Model          string
	ClaudeVersion  string
	Mode           string
	PermissionMode string
	SourcePath     string
	Records        []record
	Complete       bool
	Stable         bool
	MalformedLines []int
	IncompleteTail bool
	ScanError      string
}

// ParseTranscript consumes only newline-terminated records from a stable file
// descriptor snapshot. It never opens the native path for writing.
func ParseTranscript(path string) (Transcript, error) {
	return parseTranscript(path, nil)
}

func parseTranscript(path string, afterSnapshot func()) (Transcript, error) {
	nativeID, err := nativeIDFromPath(path)
	if err != nil {
		return Transcript{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Transcript{}, err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return Transcript{}, err
	}
	if afterSnapshot != nil {
		afterSnapshot()
	}

	transcript := Transcript{NativeID: nativeID, SourcePath: path, Complete: true, Stable: true}
	if before.Size() > 0 {
		var last [1]byte
		if _, err := f.ReadAt(last[:], before.Size()-1); err != nil {
			return Transcript{}, err
		}
		transcript.IncompleteTail = last[0] != '\n'
		transcript.Complete = !transcript.IncompleteTail
		transcript.Stable = !transcript.IncompleteTail
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return Transcript{}, err
	}

	scanner := bufio.NewScanner(io.LimitReader(f, before.Size()))
	scanner.Split(scanCompleteLines)
	scanner.Buffer(make([]byte, 64<<10), maxTranscriptLineBytes)
	identityCounts := map[string]int{}
	validRecords := 0
	line := 0
	var customTitle, aiTitle string
	for scanner.Scan() {
		line++
		rawLine := bytes.TrimSpace(scanner.Bytes())
		if len(rawLine) == 0 {
			continue
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(rawLine, &raw); err != nil || raw == nil {
			transcript.Complete = false
			transcript.MalformedLines = append(transcript.MalformedLines, line)
			continue
		}
		rec := record{Raw: append(json.RawMessage(nil), rawLine...), Line: line}
		decodeString(raw["type"], &rec.Type)
		decodeString(raw["uuid"], &rec.UUID)
		decodeString(raw["parentUuid"], &rec.ParentUUID)
		decodeString(raw["sessionId"], &rec.SessionID)
		decodeString(raw["cwd"], &rec.CWD)
		decodeString(raw["timestamp"], &rec.Timestamp)
		if rec.Type == "" {
			rec.Type = "unknown"
			transcript.Complete = false
		}
		if rec.SessionID != "" && rec.SessionID != nativeID {
			transcript.Complete = false
			transcript.MalformedLines = append(transcript.MalformedLines, line)
			continue
		}
		if rec.Type == "user" || rec.Type == "assistant" {
			if rec.SessionID == "" {
				transcript.Complete = false
			}
			var message nativeMessage
			if err := json.Unmarshal(raw["message"], &message); err == nil {
				rec.Message = &message
			} else {
				transcript.Complete = false
			}
		}
		identity := rec.UUID
		if identity == "" {
			identity = fmt.Sprintf("raw:%x", stableDigest(rec.Raw))
		}
		identityCounts[identity]++
		rec.Identity = fmt.Sprintf("%s:%d", identity, identityCounts[identity])
		if identityCounts[identity] > 1 && rec.UUID != "" {
			transcript.Complete = false
		}

		if rec.CWD != "" {
			if filepath.IsAbs(rec.CWD) {
				cwd := projections.CanonicalCWD(rec.CWD)
				if transcript.CWD == "" {
					transcript.CWD = cwd
				} else if transcript.CWD != cwd {
					// One native session cannot safely move between unrelated cwd
					// values inside a single transcript snapshot. Keep the first
					// validated cwd and prohibit pruning from this partial parse.
					transcript.Complete = false
					transcript.MalformedLines = append(transcript.MalformedLines, line)
				}
			} else {
				transcript.Complete = false
			}
		}
		if rec.Timestamp != "" {
			if timestamp, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
				if transcript.CreatedAt.IsZero() || timestamp.Before(transcript.CreatedAt) {
					transcript.CreatedAt = timestamp
				}
				if transcript.UpdatedAt.IsZero() || timestamp.After(transcript.UpdatedAt) {
					transcript.UpdatedAt = timestamp
				}
			} else {
				transcript.Complete = false
			}
		}
		if rec.Message != nil {
			if rec.Type == "user" && transcript.Preview == "" {
				transcript.Preview = firstText(rec.Message.Content)
			}
			if rec.Type == "assistant" && rec.Message.Model != "" {
				transcript.Model = rec.Message.Model
			}
		}
		switch rec.Type {
		case "custom-title":
			decodeString(raw["customTitle"], &customTitle)
		case "ai-title":
			decodeString(raw["aiTitle"], &aiTitle)
		case "mode":
			decodeString(raw["mode"], &transcript.Mode)
		case "permission-mode":
			decodeString(raw["permissionMode"], &transcript.PermissionMode)
		}
		var version string
		decodeString(raw["version"], &version)
		if version != "" {
			transcript.ClaudeVersion = version
		}
		transcript.Records = append(transcript.Records, rec)
		validRecords++
	}
	if err := scanner.Err(); err != nil {
		transcript.Complete = false
		transcript.Stable = false
		transcript.ScanError = err.Error()
	}
	after, statErr := os.Stat(path)
	if statErr != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) || !os.SameFile(before, after) {
		transcript.Complete = false
		transcript.Stable = false
	}
	if validRecords == 0 {
		return transcript, ErrNoTranscriptRecords
	}
	if transcript.CWD == "" {
		transcript.CWD = inferCWD(filepath.Base(filepath.Dir(path)))
	}
	if transcript.CWD == "" {
		transcript.Complete = false
		return transcript, errors.New("Claude transcript has no working directory")
	}
	if transcript.CreatedAt.IsZero() {
		transcript.CreatedAt = before.ModTime().UTC()
	}
	if transcript.UpdatedAt.IsZero() {
		transcript.UpdatedAt = transcript.CreatedAt
	}
	customTitle = strings.TrimSpace(customTitle)
	aiTitle = strings.TrimSpace(aiTitle)
	switch {
	case customTitle != "":
		transcript.Title = customTitle
	case aiTitle != "":
		transcript.Title = aiTitle
	default:
		transcript.Title = strings.TrimSpace(transcript.Preview)
	}
	return transcript, nil
}

func scanCompleteLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if index := bytes.IndexByte(data, '\n'); index >= 0 {
		line := data[:index]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		return index + 1, line, nil
	}
	if atEOF {
		// A native writer may be in the middle of appending. Leave the tail for
		// the next debounced/periodic snapshot rather than decoding it early.
		return len(data), nil, nil
	}
	return 0, nil, nil
}

func nativeIDFromPath(path string) (string, error) {
	if filepath.Ext(path) != ".jsonl" {
		return "", errors.New("Claude transcript must be a JSONL file")
	}
	value := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	parsed, err := uuid.Parse(value)
	if err != nil || parsed.String() != strings.ToLower(value) {
		return "", fmt.Errorf("invalid Claude transcript session id %q", value)
	}
	return parsed.String(), nil
}

func inferCWD(encodedProject string) string {
	if encodedProject == "" || encodedProject == "." || encodedProject == ".." {
		return ""
	}
	if strings.HasPrefix(encodedProject, "-") {
		path := strings.ReplaceAll(encodedProject, "-", string(filepath.Separator))
		if filepath.IsAbs(path) {
			return projections.CanonicalCWD(path)
		}
	}
	return ""
}

func decodeString(raw json.RawMessage, target *string) {
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, target)
	}
}

func firstText(content json.RawMessage) string {
	var text string
	if json.Unmarshal(content, &text) == nil {
		return strings.TrimSpace(text)
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var out strings.Builder
	for _, block := range blocks {
		var kind, value string
		decodeString(block["type"], &kind)
		decodeString(block["text"], &value)
		if kind == "text" && value != "" {
			out.WriteString(value)
		}
	}
	return strings.TrimSpace(out.String())
}
