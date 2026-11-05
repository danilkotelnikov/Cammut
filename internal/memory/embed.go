package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Embedder turns texts into vectors. Errors are returned, never logged per call: the caller decides (see rateLimitedLogger).
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Model() string
}

const embedTimeout = 2500 * time.Millisecond

type tei struct {
	base, key, model string
	c                *http.Client
}

// NewTEI returns a client for a text-embeddings-inference server's OpenAI-compatible /v1/embeddings route.
func NewTEI(baseURL, apiKey, model string, client *http.Client) Embedder {
	if client == nil {
		client = &http.Client{}
	}
	return &tei{base: strings.TrimRight(baseURL, "/"), key: apiKey, model: model, c: client}
}

func (t *tei) Model() string { return t.model }

func (t *tei) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, embedTimeout)
	defer cancel()
	body, _ := json.Marshal(struct {
		Input []string `json:"input"`
		Model string   `json:"model"`
	}{texts, t.model})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+"/v1/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if t.key != "" {
		req.Header.Set("Authorization", "Bearer "+t.key)
	}
	resp, err := t.c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("embeddings: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("embeddings: %w", err)
	}
	if len(out.Data) != len(texts) {
		return nil, fmt.Errorf("embeddings: got %d vectors for %d texts", len(out.Data), len(texts))
	}
	sort.Slice(out.Data, func(i, j int) bool { return out.Data[i].Index < out.Data[j].Index })
	vecs := make([][]float32, len(texts))
	for i, d := range out.Data {
		if len(d.Embedding) == 0 {
			return nil, fmt.Errorf("embeddings: empty vector")
		}
		vecs[i] = d.Embedding
	}
	return vecs, nil
}
