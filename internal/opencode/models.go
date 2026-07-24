package opencode

import (
	"context"
	"sort"
)

// Model is the runtime-neutral shape consumed by pican's model endpoint.
// Provider is always "opencode"; ID and Model retain the native provider as
// part of a composite identifier so two native providers cannot collide.
type Model struct {
	Provider         string             `json:"provider"`
	ID               string             `json:"id"`
	Model            string             `json:"model"`
	Name             string             `json:"name"`
	DisplayName      string             `json:"displayName"`
	Reasoning        bool               `json:"reasoning"`
	ThinkingLevelMap map[string]*string `json:"thinkingLevelMap"`
}

func FetchModels(ctx context.Context, client *Client, directory string) ([]Model, error) {
	response, err := client.Providers(ctx, directory)
	if err != nil {
		return nil, err
	}
	connected := make(map[string]struct{}, len(response.Connected))
	for _, providerID := range response.Connected {
		connected[providerID] = struct{}{}
	}
	var models []Model
	for _, provider := range response.All {
		if _, ok := connected[provider.ID]; !ok {
			continue
		}
		for mapID, native := range provider.Models {
			nativeID := native.ID
			if nativeID == "" {
				nativeID = mapID
			}
			if provider.ID == "" || nativeID == "" {
				continue
			}
			id := ModelID(provider.ID, nativeID)
			name := native.Name
			if name == "" {
				name = id
			}
			models = append(models, Model{
				Provider: Provider, ID: id, Model: id, Name: name,
				DisplayName: name, Reasoning: false,
				ThinkingLevelMap: emptyThinkingLevels(),
			})
		}
	}
	sort.Slice(models, func(i, j int) bool {
		if models[i].DisplayName == models[j].DisplayName {
			return models[i].ID < models[j].ID
		}
		return models[i].DisplayName < models[j].DisplayName
	})
	return models, nil
}

func emptyThinkingLevels() map[string]*string {
	return map[string]*string{
		"off": nil, "minimal": nil, "low": nil,
		"medium": nil, "high": nil, "xhigh": nil,
	}
}
