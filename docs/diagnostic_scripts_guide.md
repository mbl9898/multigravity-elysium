# Multigravity Elysium — Diagnostic & Test Scripts Guide

This document describes the purpose, context, and usage instructions for the diagnostic and test scripts maintained in this repository. Use these scripts to troubleshoot account health, verify model routing, and inspect local or remote API responses.

---

## 1. Scripts Directory

| Script Name | Location | Primary Purpose | Run Environment |
| :--- | :--- | :--- | :--- |
| `test_all_models.js` | Project Root (`/`) | Verifies API completions & routing for all models across all pooled accounts | Production / Dev |
| `test_load_code_assist_all.js` | App Data Scratch | Compares `loadCodeAssist` response structures to check project ID provision status | Dev |
| `query_local_status.js` | App Data Scratch | Connects directly to the running local IDE language server status endpoint | Local IDE |
| `find_ls_ports.js` | App Data Scratch | Discovers which port the running local language server is bound to | Local IDE |
| `test_shared_project_id.js` | App Data Scratch | Verifies Google API quota fetching using fallback project IDs | Dev |
| `print_healthy_load_code_assist.js` | App Data Scratch | Prints the full raw JSON structure of a working Google AI Pro account | Dev |

---

## 2. Usage Instructions

### Run Model Routing & Account Health Tests
This script is the main tool to verify that your account credentials (access tokens) are valid and that completions routing works.
* **Why to use**: Run this after adding new accounts, updating proxies, or if you suspect some models are returning routing errors.
* **How to run**:
  ```bash
  node test_all_models.js
  ```
* **Output**: A console matrix displaying the status (`✔ SUCCESS`, `✘ FAILED`, or `429 RESOURCE_EXHAUSTED`) for Gemini, Claude, and GPT models across all accounts in the SQLite database.

---

### Diagnosing Missing Project IDs / Verification Issues
If an account card in the dashboard shows a "Verification Required" error or fails to fetch the project ID, use this script to check the eligibility response directly from Google.
* **Why to use**: Diagnoses if a user has standard-tier enabled, free-tier blocked, or requires validation (phone/location terms acceptance).
* **How to run**:
  ```bash
  node <antigravity-scratch-dir>/test_load_code_assist_all.js
  ```
* **Output**: Lists the eligibility response keys and any `ineligibleTiers` reason codes returned by Google's API for every account.

---

### Inspecting Local IDE Language Server Status
If the dashboard's local sync is not updating, use this script to query the active language server.
1. First, locate the active listening port by running:
   ```bash
    node <antigravity-scratch-dir>/find_ls_ports.js
   ```
2. Update the `port` variable in `query_local_status.js` to match the active local listening port.
3. Run the query:
   ```bash
    node <antigravity-scratch-dir>/query_local_status.js
   ```
* **Output**: Prints the raw JSON output from the local Connect-RPC status endpoint, including active model names, remaining fractions, and reset timestamps.
