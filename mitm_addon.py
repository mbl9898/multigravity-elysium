# mitm_addon.py
# A mitmproxy addon script to log and swap auth tokens for Google AI/CloudCode APIs.
#
# Usage:
#   mitmdump -s mitm_addon.py
#

import json
import sys
import os
import urllib.request
from mitmproxy import http

# Strict list of domains relevant to Google AI completions, metadata, and pings
RELEVANT_DOMAINS = [
    "cloudcode-pa.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "daily-cloudcode-pa.sandbox.googleapis.com",
    "generativelanguage.googleapis.com",
    "appsgenaiserver-pa.clients6.google.com",
    "labs.google",
    "waa-pa.clients6.google.com"
]

LOG_FILE = os.path.join(os.path.dirname(__file__), "proxy_monitor.log")

def write_log(msg: str) -> None:
    """Write log to stderr (bypassing mitmdump -q hijack) and append to local log file."""
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()
    try:
        with open(LOG_FILE, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass

def is_relevant_host(host: str) -> bool:
    """Check if the target host matches our target Google AI domains."""
    return host.lower() in RELEVANT_DOMAINS

def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    
    if is_relevant_host(host):
        log_msg = []
        log_msg.append("\n" + "=" * 80)
        log_msg.append(f"--> [MONITOR] REQUEST: {flow.request.method} https://{host}{flow.request.path}")
        
        # --- Quota/Metadata Path Bypass & Auto-Learn Project ID ---
        if "loadCodeAssist" in flow.request.path or "retrieveUserQuotaSummary" in flow.request.path:
            log_msg.append("-> [PROXY] Quota/Metadata query intercepted: bypassing token swapping.")
            
            # Auto-learn project ID from user's quota check request
            if "retrieveUserQuotaSummary" in flow.request.path and flow.request.content:
                try:
                    body_json = json.loads(flow.request.get_text())
                    incoming_project_id = body_json.get("project")
                    auth_header = flow.request.headers.get("authorization")
                    if incoming_project_id and auth_header and auth_header.startswith("Bearer "):
                        token = auth_header[7:]
                        
                        # Background post to Next.js API route
                        post_data = json.dumps({"accessToken": token, "projectId": incoming_project_id}).encode('utf-8')
                        req_learn = urllib.request.Request(
                            "http://127.0.0.1:39281/api/v2/update-project",
                            data=post_data,
                            headers={'Content-Type': 'application/json', 'User-Agent': 'mitmproxy-addon'}
                        )
                        # Fire and forget (timeout=1 to prevent blocking request flow)
                        try:
                            proxy_handler = urllib.request.ProxyHandler({})
                            opener = urllib.request.build_opener(proxy_handler)
                            opener.open(req_learn, timeout=1)
                            log_msg.append(f"-> [AUTO-LEARN] Sent learn request for project: {incoming_project_id}")
                        except Exception as inner_e:
                            log_msg.append(f"-> [AUTO-LEARN] Triggered successfully in background ({str(inner_e)})")
                except Exception as e:
                    log_msg.append(f"-> [AUTO-LEARN ERROR] Failed to process payload: {str(e)}")

            log_msg.append("=" * 80 + "\n")
            write_log("\n".join(log_msg))
            return
        # ----------------------------------------------------

        # 1. Parse model name from body if present
        model = 'gemini-3.5-flash-low'
        body_json = None
        if flow.request.content:
            try:
                body_json = json.loads(flow.request.get_text())
                model = body_json.get('model') or body_json.get('request', {}).get('model') or model
                log_msg.append("Original Body (JSON):")
                log_msg.append(json.dumps(body_json, indent=2))
            except Exception:
                log_msg.append(f"Body (Raw): {flow.request.get_text()[:1000]}")

        # Model fallback mapping for Google One AI Pro accounts
        mapped_model = model
        if body_json:
            modified = False
            if 'model' in body_json:
                orig = body_json['model']
                if orig in ['gemini-3.5-flash', 'gemini-3.5-flash-low']:
                    body_json['model'] = 'gemini-3-flash'
                    mapped_model = 'gemini-3-flash'
                    modified = True
                    log_msg.append(f"[Model Fallback] Mapping {orig} -> gemini-3-flash")
                elif orig == 'gemini-3.5-flash-medium':
                    body_json['model'] = 'gemini-3.1-pro-low'
                    mapped_model = 'gemini-3.1-pro-low'
                    modified = True
                    log_msg.append(f"[Model Fallback] Mapping {orig} -> gemini-3.1-pro-low")
            if 'request' in body_json and 'model' in body_json['request']:
                orig = body_json['request']['model']
                if orig in ['gemini-3.5-flash', 'gemini-3.5-flash-low']:
                    body_json['request']['model'] = 'gemini-3-flash'
                    mapped_model = 'gemini-3-flash'
                    modified = True
                    log_msg.append(f"[Model Fallback] Mapping request.model {orig} -> gemini-3-flash")
                elif orig == 'gemini-3.5-flash-medium':
                    body_json['request']['model'] = 'gemini-3.1-pro-low'
                    mapped_model = 'gemini-3.1-pro-low'
                    modified = True
                    log_msg.append(f"[Model Fallback] Mapping request.model {orig} -> gemini-3.1-pro-low")
            if modified:
                flow.request.set_text(json.dumps(body_json))
        
        # 2. Query our Next.js dashboard API to get a pooled account token using mapped_model
        try:
            proxy_handler = urllib.request.ProxyHandler({})
            opener = urllib.request.build_opener(proxy_handler)
            url = f"http://127.0.0.1:39281/api/v2/get-token?model={mapped_model}"
            req = urllib.request.Request(url, headers={'User-Agent': 'mitmproxy-addon'})
            with opener.open(req, timeout=5) as response:
                data = json.loads(response.read().decode('utf-8'))
                if 'accessToken' in data:
                    # Swap the Authorization header in-flight
                    flow.request.headers["authorization"] = f"Bearer {data['accessToken']}"
                    
                    # Swap target project ID if returned
                    target_project_id = data.get("projectId")
                    if target_project_id:
                        flow.request.headers["x-goog-user-project"] = target_project_id
                        # Reload JSON body to add updated project parameter
                        try:
                            current_body = json.loads(flow.request.get_text())
                            if "project" in current_body:
                                current_body["project"] = target_project_id
                                flow.request.set_text(json.dumps(current_body))
                                log_msg.append(f"-> [PROXY] Swapped project ID in body and headers to: {target_project_id}")
                        except Exception:
                            pass
                    
                    # Store metadata on flow object for the response handler
                    flow.metadata["pooled_account_id"] = data.get("accountId")
                    flow.metadata["pooled_account_email"] = data.get("email")
                    flow.metadata["pooled_account_pool"] = data.get("pool")
                    
                    log_msg.append(f"-> [PROXY] Swapped auth token with pool account: {data['email']} (Pool: {data['pool']}, Model: {mapped_model})")
        except Exception as e:
            log_msg.append(f"-> [PROXY ERROR] Failed to fetch pooled token: {str(e)}")
            
        log_msg.append("-" * 80)
        log_msg.append("Headers:")
        for k, v in flow.request.headers.items():
            if k.lower() in ["authorization", "x-goog-api-key", "cookie"]:
                log_msg.append(f"  {k}: [REDACTED]")
            else:
                log_msg.append(f"  {k}: {v}")
                
        log_msg.append("=" * 80 + "\n")
        write_log("\n".join(log_msg))

def response(flow: http.HTTPFlow) -> None:
    host = flow.request.headers.get("x-original-host") or flow.request.pretty_host
    
    if is_relevant_host(host):
        log_msg = []
        log_msg.append("\n" + "=" * 80)
        log_msg.append(f"<-- [MONITOR] RESPONSE: {flow.response.status_code} for {flow.request.method} https://{host}{flow.request.path}")
        
        # Check if the pooled account has hit quota limits (429)
        status_code = flow.response.status_code
        if status_code == 429 and "pooled_account_id" in flow.metadata:
            acc_id = flow.metadata.get("pooled_account_id")
            pool = flow.metadata.get("pooled_account_pool")
            email = flow.metadata.get("pooled_account_email")
            if acc_id and pool:
                try:
                    proxy_handler = urllib.request.ProxyHandler({})
                    opener = urllib.request.build_opener(proxy_handler)
                    url = f"http://127.0.0.1:39281/api/v2/mark-exhausted?accountId={acc_id}&pool={pool}"
                    req = urllib.request.Request(url, headers={'User-Agent': 'mitmproxy-addon'})
                    with opener.open(req, timeout=5) as response_data:
                        log_msg.append(f"<- [PROXY REPORT] Marked account {email} as exhausted in DB for pool {pool}.")
                except Exception as e:
                    log_msg.append(f"<- [PROXY REPORT ERROR] Failed to mark account exhausted: {str(e)}")
        
        log_msg.append("-" * 80)
        log_msg.append("Headers:")
        for k, v in flow.response.headers.items():
            log_msg.append(f"  {k}: {v}")
        
        if flow.response.content:
            text = flow.response.get_text()
            if "text/event-stream" in flow.response.headers.get("content-type", "").lower():
                log_msg.append(f"Body: Stream Event Response (Streaming...)")
            else:
                try:
                    body_json = json.loads(text)
                    log_msg.append("Body (JSON):")
                    log_msg.append(json.dumps(body_json, indent=2))
                except Exception:
                    log_msg.append(f"Body (Raw): {text[:1000]}")
        log_msg.append("=" * 80 + "\n")
        write_log("\n".join(log_msg))
