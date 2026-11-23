#!/usr/bin/env python3
"""Local-only OTLP/HTTP trace sink for the false-completion bundle.

Listens on 127.0.0.1:4318 (the OTel default) inside WSL and appends one JSON
line per span to ~/.dsh/otlp-local/traces.ndjson. No remote endpoint, no auth.

The OTel Node OTLP/HTTP exporter sends JSON with chunked transfer encoding.
"""
import gzip
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 4318
OUT_DIR = os.path.expanduser("~/.dsh/otlp-local")
OUT_FILE = os.path.join(OUT_DIR, "traces.ndjson")
os.makedirs(OUT_DIR, exist_ok=True)


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
        body = b"".join(chunks)
    else:
        body = handler.rfile.read(int(handler.headers.get("content-length") or 0))
    if (handler.headers.get("content-encoding") or "").lower() == "gzip":
        body = gzip.decompress(body)
    return body


class Sink(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Connection", "close")
        super().end_headers()

    def do_POST(self):
        body = read_body(self)
        written = 0
        try:
            data = json.loads(body)
            with open(OUT_FILE, "a") as out:
                for rs in data.get("resourceSpans", []):
                    for ss in rs.get("scopeSpans", []):
                        for span in ss.get("spans", []):
                            attrs = {}
                            for a in span.get("attributes", []):
                                v = a.get("value", {})
                                attrs[a["key"]] = next(iter(v.values()), None)
                            out.write(json.dumps({
                                "traceId": span.get("traceId"),
                                "spanId": span.get("spanId"),
                                "name": span.get("name"),
                                "evidenceRef": attrs.get("evidence.ref"),
                                "attributes": attrs,
                            }) + "\n")
                            written += 1
        except Exception as err:  # never fail the producer
            print(f"sink parse error: {err}", file=sys.stderr)
        if written:
            print(f"wrote {written} span(s) to {OUT_FILE}", flush=True)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"local OTLP sink on http://{HOST}:{PORT}/v1/traces -> {OUT_FILE}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Sink).serve_forever()
