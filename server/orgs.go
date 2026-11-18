package main

import (
	"fmt"
	"net/http"
)

// sees returns a SQL condition limiting rows to users the caller may see, and
// its arguments, numbered from $n. idCol and orgCol name the target user's id
// and org_id columns. Owners see everyone, managers their own org, workers
// themselves. Everyone sees themselves. ?org= narrows an owner's or manager's
// view to one org, and can never widen it.
func sees(r *http.Request, idCol, orgCol string, n int) (string, []any) {
	u := current(r)
	org := ""
	if u.OrgID != nil {
		org = *u.OrgID
	}
	return fmt.Sprintf("(%[1]s=$%[3]d OR ($%[4]d='owner' AND ($%[6]d='' OR %[2]s=$%[6]d)) OR ($%[4]d='manager' AND %[2]s=$%[5]d AND ($%[6]d='' OR %[2]s=$%[6]d)))",
		idCol, orgCol, n, n+1, n+2, n+3), []any{u.ID, u.Role, org, r.URL.Query().Get("org")}
}

// sameOrg reports whether a manager may act on a user in targetOrg. Owners
// may act on any org; managers only on their own, never on unassigned users.
func sameOrg(actor identity, targetOrg *string) bool {
	if actor.Role == "owner" {
		return true
	}
	return actor.Role == "manager" && actor.OrgID != nil && targetOrg != nil && *actor.OrgID == *targetOrg
}

// listOrgs returns the organisations the caller may pick from: all of them
// for an owner, their own for a manager.
func (a *app) listOrgs(w http.ResponseWriter, r *http.Request) {
	if !a.requireAdmin(w, r) {
		return
	}
	u := current(r)
	org := ""
	if u.OrgID != nil {
		org = *u.OrgID
	}
	rows, e := a.db.Query(r.Context(), "SELECT id,name FROM orgs WHERE $1='owner' OR id=$2 ORDER BY name", u.Role, org)
	if e != nil {
		fail(w, 503, "organisations unavailable")
		return
	}
	defer rows.Close()
	type orgRow struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := []orgRow{}
	for rows.Next() {
		var o orgRow
		if e = rows.Scan(&o.ID, &o.Name); e != nil {
			fail(w, 503, "organisations unavailable")
			return
		}
		out = append(out, o)
	}
	if rows.Err() != nil {
		fail(w, 503, "organisations unavailable")
		return
	}
	writeJSON(w, 200, out)
}

// setUserOrg moves a user into an organisation, or unassigns them with null.
// Owner only. Owners themselves stay unassigned because they see every org.
func (a *app) setUserOrg(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid user ID")
		return
	}
	var in struct {
		OrgID *string `json:"org_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	// A laptop stays in its own organisation, so a person who moves out of it is
	// unassigned from that laptop in the same statement.
	var moved int
	e := a.db.QueryRow(r.Context(), `WITH moved AS (
	  UPDATE users SET org_id=$2 WHERE id=$1 AND role<>'owner' AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM orgs WHERE id=$2)) RETURNING id
	), freed AS (
	  UPDATE devices SET user_id=NULL, assigned_at=now() WHERE user_id IN (SELECT id FROM moved) AND org_id IS NOT NULL AND org_id IS DISTINCT FROM $2::text RETURNING 1
	) SELECT (SELECT count(*) FROM moved) + 0*(SELECT count(*) FROM freed)`, id, in.OrgID).Scan(&moved)
	if e != nil {
		fail(w, 503, "assignment unavailable")
		return
	}
	if moved != 1 {
		fail(w, 404, "user or organisation not found")
		return
	}
	ok(w)
}

// setUserRole makes a person a worker or a manager. Owner only. The owner
// role itself is never granted or removed here.
func (a *app) setUserRole(w http.ResponseWriter, r *http.Request) {
	if !a.requireOwner(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		fail(w, 400, "invalid user ID")
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Role != "worker" && in.Role != "manager" {
		fail(w, 400, "role must be worker or manager")
		return
	}
	tag, e := a.db.Exec(r.Context(), "UPDATE users SET role=$2 WHERE id=$1 AND role<>'owner'", id, in.Role)
	if e != nil {
		fail(w, 503, "role change unavailable")
		return
	}
	if tag.RowsAffected() != 1 {
		fail(w, 404, "user not found")
		return
	}
	ok(w)
}
