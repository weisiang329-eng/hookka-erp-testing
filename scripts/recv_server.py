import os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fabcut_live.json")
PORT = 8802
done = threading.Event()


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/plain"); self.end_headers()
        self.wfile.write(b"pong")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(min(65536, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        with open(OUT, "wb") as f:
            f.write(buf)
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/plain"); self.end_headers()
        self.wfile.write(b"OK %d" % len(buf))
        print("WROTE", len(buf), "bytes ->", OUT, flush=True)
        done.set()

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
t = threading.Thread(target=srv.serve_forever, daemon=True)
t.start()
print("listening on 127.0.0.1:%d" % PORT, flush=True)
done.wait(timeout=1800)
srv.shutdown()
print("done", flush=True)
