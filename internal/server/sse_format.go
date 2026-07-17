package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func formatSSEJSONEvent(name string, payload any) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", errors.New("sse event name required")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("event: %s\ndata: %s", name, data), nil
}
