"""Capture full OTLP/HTTP trace payloads from DSH to disk.

Listens on 127.0.0.1:4331, accepts POST /v1/traces (chunked or content-length),
writes the raw OTLP JSON body to /tmp/otlp_capture/<traceId>.json.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = "/tmp/otlp_capture"
os.makedirs(OUT, exist_ok=True)


def read_body(handler):
    te = (handler.headers.get("transfer-encoding") or "").lower()
    if "chunked" in te:
        chunks = []
        while True:
            line = handler.rfile.readline()
            if not line:
                break
            size = int(line.strip().split(b";")[0], 16)
            if size == 0:
                handler.rfile.readline()
                break
            chunks.append(handler.rfile.read(size))
            handler.rfile.read(2)
        return b"".join(chunks)
    return handler.rfile.read(int(handler.headers.get("content-length") or 0))


class Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        body = read_body(self)
        trace_ids = set()
        try:
            data = json.loads(body)
            for rs in data.get("resourceSpans", []):
                for ss in rs.get("scopeSpans", []):
                    for span in ss.get("spans", []):
                        if span.get("traceId"):
                            trace_ids.add(span["traceId"])
        except Exception as err:
            print("parse error:", err, file=sys.stderr)

        for tid in trace_ids:
            with open(os.path.join(OUT, tid + ".json"), "w") as out:
                json.dump(data, out, indent=2)
            print("captured trace", tid, flush=True)

        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


print("OTLP capture sink on 4331", flush=True)
HTTPServer(("127.0.0.1", 4331), Sink).serve_forever()
