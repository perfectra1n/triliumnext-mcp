#!/usr/bin/env python3
"""Minimal reference MCP client for triliumnext-mcp over the SSE transport.

Uses only the Python standard library. No external dependencies. Works as a
one-shot CLI for calling any tool exposed by the server.

This exists mainly as a workaround for MCP clients that don't load all tools
into the assistant's active context (see issue #6) — you can pipe JSON
arguments via stdin and invoke the tool directly from a shell.

Usage:
    # List all tools
    python3 reference-sse-client.py list

    # Call a tool (arguments from stdin)
    echo '{"parentNoteId":"root","title":"Test","type":"text","content":"hi"}' \
        | python3 reference-sse-client.py call create_note

    # Point at a different server
    TRILIUM_MCP_URL=http://other-host:3100 python3 reference-sse-client.py list

The script opens an SSE connection to /sse, reads the endpoint event,
POSTs JSON-RPC messages to the returned /message?sessionId=... endpoint,
and waits for the matching response to arrive back over SSE.
"""
import os
import sys
import json
import time
import queue
import threading
import urllib.request
import urllib.error

BASE = os.environ.get("TRILIUM_MCP_URL", "http://localhost:3100")


class MCPClient:
    def __init__(self):
        self.endpoint = None
        self.q = queue.Queue()
        self.running = True
        self.req_id = 0
        self.resp = urllib.request.urlopen(
            urllib.request.Request(BASE + "/sse", headers={"Accept": "text/event-stream"}),
            timeout=60,
        )
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        buf = b""
        try:
            while self.running:
                chunk = self.resp.read1(1024) if hasattr(self.resp, "read1") else self.resp.read(1)
                if not chunk:
                    break
                buf += chunk
                while b"\n\n" in buf:
                    event_bytes, buf = buf.split(b"\n\n", 1)
                    self._parse(event_bytes.decode("utf-8", "replace"))
        except Exception as e:
            self.q.put(("err", str(e)))

    def _parse(self, event):
        ev = data = None
        for line in event.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()
        if ev == "endpoint" and data:
            self.endpoint = BASE + data
            self.q.put(("endpoint", data))
        elif ev == "message" and data:
            try:
                self.q.put(("message", json.loads(data)))
            except Exception:
                self.q.put(("raw", data))

    def wait_endpoint(self, timeout=5):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                k, _ = self.q.get(timeout=0.1)
                if k == "endpoint":
                    return True
            except queue.Empty:
                pass
        return False

    def send(self, method, params):
        self.req_id += 1
        rid = self.req_id
        body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
        try:
            with urllib.request.urlopen(
                urllib.request.Request(
                    self.endpoint, data=body,
                    headers={"Content-Type": "application/json"}, method="POST"),
                timeout=30) as r:
                r.read()
        except urllib.error.HTTPError as e:
            return {"error": f"HTTP {e.code}: {e.read().decode()[:500]}"}
        t0 = time.time()
        while time.time() - t0 < 30:
            try:
                k, d = self.q.get(timeout=0.5)
                if k == "message" and isinstance(d, dict) and d.get("id") == rid:
                    return d
            except queue.Empty:
                pass
        return {"error": "timeout"}

    def notify(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params}).encode()
        with urllib.request.urlopen(
            urllib.request.Request(
                self.endpoint, data=body,
                headers={"Content-Type": "application/json"}, method="POST"),
            timeout=10) as r:
            r.read()


def main():
    c = MCPClient()
    if not c.wait_endpoint():
        print("ERROR: no endpoint received from /sse", file=sys.stderr)
        sys.exit(1)

    init = c.send("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "reference-sse-client", "version": "1.0"},
    })
    if "result" not in init:
        print(f"initialize failed: {init}", file=sys.stderr)
        sys.exit(1)
    c.notify("notifications/initialized", {})
    time.sleep(0.2)

    action = sys.argv[1] if len(sys.argv) > 1 else "list"
    if action == "list":
        r = c.send("tools/list", {})
        tools = r.get("result", {}).get("tools", [])
        print(f"{len(tools)} tools available:")
        for t in tools:
            print(f"  {t['name']}")
    elif action == "call":
        if len(sys.argv) < 3:
            print("usage: call <tool_name>  (arguments on stdin as JSON)", file=sys.stderr)
            sys.exit(1)
        args = json.loads(sys.stdin.read())
        r = c.send("tools/call", {"name": sys.argv[2], "arguments": args})
        print(json.dumps(r, indent=2))
    else:
        print(f"unknown action: {action} (use 'list' or 'call')", file=sys.stderr)
        sys.exit(1)

    c.running = False


if __name__ == "__main__":
    main()
