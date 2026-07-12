---
name: open-quota-dashboard
description: >
  Opens the Multigravity Elysium Quota Dashboard in the system browser.
  Trigger when the user says anything like: "open dashboard", "open quota",
  "show me my quota", "launch the dashboard", "open the quota dashboard",
  "how is my quota", or "check my API quota".
---

# Open Quota Dashboard

This skill opens the Multigravity Elysium Quota Dashboard in the user's default system browser.

## Steps

1. Run `open-dashboard.sh` from the project repo, OR invoke the `quota` alias if available.
2. The script will:
   - Check if the daemon is already running at `http://localhost:39281`
   - Start it via `launchctl start com.multigravity.elysium` if it is not
   - Open the URL in the system's default browser

## Command to run

```bash
bash ~/Desktop/web-development/mbl9898/antigravity-dashboard/open-dashboard.sh
```

Or, if the `quota` alias is set up (after running `setup-daemon.sh`):

```bash
quota
```

## Notes

- The dashboard runs **locally** at `http://localhost:39281`
- It requires the macOS LaunchAgent `com.multigravity.elysium` to be registered (done by `setup-daemon.sh`)
- If the daemon is not registered, instruct the user to run `bash setup-daemon.sh` from the project root
- Do **not** open the dashboard in an IDE sidecar or embedded browser — always use the system default browser
