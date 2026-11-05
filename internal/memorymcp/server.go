// Package memorymcp is the in-process MCP server behind the `memory` upstream: the memory tools over memory.Service.
// The gateway mounts it with upstream.Manager.SetLocal, so scopes, the lazy tools and the audit log work unchanged.
package memorymcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/memory"
	"cammut/internal/upstream"
	"cammut/internal/version"
)

// Connector returns the connect function for upstream.Manager.SetLocal: every call gets a fresh in-memory session.
func Connector(srv *mcp.Server) func(ctx context.Context) (*mcp.ClientSession, error) {
	return func(ctx context.Context) (*mcp.ClientSession, error) {
		ct, st := mcp.NewInMemoryTransports()
		ss, err := srv.Connect(ctx, st, nil)
		if err != nil {
			return nil, err
		}
		cs, err := mcp.NewClient(&mcp.Implementation{Name: "cammut-memory-client", Version: version.Version}, nil).Connect(ctx, ct, nil)
		if err != nil {
			ss.Close()
			return nil, err
		}
		return cs, nil
	}
}

type handler struct{ svc *memory.Service }

// New builds the server. The caller's identity comes from the _meta the gateway attaches (never from the
// arguments, which are validated with unknown fields refused); a call without it is anonymous and audited here.
func New(svc *memory.Service) *mcp.Server {
	h := &handler{svc: svc}
	srv := mcp.NewServer(&mcp.Implementation{Name: "cammut-memory", Version: version.Version}, nil)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_brief",
		Description: "Project brief: state, open tasks, decisions in force, known errors and fixes, preferences, plus an index of everything else with refs. Complete by construction; tier=full for all detail.",
		InputSchema: schema(`{"project":{"type":"string"},"tier":{"type":"string","enum":["core","full"]},"page":{"type":"string","description":"page id from the page list"},"section":{"type":"string","description":"e.g. open tasks"},"since_version":{"type":"integer","minimum":0}}`),
	}, h.brief)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_recall",
		Description: "Search project notes by meaning and words; answers abstained=below_threshold when nothing relevant exists. refs returns whole notes by the (ref) shown in the brief; pages returns whole pages by id from the page list.",
		InputSchema: schema(`{"query":{"type":"string"},"refs":{"type":"array","items":{"type":"string"}},"pages":{"type":"array","items":{"type":"string"}},"project":{"type":"string"},"kinds":{"type":"array","items":{"type":"string"}},"limit":{"type":"integer","minimum":1,"maximum":25},"include_speculative":{"type":"boolean","description":"also return speculative notes (guesses); off by default"}}`),
	}, h.recall)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_remember",
		Description: "Save one durable note for a project: a decision, finding, codemap, howto, error_fix, task, state or preference. Set supersedes to the id of the note it replaces.",
		InputSchema: schema(`{"project":{"type":"string"},"kind":{"type":"string","enum":["decision","finding","codemap","howto","error_fix","task","state","preference"]},"title":{"type":"string","maxLength":120},"body":{"type":"string","maxLength":1500},"tags":{"type":"array","items":{"type":"string"},"maxItems":12},"importance":{"type":"integer","minimum":1,"maximum":5},"supersedes":{"type":"string"},"key":{"type":"string","maxLength":80,"description":"stable name for a state note, e.g. cammut.deployed; writing the key again replaces the previous note"},"epistemic":{"type":"string","enum":["inferred","speculative"],"description":"inferred (default) = you concluded it; speculative = a guess, kept out of the brief"},"force":{"type":"boolean","description":"store even if an almost identical note exists"}}`, "project", "kind", "title", "body"),
	}, h.remember)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_confirm",
		Description: "Upgrade a speculative note to inferred once you have checked it. Observed (a person saw it) is set from the console, not by agents.",
		InputSchema: schema(`{"id":{"type":"string"},"epistemic":{"type":"string","enum":["inferred"]}}`, "id", "epistemic"),
	}, h.confirm)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_history",
		Description: "Every version of a keyed note (for example cammut.deployed), newest first. Older versions are superseded and never appear in the brief or in recall.",
		InputSchema: schema(`{"project":{"type":"string"},"key":{"type":"string"}}`, "project", "key"),
	}, h.history)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_handoff",
		Description: "Leave a handoff when you stop: what you were doing, open tasks and next steps. The next agent sees it at the top of the brief; it replaces the previous handoff.",
		InputSchema: schema(`{"project":{"type":"string"},"agent":{"type":"string"},"summary":{"type":"string","maxLength":1000},"open_tasks":{"type":"array","items":{"type":"string"}},"next_steps":{"type":"array","items":{"type":"string"}}}`, "project", "summary"),
	}, h.handoff)
	srv.AddTool(&mcp.Tool{
		Name:        "memory_projects",
		Description: "List the projects that have notes, with the number of active notes and the brief version.",
		InputSchema: schema(`{}`),
	}, h.projects)
	return srv
}

func schema(props string, required ...string) json.RawMessage {
	req := ""
	if len(required) > 0 {
		b, _ := json.Marshal(required)
		req = `,"required":` + string(b)
	}
	return json.RawMessage(`{"type":"object","properties":` + props + `,"additionalProperties":false` + req + `}`)
}

// actorOf reads the caller the gateway recorded in _meta.
func actorOf(req *mcp.CallToolRequest) memory.Actor {
	m, _ := req.Params.GetMeta()[upstream.MetaActor].(map[string]any)
	if m == nil {
		return memory.Actor{Agent: "mcp:anonymous"}
	}
	label, _ := m["label"].(string)
	ip, _ := m["ip"].(string)
	id, _ := m["id"].(float64)
	return memory.Actor{Agent: "mcp:" + label, TokenLabel: label, TokenID: int64(id), IP: ip, SkipAudit: true} // the gateway audits this call
}

func parse(req *mcp.CallToolRequest, dst any) error {
	raw := req.Params.Arguments
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func failure(err error) *mcp.CallToolResult {
	msg := "internal error"
	if errors.Is(err, memory.ErrBadInput) {
		msg = strings.TrimPrefix(err.Error(), "bad input: ")
	} else if errors.Is(err, memory.ErrNotFound) {
		msg = err.Error()
	}
	r := text(msg)
	r.IsError = true
	return r
}

func jsonResult(v any) *mcp.CallToolResult {
	b, err := json.Marshal(v)
	if err != nil {
		return failure(err)
	}
	return text(string(b))
}

func (h *handler) brief(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Project      string `json:"project"`
		Tier         string `json:"tier"`
		Page         string `json:"page"`
		Section      string `json:"section"`
		SinceVersion int    `json:"since_version"`
	}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	v, err := h.svc.Brief(ctx, actorOf(req), a.Project, memory.BriefRequest{Tier: a.Tier, Page: a.Page, Section: a.Section, SinceVersion: a.SinceVersion})
	if err != nil {
		return failure(err), nil
	}
	return text(briefText(v)), nil
}

// briefText is what an agent reads: the markdown itself (or a delta), then one line saying what it was sent.
func briefText(v memory.BriefView) string {
	var b strings.Builder
	if v.IsDelta {
		fmt.Fprintf(&b, "Brief update to version %d (apply to the version you hold):\n", v.Version)
		if len(v.Delta) == 0 {
			b.WriteString("no changes\n")
		}
		for _, op := range v.Delta {
			switch op.Op {
			case "add":
				b.WriteString("+ " + op.Line + "\n")
			case "update":
				b.WriteString("~ " + op.Line + "\n")
			default:
				fmt.Fprintf(&b, "- (%s)\n", op.Ref)
			}
		}
	} else {
		b.WriteString(strings.TrimRight(v.Body, "\n") + "\n")
		stale := ""
		if v.Stale {
			stale = ", stale"
		}
		fmt.Fprintf(&b, "\n(version %d, tier %s%s)\n", v.Version, v.Tier, stale)
	}
	if v.Delivered != "" {
		b.WriteString(v.Delivered + "\n")
	}
	return b.String()
}

func (h *handler) recall(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Query   string   `json:"query"`
		Refs    []string `json:"refs"`
		Pages   []string `json:"pages"`
		Project string   `json:"project"`
		Kinds   []string `json:"kinds"`
		Limit   int      `json:"limit"`

		IncludeSpeculative bool `json:"include_speculative"`
	}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	res, err := h.svc.RecallResult(ctx, actorOf(req), memory.RecallQuery{Project: a.Project, Query: a.Query, Refs: a.Refs, Pages: a.Pages, Kinds: a.Kinds, Limit: a.Limit, IncludeSpeculative: a.IncludeSpeculative})
	if err != nil {
		return failure(err), nil
	}
	out := make([]memory.NoteView, 0, len(res.Hits))
	for _, x := range res.Hits {
		sc := x.Score
		out = append(out, memory.ViewOf(x.Note, x.Ref, &sc))
	}
	body := map[string]any{"notes": out}
	if res.Abstained != "" {
		body["abstained"] = res.Abstained
	}
	return jsonResult(body), nil
}

func (h *handler) remember(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Project    string   `json:"project"`
		Kind       string   `json:"kind"`
		Title      string   `json:"title"`
		Body       string   `json:"body"`
		Tags       []string `json:"tags"`
		Importance int      `json:"importance"`
		Supersedes string   `json:"supersedes"`
		Key        string   `json:"key"`
		Epistemic  string   `json:"epistemic"`
		Force      bool     `json:"force"`
	}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	out, err := h.svc.RememberFull(ctx, actorOf(req), memory.Note{Project: a.Project, Kind: a.Kind, Title: a.Title, Body: a.Body, Tags: a.Tags, Importance: a.Importance, Supersedes: a.Supersedes, Key: a.Key, Epistemic: a.Epistemic}, memory.RememberOpts{Force: a.Force})
	if err != nil {
		return failure(err), nil
	}
	return jsonResult(out.Response()), nil
}

func (h *handler) confirm(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		ID        string `json:"id"`
		Epistemic string `json:"epistemic"`
	}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	n, err := h.svc.ConfirmNote(ctx, actorOf(req), a.ID, a.Epistemic)
	if err != nil {
		return failure(err), nil
	}
	return jsonResult(memory.ViewOf(n, "", nil)), nil
}

func (h *handler) history(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Project string `json:"project"`
		Key     string `json:"key"`
	}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	notes, err := h.svc.History(ctx, actorOf(req), a.Project, a.Key)
	if err != nil {
		return failure(err), nil
	}
	out := make([]memory.NoteView, 0, len(notes))
	for _, n := range notes {
		out = append(out, memory.ViewOf(n, "", nil))
	}
	return jsonResult(map[string]any{"notes": out}), nil
}

func (h *handler) handoff(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Project   string   `json:"project"`
		Agent     string   `json:"agent"`
		Summary   string   `json:"summary"`
		OpenTasks []string `json:"open_tasks"`
		NextSteps []string `json:"next_steps"`
	}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	n, err := h.svc.Handoff(ctx, actorOf(req), memory.HandoffIn{Project: a.Project, Agent: a.Agent, Summary: a.Summary, OpenTasks: a.OpenTasks, NextSteps: a.NextSteps})
	if err != nil {
		return failure(err), nil
	}
	return jsonResult(map[string]any{"id": n.ID, "project": n.Project, "title": n.Title}), nil
}

func (h *handler) projects(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct{}
	if err := parse(req, &a); err != nil {
		return failure(fmt.Errorf("%w: %v", memory.ErrBadInput, err)), nil
	}
	ps, err := h.svc.Projects(actorOf(req))
	if err != nil {
		return failure(err), nil
	}
	type row struct {
		Name         string `json:"name"`
		Notes        int    `json:"notes"`
		BriefVersion int    `json:"brief_version"`
	}
	out := make([]row, 0, len(ps))
	for _, p := range ps {
		out = append(out, row{p.Name, p.Notes, p.BriefVersion})
	}
	return jsonResult(map[string]any{"projects": out}), nil
}
