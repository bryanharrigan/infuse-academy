# SMOWL proctoring — setup run

Companion to `LTI_SETUP.md`. Everything here assumes the cross-portal LTI
chain already works, because SMOWL wraps it rather than replacing it.

**Order matters in one specific way:** the setup script itself was patched to
accept `SMOWL_*` variables. The old copy on the origin silently *drops* them.
So the push has to land before the script runs. Step 4 is the check.

---

## 0. The vault link — read this first

Smowltech send credentials through a one-time-view vault. **Open it at the
origin machine (`DESKTOP-HGPP7U3`)**, because that is where the values have to
be typed, and a one-time link does not survive being opened twice.

If it has already been opened on the Absorb laptop, get the values across
before they expire — the link will not show them again.

Four values are expected:

| Variable | What it is |
|---|---|
| `SMOWL_ENTITY_NAME` | `USABSORB` (confirmed by support) |
| `SMOWL_ENTITY_KEY`  | Licence key. Travels **inside** the signed token |
| `SMOWL_API_KEY`     | For the results API |
| `SMOWL_JWT_SECRET`  | HS256 signing secret |

**Check whether the vault also contains an `aud` / audience value.** It is the
one field Smowltech's own code samples leave as a placeholder
(`smowl_platform_domain`). If it is absent, ask support before going further —
unset, the tool falls back to the host of `LTI_TOOL_BASE_URL`, which is a
guess, and a wrong audience fails as an opaque token error rather than
anything readable.

---

## 1. Absorb laptop (`absorb-9r0cl44`) — `C:\Projects\infuse-academy`

Edit-and-push only. No admin here, and nothing in this section touches the
live site directly.

```powershell
git diff
```

```powershell
git add app\.server\lti\smowl.ts app\routes\lti.smowl-probe.ts app\routes\lti.play.tsx env.lti.example scripts\lti-setup-origin.ps1 SMOWL_SETUP.md
git commit -m "SMOWL proctoring: match vendor JWT samples, allow SMOWL_* in setup script"
git push
```

Never `git add -A` or `git add .` — name the paths.

---

## 2. Wait ~60 seconds

The origin polls once a minute, then pulls, rebuilds, restarts and
health-checks itself. Nothing to do on the origin to make this happen.

Static assets 404 for 30–60s during the rebuild. That is normal.

---

## 3. Origin machine (`DESKTOP-HGPP7U3`) — confirm the deploy landed

```powershell
Get-Content C:\ProgramData\infuse-deploy\deploy.log -Tail 30
```

Look for `DEPLOY OK`. **Do not continue until you see it** — the patched setup
script only exists on this machine after the deploy, and the old one drops
every `SMOWL_*` line without failing.

---

## 4. Origin machine — write the secrets file

```powershell
notepad "$env:USERPROFILE\smowl-secrets.txt"
```

That resolves to `C:\Users\<you>\smowl-secrets.txt`. Plain `KEY=value`, one per
line, no quotes:

```
SMOWL_ENTITY_NAME=USABSORB
SMOWL_ENTITY_KEY=<vault>
SMOWL_API_KEY=<vault>
SMOWL_JWT_SECRET=<vault>
SMOWL_AUDIENCE=<vault or support>
SMOWL_LANG=en
SMOWL_ACTIVITY_TYPE=course
```

Only the SMOWL lines. The script merges with what is already on the service,
so every existing variable stays put.

`SMOWL_ACTIVITY_TYPE` is free text up to 50 characters — support confirmed
`test` and `quiz` are not the only accepted values. `course` is honest for an
Absorb online course and keeps the SMOWL reports filterable.

If the vault had no audience value, put `SMOWL_AUDIENCE=smowl_platform_domain`
in for now and work it out in step 6b rather than waiting on support.

---

## 5. Origin machine — dry run

Needs an **elevated** PowerShell: the script writes `HKLM` and restarts a
service.

```powershell
cd C:\Infuse
.\scripts\lti-setup-origin.ps1 -EnvFile "$env:USERPROFILE\smowl-secrets.txt"
```

Three things to check in the output:

1. **`7 usable variable(s)`** — not fewer.
2. **No `ignored (not an LTI variable)` line mentioning a `SMOWL_` name.** If
   one appears, the old script is still in place: go back to step 3.
3. `SMOWL_ENTITY_KEY`, `SMOWL_API_KEY` and `SMOWL_JWT_SECRET` show as
   `<n chars>`, never as values. The other four are not secrets and show in
   full — `SMOWL_ENTITY_NAME=USABSORB` is worth eyeballing for typos.

---

## 6. Origin machine — apply

```powershell
.\scripts\lti-setup-origin.ps1 -EnvFile "$env:USERPROFILE\smowl-secrets.txt" -Apply -RemoveEnvFile
```

The script backs up the current environment, merges, reads back to verify,
restarts `Infuse` and health-checks it. `-RemoveEnvFile` deletes the secrets
file afterwards — take it, there is no reason to leave a signing secret in a
profile folder.

To undo: `-Restore <backup path>`, printed by the apply.

---

## 6b. Only if you don't have a confirmed `aud` value

`/lti/smowl-probe` signs a token with whatever audience you name and hands
back the finished SMOWL URL, so every candidate can be tried in one browser
session instead of one deploy each. It needs `LTI_DIAG_KEY`, which is already
set.

```
https://infuse.bryanharrigan.dev/lti/smowl-probe?key=<LTI_DIAG_KEY>
```

The response lists `candidatesToTry`. For each one:

```
https://infuse.bryanharrigan.dev/lti/smowl-probe?key=<LTI_DIAG_KEY>&aud=<candidate>
```

Open the `monitoringUrl` from the response in a new tab.

* **A SMOWL camera-check page** — that audience was accepted. Set
  `SMOWL_AUDIENCE` to it and re-run step 6.
* **A token or signature error** — try the next candidate.

If every candidate fails the same way, the problem is not the audience: check
`SMOWL_ENTITY_KEY` and `SMOWL_JWT_SECRET` for a transcription error first.

**Delete this route once the value is confirmed.** It earns its keep for an
afternoon, not permanently.

---

## 7. Verify

Launch the LTI course from `bharrigan.myabsorb.ca` as usual.

**Expected:** the SMOWL monitoring block (220×300) appears to the left, the
course does **not** render at all, then appears once the iframe posts
`monitoringstatusOK`. A first-time learner gets a registration link.

Then, in mySmowltech → **Product adjustments → Monitoring adjustments**: the
activity should now be listed. That page is empty until a monitoring URL is
actually hit, so an entry appearing there proves the token was accepted —
independently of whether the camera checks then pass.

---

## If it fails

| Symptom | Cause |
|---|---|
| Course plays with no monitoring block | `enabled()` is false — one of `SMOWL_ENTITY_NAME`, `SMOWL_ENTITY_KEY`, `SMOWL_JWT_SECRET` is unset |
| Monitoring iframe shows a token error | `SMOWL_AUDIENCE` first — use step 6b — then `signSmowlToken` in `app/.server/lti/smowl.ts` |
| Activity never appears in Monitoring adjustments | The request never reached SMOWL — check the generated URL in page source |
| Everything blocked, `monitoringstatusNOTOK` | Browser camera/mic permission, not our code |

Both the deploy in step 2 and the apply in step 6 restart the service, which
clears the in-memory launch records. Do not have a launch in flight.

Leave `"Do you want the register to be blocking?"` **off** in mySmowltech →
Product adjustments → Additional settings. On, a learner cannot reach the
activity until a human has verified their ID photo — correct for a real exam,
fatal for a live demo.
