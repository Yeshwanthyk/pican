package ui

import "pican/internal/basepath"

var liveBasePath basepath.Path

// SetBasePath configures the live app's mount prefix. Static export rendering
// does not consume this value.
func SetBasePath(raw string) error {
	p, err := basepath.Parse(raw)
	if err != nil {
		return err
	}
	liveBasePath = p
	return nil
}

func liveURL(route string) string {
	return liveBasePath.URL(route)
}
