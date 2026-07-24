#!/usr/bin/env python3
"""
Sluice demo — an agent spending a user's Filecoin funds, safely.

    pip install requests
    export SLUICE_URL=https://your-sluice.vercel.app
    export SLUICE_API_KEY=sluice_sk_...        # minted in the dashboard
    export SLUICE_PAYEE=0x...                  # who to pay
    python examples/demo.py

No wallet. No private key. No JavaScript runtime. The funds are the account
owner's; Sluice signs as an operator within the limits they granted on-chain.
"""

import base64
import os
import sys
import time

import requests

SLUICE = os.environ.get("SLUICE_URL", "http://localhost:3000").rstrip("/")
API_KEY = os.environ.get("SLUICE_API_KEY")
PAYEE = os.environ.get("SLUICE_PAYEE")

if not API_KEY:
    sys.exit("Set SLUICE_API_KEY — create one in the dashboard after linking a wallet.")
if not PAYEE:
    sys.exit("Set SLUICE_PAYEE to a recipient address (any Calibration address will do).")

AUTH = {"Authorization": f"Bearer {API_KEY}"}


def rule(title):
    print(f"\n\033[1m── {title}\033[0m")


def authorize(payload, idempotency_key=None):
    headers = dict(AUTH)
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    response = requests.post(f"{SLUICE}/api/v1/pay/authorize", json=payload, headers=headers, timeout=300)
    if response.status_code >= 400:
        detail = response.json().get("error", {}).get("message", response.text)
        sys.exit(f"  {response.status_code} {detail}")
    return response.json()["authorization"], response.status_code


def wait(auth_id, timeout=600):
    """Poll until terminal. A held payment waits on a human, so be patient."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        response = requests.get(f"{SLUICE}/api/v1/pay/status/{auth_id}", headers=AUTH, timeout=30)
        response.raise_for_status()
        current = response.json()["authorization"]
        if current["status"] != last:
            print(f"  status: {current['status']}")
            last = current["status"]
        if not current["pending"]:
            return current
        time.sleep(3)
    sys.exit(f"  timed out waiting for {auth_id}")


# --------------------------------------------------------------------------
rule("Gateway")
health = requests.get(f"{SLUICE}/api/v1/health", timeout=30).json()
print(f"  operator  {health['wallet']}")
print(f"  gas       {health['balances']['walletFil']} tFIL")
print("  (this wallet signs; the money comes from your own Filecoin Pay account)")

# --------------------------------------------------------------------------
rule("1. Small payment — under the cap, executes immediately")
small, status = authorize(
    {"kind": "pay", "to": PAYEE, "amount": "0.1"},
    idempotency_key=f"demo-small-{int(time.time())}",
)
print(f"  HTTP {status} · {small['amount']['usdfc']} USDFC · cap {small['capUsdfc']}")
small = wait(small["id"])
print(f"  tx: {small.get('explorerUrl') or 'n/a'}")

# Reuse the rail: creating one costs an extra transaction.
rail_id = (small.get("result") or {}).get("reusableRailId")
if rail_id:
    print(f"  rail {rail_id} — reuse it for further payments to this recipient")

# --------------------------------------------------------------------------
rule("2. Large payment — over the cap, held for the account owner")
big, status = authorize(
    {"kind": "pay", "to": PAYEE, "amount": "12.0", **({"railId": rail_id} if rail_id else {})},
    idempotency_key=f"demo-big-{int(time.time())}",
)
print(f"  HTTP {status} · {big['amount']['usdfc']} USDFC · cap {big['capUsdfc']}")
print(f"  \033[33mNothing signed. Approve it at {SLUICE}/dashboard\033[0m")
big = wait(big["id"])
if big["status"] == "executed":
    print(f"  released · tx: {big.get('explorerUrl')}")
elif big["status"] == "rejected":
    print("  rejected by the account owner — no funds moved")
else:
    print(f"  ended as: {big['status']} ({big.get('error')})")

# --------------------------------------------------------------------------
rule("3. Store a piece, then verify its PDP proof")
payload = base64.b64encode(f"sluice demo {time.time()}".encode()).decode()
stored, _ = authorize({"kind": "store", "dataBase64": payload, "label": "demo"})
stored = wait(stored["id"])

result = stored.get("result") or {}
if stored["status"] == "executed" and result.get("pieceCid"):
    piece_cid = result["pieceCid"]
    print(f"  pieceCid: {piece_cid}")

    # No API key on this one — anyone can check a proof.
    proof = requests.get(f"{SLUICE}/api/v1/verify/{piece_cid}", timeout=60).json()
    print(f"  status:       {proof['status']}")
    print(f"  lastProven:   {proof['dataSetLastProven'] or 'not yet proven'}")
    print(f"  nextProofDue: {proof['dataSetNextProofDue'] or 'unknown'}")
else:
    print(f"  store ended as: {stored['status']} ({stored.get('error')})")

print(f"\n\033[1mDone.\033[0m Full history: {SLUICE}/dashboard\n")
