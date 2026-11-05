package admin

import (
	"errors"
	"net/http"
	"strconv"

	"cammut/internal/clientip"
	"cammut/internal/oauth"
	"cammut/internal/store"
)

// The owner answers an app's connection request here and manages the apps (OAuth clients) and their connections.

func (h *handler) registerOAuth(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/oauth/requests/{id}", h.authed(h.oauthRequest))
	mux.HandleFunc("POST /api/v1/oauth/requests/{id}/approve", h.guard(h.authed(h.oauthApprove)))
	mux.HandleFunc("POST /api/v1/oauth/requests/{id}/deny", h.guard(h.authed(h.oauthDeny)))
	mux.HandleFunc("GET /api/v1/oauth/clients", h.authed(h.oauthClients))
	mux.HandleFunc("POST /api/v1/oauth/clients", h.guard(h.authed(h.oauthClientCreate)))
	mux.HandleFunc("PATCH /api/v1/oauth/clients/{id}", h.guard(h.authed(h.oauthClientPatch)))
	mux.HandleFunc("DELETE /api/v1/oauth/clients/{id}", h.guard(h.authed(h.oauthClientDelete)))
	mux.HandleFunc("DELETE /api/v1/oauth/grants/{id}", h.guard(h.authed(h.oauthGrantDelete)))
}

func oauthWho(r *http.Request, u store.User) oauth.Who {
	return oauth.Who{Actor: "user:" + u.Username, IP: clientip.FromRequest(r)}
}

func (h *handler) oauthFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, oauth.ErrNotFound):
		jsonErr(w, 404, "not found or already answered")
	case errors.Is(err, oauth.ErrBadInput):
		jsonErr(w, 400, err.Error())
	default:
		h.c.Log.Error("oauth", "err", err)
		jsonErr(w, 500, "internal error")
	}
}

func (h *handler) oauthRequest(w http.ResponseWriter, r *http.Request, u store.User) {
	info, err := h.c.OAuth.Request(r.PathValue("id"))
	if err != nil {
		h.oauthFail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"client_name": info.ClientName, "scopes": info.Scopes, "redirect_host": info.RedirectHost})
}

func (h *handler) oauthApprove(w http.ResponseWriter, r *http.Request, u store.User) {
	to, err := h.c.OAuth.Approve(oauthWho(r, u), r.PathValue("id"), u.ID)
	if err != nil {
		h.oauthFail(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"redirect": to})
}

func (h *handler) oauthDeny(w http.ResponseWriter, r *http.Request, u store.User) {
	to, err := h.c.OAuth.Deny(oauthWho(r, u), r.PathValue("id"))
	if err != nil {
		h.oauthFail(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"redirect": to})
}

type oauthGrantView struct {
	ID         int64   `json:"id"`
	CreatedAt  *string `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
}

type oauthClientView struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	RedirectURIs []string         `json:"redirect_uris"`
	Scopes       []string         `json:"scopes"`
	CreatedAt    *string          `json:"created_at"`
	Grants       []oauthGrantView `json:"grants"`
}

func clientView(c oauth.Client) oauthClientView {
	v := oauthClientView{ID: c.ID, Name: c.Name, RedirectURIs: c.RedirectURIs, Scopes: c.Scopes, CreatedAt: ts(c.CreatedAt), Grants: []oauthGrantView{}}
	if v.RedirectURIs == nil {
		v.RedirectURIs = []string{}
	}
	if v.Scopes == nil {
		v.Scopes = []string{}
	}
	for _, g := range c.Grants {
		v.Grants = append(v.Grants, oauthGrantView{ID: g.ID, CreatedAt: ts(g.CreatedAt), LastUsedAt: ts(g.LastUsedAt)})
	}
	return v
}

func (h *handler) oauthClients(w http.ResponseWriter, r *http.Request, u store.User) {
	cs, err := h.c.OAuth.Clients()
	if err != nil {
		h.oauthFail(w, err)
		return
	}
	out := make([]oauthClientView, 0, len(cs))
	for _, c := range cs {
		out = append(out, clientView(c))
	}
	writeJSON(w, 200, out)
}

func (h *handler) oauthClientCreate(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Name         string   `json:"name"`
		RedirectURIs []string `json:"redirect_uris"`
		Scopes       []string `json:"scopes"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	c, secret, err := h.c.OAuth.CreateClient(oauthWho(r, u), in.Name, in.RedirectURIs, in.Scopes)
	if err != nil {
		h.oauthFail(w, err)
		return
	}
	v := clientView(c)
	writeJSON(w, 201, map[string]any{"client": v, "client_id": c.ID, "client_secret": secret})
}

func (h *handler) oauthClientPatch(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		RedirectURIs []string `json:"redirect_uris"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if err := h.c.OAuth.SetRedirects(oauthWho(r, u), r.PathValue("id"), in.RedirectURIs); err != nil {
		h.oauthFail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) oauthClientDelete(w http.ResponseWriter, r *http.Request, u store.User) {
	if err := h.c.OAuth.RevokeClient(oauthWho(r, u), r.PathValue("id")); err != nil {
		h.oauthFail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) oauthGrantDelete(w http.ResponseWriter, r *http.Request, u store.User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonErr(w, 400, "bad id")
		return
	}
	if err := h.c.OAuth.RevokeGrant(oauthWho(r, u), id); err != nil {
		h.oauthFail(w, err)
		return
	}
	w.WriteHeader(204)
}
