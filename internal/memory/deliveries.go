package memory

import (
	"database/sql"
	"errors"
	"time"
)

// Delivery records one thing the server SENT to an agent: the core part of a brief ("core"), the full tier
// ("full"), or one page. Whether the agent read it is unknowable and is not claimed.
type Delivery struct {
	TokenID      int64
	Agent        string
	Session      string
	Project      string
	BriefVersion int
	PageID       string
	At           time.Time
	Via          string // inject | brief | recall
}

func (s *Store) AddDeliveries(ds []Delivery) error {
	if len(ds) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, d := range ds {
		at := d.At
		if at.IsZero() {
			at = s.now()
		}
		if _, err := tx.Exec(`INSERT INTO mem_deliveries(token_id,agent,session_id,project,brief_version,page_id,delivered_at,via) VALUES(?,?,?,?,?,?,?,?)`,
			d.TokenID, d.Agent, d.Session, d.Project, d.BriefVersion, d.PageID, at.Unix(), d.Via); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// LastDelivery returns the newest delivery row of the project.
func (s *Store) LastDelivery(project string) (Delivery, bool, error) {
	var d Delivery
	var at int64
	err := s.db.QueryRow(`SELECT token_id,agent,session_id,project,brief_version,page_id,delivered_at,via FROM mem_deliveries
		WHERE project=? ORDER BY delivered_at DESC, rowid DESC LIMIT 1`, project).
		Scan(&d.TokenID, &d.Agent, &d.Session, &d.Project, &d.BriefVersion, &d.PageID, &at, &d.Via)
	if errors.Is(err, sql.ErrNoRows) {
		return Delivery{}, false, nil
	}
	d.At = time.Unix(at, 0)
	return d, err == nil, err
}

// DeliveredPages lists the distinct page ids sent to one agent session for one brief version.
func (s *Store) DeliveredPages(project, agent, session string, version int) ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT page_id FROM mem_deliveries WHERE project=? AND agent=? AND session_id=? AND brief_version=? ORDER BY page_id`,
		project, agent, session, version)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PruneDeliveries deletes rows older than before (the nightly tick keeps 30 days).
func (s *Store) PruneDeliveries(before time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM mem_deliveries WHERE delivered_at < ?`, before.Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// CountActive counts the project's active, unexpired notes that the brief accounts for (not speculative).
func (s *Store) CountActive(project string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM mem_notes WHERE project=? AND status='active' AND epistemic<>'speculative' AND (expires_at IS NULL OR expires_at>?)`, project, s.now().Unix()).Scan(&n)
	return n, err
}

// Counts returns the number of projects, active notes and stored briefs.
func (s *Store) Counts() (projects, notes, briefs int, err error) {
	if err = s.db.QueryRow(`SELECT count(*) FROM mem_projects`).Scan(&projects); err != nil {
		return
	}
	if err = s.db.QueryRow(`SELECT count(*) FROM mem_notes WHERE status='active' AND (expires_at IS NULL OR expires_at>?)`, s.now().Unix()).Scan(&notes); err != nil {
		return
	}
	err = s.db.QueryRow(`SELECT count(*) FROM mem_briefs`).Scan(&briefs)
	return
}
