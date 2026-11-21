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
        call("PUT", "/auth/v1/admin/users/" + uid, SR, {"password": password, "email_confirm": True})
        print("reusing existing login:", email, "->", uid)

    for t in ("entries", "closings", "parties"):
        call("DELETE", "/rest/v1/%s?owner=eq.%s" % (t, uid), SR, None, "return=minimal")
    call("DELETE", "/rest/v1/settings?owner=eq.%s" % uid, SR, None, "return=minimal")

    s = dict(data.get("settings") or {})
    s.pop("id", None); s["owner"] = uid
    st, bd = call("POST", "/rest/v1/settings", SR, [s], "return=minimal")
    print("settings:", st, bd[:160])

    parties = [dict(p, owner=uid) for p in data.get("parties", [])]
    st, bd = call("POST", "/rest/v1/parties", SR, parties, "return=minimal")
    print("parties:", st, "count=%d" % len(parties), bd[:160])

    clo = [dict(c, owner=uid) for c in data.get("closings", [])]
    if clo:
        st, bd = call("POST", "/rest/v1/closings", SR, clo, "return=minimal")
        print("closings:", st, "count=%d" % len(clo), bd[:160])

    ent = [dict(e, owner=uid) for e in data.get("entries", [])]
    if ent:
        st, bd = call("POST", "/rest/v1/entries", SR, ent, "return=minimal")
        print("entries:", st, "count=%d" % len(ent), bd[:160])

    biz = (s.get("capital_name") or "thedeveloper")
    call("POST", "/rest/v1/profiles", SR,
         [{"owner": uid, "business_name": biz, "mobile_enabled": True,
           "mobile_until": "2099-12-31T00:00:00+00:00"}],
         "resolution=merge-duplicates,return=minimal")
    call("POST", "/rest/v1/admins", SR, [{"uid": uid}],
         "resolution=merge-duplicates,return=minimal")

    st, bd = call("GET", "/rest/v1/parties?select=count", SR, None, "count=exact")
    print("VERIFY parties in db:", bd[:120])
    print("================================================")
    print(" DONE. Owner books restored.")
    print("   Login username :", username)
    print("   Parties loaded :", len(parties), " Entries:", len(ent))
    print("================================================")

if __name__ == "__main__":
    main()
