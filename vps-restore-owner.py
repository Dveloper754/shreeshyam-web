#!/usr/bin/env python3
# =============================================================================
# Restore ONE owner's books from an app backup JSON into the self-hosted
# Supabase on this VPS. Runs locally on the VPS so the service key never leaves.
#
#   python3 vps-restore-owner.py <username> <password> [/root/owner-backup.json]
#
# - Creates (or re-uses) the login <username>  (email = <username>@books.local)
# - Wipes that owner's rows, then loads parties / entries / closings / settings
# - Grants full access (profiles + admins row)
# The backup JSON (parties, entries, closings, settings) must already be on the
# VPS, e.g. scp'd to /root/owner-backup.json.
# =============================================================================
import sys, json, urllib.request, urllib.error

API = "http://localhost:8000"

def secrets():
    s = {}
    for line in open("/root/ssb-secrets.env"):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1); s[k] = v
    return s

def call(method, path, key, body=None, prefer=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("apikey", key)
    r.add_header("Authorization", "Bearer " + key)
    r.add_header("Content-Type", "application/json")
    if prefer: r.add_header("Prefer", prefer)
    try:
        resp = urllib.request.urlopen(r)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def main():
    if len(sys.argv) < 3:
        print("usage: vps-restore-owner.py <username> <password> [backup.json]")
        sys.exit(1)
    username = sys.argv[1].strip().lower()
    password = sys.argv[2]
    path = sys.argv[3] if len(sys.argv) > 3 else "/root/owner-backup.json"
    email = username if "@" in username else username + "@books.local"

    SR = secrets()["SERVICE_ROLE_KEY"]
    data = json.load(open(path))

    # 1) create or find the login
    st, bd = call("POST", "/auth/v1/admin/users", SR,
                  {"email": email, "password": password, "email_confirm": True})
    uid = None
    if st in (200, 201):
        uid = json.loads(bd)["id"]
        print("created login:", email, "->", uid)
    else:
        print("create returned", st, "- looking up existing user ...")
        st2, bd2 = call("GET", "/auth/v1/admin/users?per_page=500", SR)
        for u in (json.loads(bd2).get("users", []) if st2 == 200 else []):
            if (u.get("email") or "").lower() == email:
                uid = u["id"]
        if not uid:
            print("FAILED to create or find user:", bd[:300]); sys.exit(1)
        # make sure the password is set to what was given
        call("PUT", "/auth/v1/admin/users/" + uid, SR, {"password": password, "email_confirm": True})
        print("reusing existing login:", email, "->", uid)

    # 2) wipe this owner's rows (children first) so re-runs are clean
    for t in ("session_bets", "trading_entries", "match_sessions", "trading_sessions", "entries", "closings", "parties"):
        call("DELETE", "/rest/v1/%s?owner=eq.%s" % (t, uid), SR, None, "return=minimal")
    call("DELETE", "/rest/v1/settings?owner=eq.%s" % uid, SR, None, "return=minimal")

    import uuid as _uuid
    # Give every row a FRESH id and remap foreign keys, so one owner's data can
    # never collide with another's global primary keys (parties.id, entries.id).
    pmap = {}
    parties = []
    for p in data.get("parties", []):
        q = dict(p); old = q.get("id"); new = str(_uuid.uuid4())
        if old is not None: pmap[old] = new
        q["id"] = new; q["owner"] = uid
        parties.append(q)

    # 3) settings (one row)
    s = dict(data.get("settings") or {})
    s.pop("id", None); s["owner"] = uid
    st, bd = call("POST", "/rest/v1/settings", SR, [s], "return=minimal")
    print("settings:", st, bd[:160])
    print("whose data (capital_name):", s.get("capital_name"))

    # 4) parties (fresh ids, owner forced to the new uid)
    st, bd = call("POST", "/rest/v1/parties", SR, parties, "return=minimal")
    print("parties:", st, "count=%d" % len(parties), bd[:200])

    # 5) closings (fresh id, remapped party_id)
    clo = []
    for c in data.get("closings", []):
        q = dict(c); q["owner"] = uid
        if q.get("id") is not None: q["id"] = str(_uuid.uuid4())
        if q.get("party_id") in pmap: q["party_id"] = pmap[q["party_id"]]
        clo.append(q)
    if clo:
        st, bd = call("POST", "/rest/v1/closings", SR, clo, "return=minimal")
        print("closings:", st, "count=%d" % len(clo), bd[:200])

    # 6) entries (fresh id, remapped party_id)
    ent = []
    for e in data.get("entries", []):
        q = dict(e); q["owner"] = uid
        if q.get("id") is not None: q["id"] = str(_uuid.uuid4())
        if q.get("party_id") in pmap: q["party_id"] = pmap[q["party_id"]]
        ent.append(q)
    if ent:
        st, bd = call("POST", "/rest/v1/entries", SR, ent, "return=minimal")
        print("entries:", st, "count=%d" % len(ent), bd[:200])

    # 7) match / session tables (saudas) — present in newer COMPLETE backups;
    # older backups won't have these keys, so they're simply skipped.
    for t in ("trading_sessions", "match_sessions", "trading_entries", "session_bets"):
        rows = [dict(r, owner=uid) for r in data.get(t, [])]
        if rows:
            st, bd = call("POST", "/rest/v1/%s" % t, SR, rows, "return=minimal")
            print("%s:" % t, st, "count=%d" % len(rows), bd[:200])

    # 8) full access: profiles (subscription) + admins (online admin)
    biz = (s.get("capital_name") or "thedeveloper")
    call("POST", "/rest/v1/profiles", SR,
         [{"owner": uid, "business_name": biz, "mobile_enabled": True,
           "mobile_until": "2099-12-31T00:00:00+00:00"}],
         "resolution=merge-duplicates,return=minimal")
    call("POST", "/rest/v1/admins", SR, [{"uid": uid}],
         "resolution=merge-duplicates,return=minimal")

    # 8) verify
    st, bd = call("GET", "/rest/v1/parties?select=count", SR, None, "count=exact")
    print("VERIFY parties in db:", bd[:120])
    print("================================================")
    print(" DONE. Owner books restored.")
    print("   Login username :", username)
    print("   Parties loaded :", len(parties), " Entries:", len(ent))
    print("================================================")

if __name__ == "__main__":
    main()
