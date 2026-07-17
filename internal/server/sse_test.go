package server

import "testing"

func TestAddRemoveClientRemovesStoredClient(t *testing.T) {
	s := &Server{clients: make([]*sseClient, 0)}
	client := s.addClient("a.jsonl")
	if len(s.clients) != 1 {
		t.Fatalf("clients = %d, want 1", len(s.clients))
	}
	s.removeClient(client)
	if len(s.clients) != 0 {
		t.Fatalf("clients = %d, want 0", len(s.clients))
	}
}
