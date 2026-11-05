package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// User is the single human admin (the schema allows more). TOTPSecret is a sealed blob the store never opens.
type User struct {
	ID           int64
	Username     string
	PasswordHash string
	TOTPSecret   []byte
	TOTPLastStep int64
	GitHubID     int64
	CreatedAt    time.Time
}

const userCols = `id,username,password_hash,totp_secret,totp_last_step,github_id,created_at`

func scanUser(row interface{ Scan(...any) error }) (User, bool, error) {
	var u User
	var gh sql.NullInt64
	var created int64
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.TOTPSecret, &u.TOTPLastStep, &gh, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, err
	}
	u.GitHubID = gh.Int64
	u.CreatedAt = time.Unix(created, 0)
	return u, true, nil
}

func (s *Store) CreateUser(u User, recoveryMACs []string) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO users(username,password_hash,totp_secret,created_at) VALUES(?,?,?,?)`,
		u.Username, u.PasswordHash, u.TOTPSecret, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	for _, m := range recoveryMACs {
		if _, err := tx.Exec(`INSERT INTO recovery_codes(user_id,code_mac) VALUES(?,?)`, id, m); err != nil {
			return 0, err
		}
	}
	return id, tx.Commit()
}

func (s *Store) UserByName(name string) (User, bool, error) {
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE username=?`, name))
}

func (s *Store) UserByID(id int64) (User, bool, error) {
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE id=?`, id))
}

func (s *Store) UserByGitHubID(gh int64) (User, bool, error) {
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE github_id=?`, gh))
}

func (s *Store) CountUsers() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) SetGitHubID(id, gh int64) error {
	_, err := s.db.Exec(`UPDATE users SET github_id=? WHERE id=?`, gh, id)
	return err
}

// SetPasswordHash replaces the hash and ends every session of the user.
func (s *Store) SetPasswordHash(id int64, hash string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET password_hash=? WHERE id=?`, hash, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ReplaceTOTP swaps the sealed secret and the recovery codes, resets the replay counter and ends every session.
func (s *Store) ReplaceTOTP(id int64, sealed []byte, macs []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET totp_secret=?, totp_last_step=0 WHERE id=?`, sealed, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM recovery_codes WHERE user_id=?`, id); err != nil {
		return err
	}
	for _, m := range macs {
		if _, err := tx.Exec(`INSERT INTO recovery_codes(user_id,code_mac) VALUES(?,?)`, id, m); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

type NewSession struct {
	IDHash    string
	Now       time.Time
	ExpiresAt time.Time
	IP        string
	UAHash    string
}

type SessionInfo struct {
	UserID    int64
	CreatedAt time.Time
	LastSeen  time.Time
	ExpiresAt time.Time
}

// LoginProof is the second factor that was verified: a TOTP step or a recovery-code MAC.
type LoginProof struct {
	Step        int64
	RecoveryMAC string
}

// CompleteLogin atomically spends the proof (a TOTP step strictly newer than the last one, or an unused
// recovery code) and creates the session; false means the proof was already spent or invalid.
func (s *Store) CompleteLogin(userID int64, p LoginProof, ns NewSession) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var res sql.Result
	if p.RecoveryMAC != "" {
		res, err = tx.Exec(`UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_mac=? AND used_at IS NULL`,
			ns.Now.Unix(), userID, p.RecoveryMAC)
	} else {
		res, err = tx.Exec(`UPDATE users SET totp_last_step=? WHERE id=? AND totp_last_step<?`, p.Step, userID, p.Step)
	}
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return false, nil
	}
	if _, err := tx.Exec(`INSERT INTO sessions(id_hash,user_id,created_at,last_seen,expires_at,ip,ua_hash) VALUES(?,?,?,?,?,?,?)`,
		ns.IDHash, userID, ns.Now.Unix(), ns.Now.Unix(), ns.ExpiresAt.Unix(), ns.IP, ns.UAHash); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// CreateSession starts a session without spending a proof; the caller has authenticated the person another way.
func (s *Store) CreateSession(userID int64, ns NewSession) error {
	_, err := s.db.Exec(`INSERT INTO sessions(id_hash,user_id,created_at,last_seen,expires_at,ip,ua_hash) VALUES(?,?,?,?,?,?,?)`,
		ns.IDHash, userID, ns.Now.Unix(), ns.Now.Unix(), ns.ExpiresAt.Unix(), ns.IP, ns.UAHash)
	return err
}

func (s *Store) SessionByHash(hash string) (SessionInfo, bool, error) {
	var si SessionInfo
	var created, seen, exp int64
	err := s.db.QueryRow(`SELECT user_id,created_at,last_seen,expires_at FROM sessions WHERE id_hash=?`, hash).
		Scan(&si.UserID, &created, &seen, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionInfo{}, false, nil
	}
	if err != nil {
		return SessionInfo{}, false, err
	}
	si.CreatedAt, si.LastSeen, si.ExpiresAt = time.Unix(created, 0), time.Unix(seen, 0), time.Unix(exp, 0)
	return si, true, nil
}

func (s *Store) TouchSession(hash string, seen, expires time.Time) error {
	_, err := s.db.Exec(`UPDATE sessions SET last_seen=?, expires_at=? WHERE id_hash=?`, seen.Unix(), expires.Unix(), hash)
	return err
}

func (s *Store) DeleteSession(hash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id_hash=?`, hash)
	return err
}

func (s *Store) PruneSessions(now time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at<=?`, now.Unix())
	if err != nil {
		return 0, err
	}
	s.db.Exec(`DELETE FROM pending_logins WHERE expires_at<=?`, now.Unix())
	s.db.Exec(`DELETE FROM oauth_states WHERE expires_at<=?`, now.Unix())
	return res.RowsAffected()
}

func (s *Store) PutPending(hash string, userID int64, expires time.Time) error {
	_, err := s.db.Exec(`INSERT INTO pending_logins(id_hash,user_id,expires_at) VALUES(?,?,?)`, hash, userID, expires.Unix())
	return err
}

func (s *Store) PendingUser(hash string, now time.Time) (int64, bool, error) {
	var id int64
	err := s.db.QueryRow(`SELECT user_id FROM pending_logins WHERE id_hash=? AND expires_at>?`, hash, now.Unix()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return id, err == nil, err
}

func (s *Store) DeletePending(hash string) error {
	_, err := s.db.Exec(`DELETE FROM pending_logins WHERE id_hash=?`, hash)
	return err
}

func (s *Store) PutOAuthState(hash, verifier string, expires time.Time) error {
	_, err := s.db.Exec(`INSERT INTO oauth_states(state_hash,verifier,expires_at) VALUES(?,?,?)`, hash, verifier, expires.Unix())
	return err
}

// TakeOAuthState returns the PKCE verifier stored for the state and deletes it, so a state works once.
func (s *Store) TakeOAuthState(hash string, now time.Time) (string, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var v string
	var exp int64
	err = tx.QueryRow(`SELECT verifier,expires_at FROM oauth_states WHERE state_hash=?`, hash).Scan(&v, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err := tx.Exec(`DELETE FROM oauth_states WHERE state_hash=?`, hash); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return v, exp > now.Unix(), nil
}

type SecretMeta struct {
	Name      string
	UpdatedAt time.Time
	Purpose   string
	Hosts     []string
	PolicySet bool
}

// PutSecretPolicy creates a secret with its policy. On an existing name only the value changes: a policy is
// replaced only through SetSecretPolicy.
func (s *Store) PutSecretPolicy(name string, nonce, ct []byte, purpose string, hosts []string, now time.Time) error {
	hj, _ := json.Marshal(append([]string{}, hosts...))
	_, err := s.db.Exec(`INSERT INTO secrets(name,nonce,ciphertext,created_at,updated_at,purpose,allowed_hosts,policy_set) VALUES(?,?,?,?,?,?,?,1)
ON CONFLICT(name) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`,
		name, nonce, ct, now.Unix(), now.Unix(), purpose, string(hj))
	return err
}

// SecretPolicy returns the stored policy; ok is false when the secret does not exist.
func (s *Store) SecretPolicy(name string) (purpose string, hosts []string, set bool, ok bool, err error) {
	var hj string
	var ps int
	err = s.db.QueryRow(`SELECT purpose,allowed_hosts,policy_set FROM secrets WHERE name=?`, name).Scan(&purpose, &hj, &ps)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, false, false, nil
	}
	if err != nil {
		return "", nil, false, false, err
	}
	_ = json.Unmarshal([]byte(hj), &hosts)
	return purpose, hosts, ps != 0, true, nil
}

// SetSecretPolicy replaces the policy of an existing secret.
func (s *Store) SetSecretPolicy(name, purpose string, hosts []string) (bool, error) {
	hj, _ := json.Marshal(append([]string{}, hosts...))
	res, err := s.db.Exec(`UPDATE secrets SET purpose=?, allowed_hosts=?, policy_set=1 WHERE name=?`, purpose, string(hj), name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) PutSecret(name string, nonce, ct []byte, now time.Time) error {
	_, err := s.db.Exec(`INSERT INTO secrets(name,nonce,ciphertext,created_at,updated_at) VALUES(?,?,?,?,?)
ON CONFLICT(name) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`,
		name, nonce, ct, now.Unix(), now.Unix())
	return err
}

func (s *Store) GetSecret(name string) (nonce, ct []byte, ok bool, err error) {
	err = s.db.QueryRow(`SELECT nonce,ciphertext FROM secrets WHERE name=?`, name).Scan(&nonce, &ct)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, false, nil
	}
	return nonce, ct, err == nil, err
}

func (s *Store) DeleteSecret(name string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM secrets WHERE name=?`, name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) ListSecretMeta() ([]SecretMeta, error) {
	rows, err := s.db.Query(`SELECT name,updated_at,purpose,allowed_hosts,policy_set FROM secrets ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretMeta
	for rows.Next() {
		var m SecretMeta
		var up int64
		var hj string
		var ps int
		if err := rows.Scan(&m.Name, &up, &m.Purpose, &hj, &ps); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(hj), &m.Hosts)
		m.PolicySet = ps != 0
		m.UpdatedAt = time.Unix(up, 0)
		out = append(out, m)
	}
	return out, rows.Err()
}
