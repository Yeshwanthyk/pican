package runtimes

import "pican/internal/workers"

const (
	PiID       ID = "pi"
	CodexID    ID = "codex"
	ClaudeID   ID = "claude"
	OpenCodeID ID = "opencode"
)

// BuiltinOptions supplies startup-owned adapters and probed command metadata.
type BuiltinOptions struct {
	Command           string
	Version           string
	AvailabilityProbe AvailabilityProbe
	Catalog           CatalogAdapter
	WorkerFactory     workers.Factory
}

// Pi returns the native append-only Pi registration without starting a worker.
func Pi(options BuiltinOptions) Registration {
	return Registration{
		Descriptor: Descriptor{
			ID:             PiID,
			Label:          "Pi",
			Command:        options.Command,
			Version:        options.Version,
			ProjectionMode: ProjectionAppendOnlyNative,
			Capabilities:   PiCapabilities(),
		},
		AvailabilityProbe: options.AvailabilityProbe,
		WorkerFactory:     options.WorkerFactory,
	}
}

// Codex returns the replaceable-projection Codex registration without
// starting a catalog sync or worker.
func Codex(options BuiltinOptions) Registration {
	return Registration{
		Descriptor: Descriptor{
			ID:             CodexID,
			Label:          "Codex",
			Command:        options.Command,
			Version:        options.Version,
			ProjectionMode: ProjectionReplaceable,
			Capabilities:   CodexCapabilities(),
		},
		AvailabilityProbe: options.AvailabilityProbe,
		Catalog:           options.Catalog,
		WorkerFactory:     options.WorkerFactory,
	}
}

// Claude returns the filesystem-backed catalog plus installed-CLI stream-json
// worker registration. Native transcripts remain authoritative.
func Claude(options BuiltinOptions) Registration {
	return Registration{
		Descriptor: Descriptor{
			ID:             ClaudeID,
			Label:          "Claude",
			Command:        options.Command,
			Version:        options.Version,
			ProjectionMode: ProjectionReplaceable,
			Capabilities:   ClaudeCapabilities(),
		},
		AvailabilityProbe: options.AvailabilityProbe,
		Catalog:           options.Catalog,
		WorkerFactory:     options.WorkerFactory,
	}
}

// OpenCode returns the supervised HTTP/SSE runtime registration. OpenCode's
// native database remains authoritative and pican stores only replaceable
// projections.
func OpenCode(options BuiltinOptions) Registration {
	return Registration{
		Descriptor: Descriptor{
			ID:             OpenCodeID,
			Label:          "OpenCode",
			Command:        options.Command,
			Version:        options.Version,
			ProjectionMode: ProjectionReplaceable,
			Capabilities:   OpenCodeCapabilities(),
		},
		AvailabilityProbe: options.AvailabilityProbe,
		Catalog:           options.Catalog,
		WorkerFactory:     options.WorkerFactory,
	}
}

// PiCapabilities describes the currently observable Pi surface.
func PiCapabilities() Capabilities {
	return Capabilities{
		Create:               true,
		Resume:               true,
		Fork:                 true,
		Clone:                true,
		Rename:               true,
		Chat:                 true,
		Cancel:               true,
		Steer:                true,
		PersistentQueue:      true,
		Images:               true,
		Files:                true,
		ModelListing:         true,
		ModelSwitching:       true,
		ReasoningSelection:   true,
		SlashCommands:        true,
		Subagents:            true,
		InteractiveApprovals: true,
		UserQuestions:        true,
	}
}

// CodexCapabilities describes only behavior implemented by the current
// non-interactive app-server adapter.
func CodexCapabilities() Capabilities {
	return Capabilities{
		Create:             true,
		Resume:             true,
		Fork:               true,
		Clone:              true,
		Rename:             true,
		Archive:            true,
		Unarchive:          true,
		Delete:             true,
		Chat:               true,
		Cancel:             true,
		Steer:              true,
		PersistentQueue:    true,
		Images:             true,
		Files:              true,
		ModelListing:       true,
		ModelSwitching:     true,
		EffortSelection:    true,
		ReasoningSelection: true,
		SlashCommands:      true,
	}
}

func ClaudeCapabilities() Capabilities {
	return Capabilities{
		Create:       true,
		Resume:       true,
		Chat:         true,
		Cancel:       true,
		Images:       true,
		Files:        true,
		ModelListing: true,
	}
}

// OpenCodeCapabilities records only the OpenCode 1.18.4 surfaces exercised by
// the supported HTTP/SSE adapter. In particular, pican does not approximate
// steering, queues, attachments, reasoning controls, approvals, or questions.
func OpenCodeCapabilities() Capabilities {
	return Capabilities{
		Create:         true,
		Resume:         true,
		Fork:           true,
		Clone:          true,
		Rename:         true,
		Delete:         true,
		Chat:           true,
		Cancel:         true,
		ModelListing:   true,
		ModelSwitching: true,
	}
}
