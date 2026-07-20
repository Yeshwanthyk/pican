package runtimes

import "pican/internal/workers"

const (
	PiID    ID = "pi"
	CodexID ID = "codex"
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
		ModelListing:       true,
		ModelSwitching:     true,
		EffortSelection:    true,
		ReasoningSelection: true,
		SlashCommands:      true,
	}
}
